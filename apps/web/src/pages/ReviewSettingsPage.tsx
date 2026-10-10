import { useEffect, useMemo, useState } from 'react';
import {
  LEVEL_IDS,
  pileReport,
  SOURCE_LABELS,
  type CardSource,
  type CleanupGroup,
  type Lexicon,
  type NopeChoice,
  type SkillCard,
} from '@anan/core';
import { learnerRepo, learnerService } from '../db/instance.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { markStudyDirty } from '../lib/study-dirty.js';
import { NOPE_LABELS, nopeSnapshot } from '../lib/nope.js';
import { applyCleanup, cleanupPreview, removedWords } from '../lib/review-cleanup.js';
import { updateReviewSettings, useReviewSettings } from '../lib/review-settings.js';
import { SESSION_NAME } from '../lib/labels.js';
import { useLexicon } from '../lib/useLexicon.js';
import { ReadingControls } from '../components/ReadingControls.js';
import { YourProgress } from '../components/YourProgress.js';
import { useAnswerInputMode, type AnswerInputMode } from '../lib/reading.js';
import { readTargetRetention, RETENTION_MAX, RETENTION_MIN, setTargetRetention } from '../lib/retention.js';
import { onStudyDirty } from '../lib/study-dirty.js';
import { useZhTextSize, ZH_TEXT_SIZES } from '../lib/zh-size.js';
import './ReviewSettingsPage.css';

/** Phase 21: the settings every tab shares (one place each): reading, typed answers, memory target. */
function SharedSettings() {
  const [inputMode, setInputMode] = useAnswerInputMode();
  const [zhSize, setZhSize] = useZhTextSize();
  const [retention, setRetention] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => onStudyDirty(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    void readTargetRetention().then(setRetention);
  }, [tick]);
  const modes: Array<{ id: AnswerInputMode; label: string }> = [
    { id: 'characters', label: 'Characters' },
    { id: 'pinyin', label: 'Pinyin' },
    { id: 'zhuyin', label: 'Zhuyin' },
  ];
  return (
    <>
      <section data-testid="settings-reading">
        <h2>Reading</h2>
        <ReadingControls />
        <p className="review-settings-muted">
          Used in every tab: Reader, Chat, Review, Cloze, Listen and word pop-ups. Textbook, Journal and Garden always
          show the reading, in this script.
        </p>
      </section>
      <section data-testid="settings-zh-size">
        <h2>Chinese text size</h2>
        <div role="radiogroup" aria-label="Chinese text size">
          {ZH_TEXT_SIZES.map((z) => (
            <label key={z.id} className="review-settings-radio">
              <input type="radio" name="zh-size" checked={zhSize === z.id} onChange={() => setZhSize(z.id)} />{' '}
              {z.label}
            </label>
          ))}
        </div>
        <p className="review-settings-muted">
          Only the Chinese gets bigger or smaller. Use your browser&apos;s zoom for everything else.{' '}
          <span lang="zh-Hant" className="settings-zh-sample">
            你好，我們一起去喝咖啡吧。
          </span>
        </p>
      </section>
      <section data-testid="settings-input">
        <h2>Typed answers</h2>
        <div role="radiogroup" aria-label="Typed answers">
          {modes.map((m) => (
            <label key={m.id} className="review-settings-radio">
              <input
                type="radio"
                name="answer-input"
                checked={inputMode === m.id}
                onChange={() => setInputMode(m.id)}
              />{' '}
              {m.label}
            </label>
          ))}
        </div>
        <p className="review-settings-muted">The input a typed answer starts with in Cloze, journal practice and Listen.</p>
      </section>
      <section data-testid="settings-retention">
        <h2>Memory target</h2>
        {retention === null ? (
          <p>Loading…</p>
        ) : (
          <label>
            Aim to remember{' '}
            <select
              value={retention.toFixed(2)}
              onChange={(e) => void setTargetRetention(Number(e.target.value)).then(setRetention)}
              data-testid="target-retention"
            >
              {[RETENTION_MIN, 0.88, 0.9, 0.92, RETENTION_MAX].map((r) => (
                <option key={r} value={r.toFixed(2)}>
                  {Math.round(r * 100)}%
                </option>
              ))}
            </select>{' '}
            of reviews
          </label>
        )}
        <p className="review-settings-muted">
          Higher means more reviews. Review scheduling and the garden both use this number.
        </p>
      </section>
    </>
  );
}

/**
 * Phase 20: Settings → Review. The daily cap, where the review pile comes from, bulk clean-up,
 * and the Removed words list (every Nope, with Restore).
 */
export function ReviewSettingsPage() {
  const lexiconState = useLexicon();
  const { level } = useCurrentLevel();
  const settings = useReviewSettings();
  const [cards, setCards] = useState<SkillCard[] | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => {
    markStudyDirty();
    setTick((t) => t + 1);
  };

  useEffect(() => {
    let cancelled = false;
    learnerRepo.allCards().then((c) => !cancelled && setCards(c));
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const lexicon = lexiconState.status === 'ready' ? lexiconState.lexicon : undefined;
  const report = useMemo(
    () => (cards && lexicon ? pileReport(cards, (id) => lexicon.byId(id), level) : undefined),
    [cards, lexicon, level],
  );

  return (
    <div className="review-settings">
      <h1>Settings</h1>
      <YourProgress />
      <SharedSettings />
      <h2 className="review-settings-group">Review</h2>

      <section data-testid="session-settings">
        <h2>Review sessions</h2>
        <p className="review-settings-muted">
          Reviews come in two sessions a day instead of at exact times. The morning session holds every card due
          before the evening opens; the evening session holds every card due before the next morning ends. A
          session you skip rolls into the next one.
        </p>
        <label className="review-settings-row">
          Time zone{' '}
          <select
            value={settings.timeZone}
            onChange={(e) => void updateReviewSettings({ timeZone: e.target.value })}
            data-testid="session-time-zone"
          >
            {timeZones(settings.timeZone).map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <div className="review-settings-row">
          {SESSION_NAME.morning}: opens{' '}
          <input
            type="time"
            value={settings.morningOpens}
            onChange={(e) => e.target.value && void updateReviewSettings({ morningOpens: e.target.value })}
            aria-label="Morning session opens"
            data-testid="morning-opens"
          />{' '}
          ends{' '}
          <input
            type="time"
            value={settings.morningEnds}
            onChange={(e) => e.target.value && void updateReviewSettings({ morningEnds: e.target.value })}
            aria-label="Morning session ends"
            data-testid="morning-ends"
          />
        </div>
        <div className="review-settings-row">
          {SESSION_NAME.evening}: opens{' '}
          <input
            type="time"
            value={settings.eveningOpens}
            onChange={(e) => e.target.value && void updateReviewSettings({ eveningOpens: e.target.value })}
            aria-label="Evening session opens"
            data-testid="evening-opens"
          />{' '}
          ends{' '}
          <input
            type="time"
            value={settings.eveningEnds}
            onChange={(e) => e.target.value && void updateReviewSettings({ eveningEnds: e.target.value })}
            aria-label="Evening session ends"
            data-testid="evening-ends"
          />{' '}
          <span className="review-settings-muted">(the next day if earlier)</span>
        </div>
        <label className="review-settings-row">
          At most{' '}
          <input
            type="number"
            min={10}
            max={500}
            value={settings.capPerSession}
            onChange={(e) => void updateReviewSettings({ capPerSession: Number(e.target.value) })}
            data-testid="session-cap"
          />{' '}
          reviews a session
        </label>
        <p className="review-settings-muted">
          When a session holds more, review shows the most important first (your current lesson and level, then the
          words you're most likely to forget). The rest wait for the next session. New words pause until you catch
          up.
        </p>
      </section>

      {!report ? (
        <p>Loading…</p>
      ) : (
        <>
          <PileSummary report={report} />
          <Cleanup report={report} onDone={refresh} />
          <Removed cards={cards!} lexicon={lexicon!} onDone={refresh} />
        </>
      )}
    </div>
  );
}

function PileSummary({ report }: { report: ReturnType<typeof pileReport> }) {
  const sources = Object.entries(report.bySource).sort((a, b) => b[1] - a[1]) as Array<[CardSource, number]>;
  const levels = [...LEVEL_IDS, 'textbook', 'custom', 'none'] as const;
  return (
    <section data-testid="pile-summary">
      <h2>Where your review pile comes from</h2>
      <ul>
        {sources.map(([s, n]) => (
          <li key={s}>
            {n} from {SOURCE_LABELS[s]}
          </li>
        ))}
      </ul>
      <p>
        {report.aboveLevel} above your level · {report.notInAnyList} not in any list ·{' '}
        {levels
          .filter((l) => report.byLevel[l])
          .map((l) => `${l === 'none' ? 'no list' : l}: ${report.byLevel[l]}`)
          .join(' · ')}
      </p>
      {report.busiestDays.length > 0 && (
        <p className="review-settings-muted">
          Busiest days: {report.busiestDays.slice(0, 3).map((d) => `${d.day} (${d.count})`).join(', ')}
        </p>
      )}
    </section>
  );
}

function Cleanup({ report, onDone }: { report: ReturnType<typeof pileReport>; onDone: () => void }) {
  const groups: Array<{ label: string; group: CleanupGroup }> = [
    { label: 'Everything above your level', group: { kind: 'above_level' } },
    { label: 'Everything not in any list', group: { kind: 'no_list' } },
    ...(Object.keys(report.bySource) as CardSource[]).map((source) => ({
      label: `Everything from ${SOURCE_LABELS[source]}`,
      group: { kind: 'source' as const, source },
    })),
  ];
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ count: number; undo: () => Promise<void> } | null>(null);
  const preview = picked !== null ? cleanupPreview(report, groups[picked]!.group) : undefined;

  return (
    <section data-testid="cleanup">
      <h2>Clean up my review pile</h2>
      <p className="review-settings-muted">Moves a whole group to “Not now”. Everything can be restored below.</p>
      <ul className="review-settings-groups">
        {groups.map((g, i) => {
          const n = cleanupPreview(report, g.group).ids.length;
          return (
            <li key={g.label}>
              <button disabled={n === 0 || busy} onClick={() => setPicked(i)} aria-pressed={picked === i}>
                {g.label} ({n})
              </button>
            </li>
          );
        })}
      </ul>
      {preview && (
        <div className="review-settings-preview" data-testid="cleanup-preview">
          <p>
            This removes <strong>{preview.ids.length}</strong> words from review, e.g.{' '}
            <span lang="zh-Hant">{preview.sample.join('、')}</span>
            {preview.ids.length > preview.sample.length ? '…' : ''}
          </p>
          <button
            disabled={busy}
            data-testid="cleanup-apply"
            onClick={async () => {
              setBusy(true);
              const snoozedWhen = await nopeSnapshot();
              const done = await applyCleanup(learnerService, preview.ids, { snoozedWhen });
              setLast(done);
              setPicked(null);
              setBusy(false);
              onDone();
            }}
          >
            Move {preview.ids.length} to Not now
          </button>{' '}
          <button onClick={() => setPicked(null)}>Cancel</button>
        </div>
      )}
      {last && (
        <p role="status">
          Removed {last.count} words.{' '}
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await last.undo();
              setLast(null);
              setBusy(false);
              onDone();
            }}
          >
            Undo
          </button>
        </p>
      )}
    </section>
  );
}

function Removed({
  cards,
  lexicon,
  onDone,
}: {
  cards: SkillCard[];
  lexicon: Lexicon;
  onDone: () => void;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<NopeChoice | 'all'>('all');
  const rows = removedWords(cards)
    .map((r) => ({ ...r, word: r.item.kind === 'word' ? lexicon.byId(r.item.id) : undefined }))
    .filter((r) => filter === 'all' || r.choice === filter)
    .filter((r) => !q || (r.word?.headword ?? r.item.id).includes(q) || (r.word?.glossEn ?? '').toLowerCase().includes(q.toLowerCase()));
  return (
    <section data-testid="removed-words">
      <h2>Removed words</h2>
      <div className="review-settings-filters">
        <input type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search removed words" />
        <select value={filter} onChange={(e) => setFilter(e.target.value as NopeChoice | 'all')} aria-label="Filter">
          <option value="all">All</option>
          {(Object.keys(NOPE_LABELS) as NopeChoice[]).map((c) => (
            <option key={c} value={c}>
              {NOPE_LABELS[c]}
            </option>
          ))}
        </select>
      </div>
      {rows.length === 0 ? (
        <p className="review-settings-muted">Nothing removed.</p>
      ) : (
        <ul className="review-settings-removed">
          {rows.slice(0, 300).map((r) => (
            <li key={`${r.item.kind}:${r.item.id}`}>
              <span lang="zh-Hant">{r.word?.headword ?? r.item.id}</span>{' '}
              <span className="review-settings-muted">
                {r.word?.glossEn} · {NOPE_LABELS[r.choice]}
              </span>{' '}
              <button
                onClick={async () => {
                  await learnerService.restore(r.item);
                  onDone();
                }}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 300 && <p className="review-settings-muted">Showing 300 of {rows.length}; search to narrow.</p>}
    </section>
  );
}

/** Time zones to offer: every zone the browser knows, or a short list (the chosen one always included). */
function timeZones(current: string): string[] {
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Europe/London',
    'Asia/Taipei',
  ];
  return all.includes(current) ? all : [current, ...all];
}
