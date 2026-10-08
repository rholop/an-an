import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildErrorCloze,
  CLOZE_REPORT_REASONS,
  checkErrorItem,
  patchExerciseSentence,
  verifySentenceText,
  type ErrorItem,
  type SourceReport,
} from '@anan/core';
import { db } from '../db/instance.js';
import {
  alsoInOtherProfiles,
  deleteJournalItem,
  deleteSource,
  loadSourceReports,
  restoreJournalItem,
  restoreSource,
} from '../lib/cloze-reports.js';
import { allowedLatinNames } from '../lib/journal-cloze-check.js';
import { withdrawGlossReport } from '../lib/gloss-reports.js';
import { useAudioState } from '../lib/audio.js';
import type { GlossReportRow } from '../db/schema.js';
import { getProtectedTerms } from '../lib/journal-protected.js';
import { FetchTutorLLM } from '../lib/tutor-llm.js';
import { useLexicon } from '../lib/useLexicon.js';

const reasonLabel = (id: string) => CLOZE_REPORT_REASONS.find((r) => r.id === id)?.label ?? id;

interface Row {
  key: string;
  zh: string;
  where: string;
  why: string;
  note?: string;
  item?: ErrorItem;
  source?: SourceReport;
}

const fmt = (d: Date) => d.toLocaleDateString();

/** Phase 16 Part D: everything reported or blocked, with Fix it / It was
 * fine / Delete, and a plain-text export for prompt fixes. */
export function ReportedPage() {
  const lexiconState = useLexicon();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const [items, sources, entries] = await Promise.all([
      db.errorItems.filter((i) => i.status === 'reported' || i.status === 'blocked').toArray(),
      loadSourceReports(db),
      db.journalEntries.toArray(),
    ]);
    const entryDate = new Map(entries.map((e) => [e.id, e.createdAt]));
    const out: Row[] = [];
    for (const it of items) {
      const date = entryDate.get(it.journalEntryId);
      out.push({
        key: `item:${it.id}`,
        zh: it.corrected,
        where: `journal entry${date ? ` of ${fmt(date)}` : ''}`,
        why:
          it.status === 'reported'
            ? reasonLabel(it.report?.reason ?? 'other')
            : `Held back by a check: ${it.blockedReason ?? 'failed the check'}`,
        note: it.report?.note,
        item: it,
      });
    }
    for (const s of sources.filter((x) => x.state === 'reported')) {
      out.push({
        key: `src:${s.zh}`,
        zh: s.zh,
        where: s.sourceLabel || s.sourceKind,
        why: reasonLabel(s.reason),
        note: s.note,
        source: s,
      });
    }
    setRows(out);
    // Phase 21: one Reported page for every "⚑ Something's wrong".
    setDefinitions((await db.glossReports.toArray()).filter((r) => !r.withdrawnAt));
    const reviews = await db.journalReviews.toArray();
    setCorrections(
      reviews.flatMap((r) =>
        r.flagged.flatMap((i) => {
          const issue = r.issues[i];
          return issue ? [{ key: `${r.entryId}:${i}`, correction: issue.correction, explanation: issue.explanationEn, date: entryDate.get(r.entryId) }] : [];
        }),
      ),
    );
  }, []);
  const [definitions, setDefinitions] = useState<GlossReportRow[]>([]);
  const [corrections, setCorrections] = useState<
    Array<{ key: string; correction: string; explanation: string; date?: Date }>
  >([]);
  const audio = useAudioState();
  const flaggedAudio = Object.entries(audio.marks).filter(([, m]) => m.status === 'flagged');

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } finally {
      setBusy(null);
    }
  };

  const text = useMemo(
    () =>
      (rows ?? [])
        .map(
          (r) =>
            `Sentence: ${r.zh}\nSource: ${r.where}\nReason: ${r.why}${r.note ? `\nNote: ${r.note}` : ''}`,
        )
        .join('\n\n'),
    [rows],
  );

  async function exportJson() {
    const data = {
      journalEntries: await db.journalEntries.toArray(),
      journalReviews: await db.journalReviews.toArray(),
      errorItems: await db.errorItems.toArray(),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'journal-and-error-bank.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!rows) return <p>Loading…</p>;
  return (
    <div className="reported-page">
      <h1>Reported</h1>
      <h2>Sentences</h2>
      {rows.length === 0 ? (
        <p>No sentences reported or held back.</p>
      ) : (
        <>
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(text)
                .then(() => setMessage('Copied.'))
                .catch(() => setMessage('Could not copy.'))
            }
          >
            Copy all as text
          </button>
          {message && <span role="status"> {message}</span>}
          <ul className="reported-list">
            {rows.map((r) => (
              <li key={r.key}>
                <p lang="zh-Hant-TW" className="reported-sentence">
                  {r.zh}
                </p>
                <p>
                  <small>
                    {r.where} — {r.why}
                    {r.note ? ` — “${r.note}”` : ''}
                  </small>
                </p>
                {r.item &&
                  r.item.version === 2 &&
                  (r.item.exercise?.kind === 'cloze' || r.item.exercise?.kind === 'choice') &&
                  lexiconState.status === 'ready' && (
                  <FixIt
                    item={r.item}
                    busy={busy === r.key}
                    onSave={(next) => run(r.key, () => fixItem(r.item!, next, lexiconState.lexicon))}
                  />
                )}
                {r.item && r.item.version !== 2 && (
                  <button
                    disabled={busy === r.key}
                    onClick={() =>
                      void run(r.key, () =>
                        db.errorItems.put({ ...r.item!, status: 'pending_rebuild', blockedReason: undefined }).then(() => undefined),
                      )
                    }
                  >
                    Try rebuilding again
                  </button>
                )}
                {!(r.item && r.item.version !== 2) && (
                <button
                  disabled={busy === r.key}
                  onClick={() =>
                    void run(r.key, async () => {
                      if (r.item) await restoreJournalItem(db, r.item);
                      else if (r.source) {
                        await restoreSource(db, r.source.zh);
                        await alsoInOtherProfiles(r.source.sourceKind, r.source.profileId, (o) =>
                          restoreSource(o, r.source!.zh),
                        );
                      }
                    })
                  }
                >
                  It was fine
                </button>
                )}
                <button
                  disabled={busy === r.key}
                  onClick={() =>
                    void run(r.key, async () => {
                      if (r.item) await deleteJournalItem(db, r.item);
                      else if (r.source) {
                        await deleteSource(db, r.source.zh);
                        await alsoInOtherProfiles(r.source.sourceKind, r.source.profileId, (o) =>
                          deleteSource(o, r.source!.zh),
                        );
                      }
                    })
                  }
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>Definitions</h2>
      {definitions.length === 0 ? (
        <p>No definitions reported.</p>
      ) : (
        <ul className="reported-list" data-testid="reported-definitions">
          {definitions.map((d) => (
            <li key={d.id}>
              <p lang="zh-Hant-TW" className="reported-sentence">
                {d.headword} ({d.pinyin}): {d.shownGloss}
              </p>
              <p>
                <small lang="zh-Hant-TW">{d.contextSentence}</small>
              </p>
              <button onClick={() => void withdrawGlossReport(db, d.id!).then(load)}>It was fine</button>
            </li>
          ))}
        </ul>
      )}
      <h2>Audio</h2>
      {flaggedAudio.length === 0 ? (
        <p>No clips reported.</p>
      ) : (
        <ul className="reported-list" data-testid="reported-audio">
          {flaggedAudio.map(([key, m]) => (
            <li key={key}>
              <p lang="zh-Hant-TW" className="reported-sentence">
                {m.text}
              </p>
              <p>
                <small>
                  {m.kind} clip — sounds wrong ({new Date(m.at).toLocaleDateString()})
                </small>
              </p>
            </li>
          ))}
        </ul>
      )}
      <h2>Corrections</h2>
      {corrections.length === 0 ? (
        <p>No journal corrections reported.</p>
      ) : (
        <ul className="reported-list" data-testid="reported-corrections">
          {corrections.map((c) => (
            <li key={c.key}>
              <p lang="zh-Hant-TW" className="reported-sentence">
                {c.correction}
              </p>
              <p>
                <small>
                  {c.date ? `journal entry of ${fmt(c.date)} — ` : ''}
                  {c.explanation} (not practised)
                </small>
              </p>
            </li>
          ))}
        </ul>
      )}
      {import.meta.env.DEV && (
        <p>
          <button onClick={() => void exportJson()}>Export journal + error bank as JSON</button>
        </p>
      )}
    </div>
  );
}

/** Fix it (journal items only): edit the corrected sentence; it goes through
 * the Part B checks before the item comes back. */
function FixIt({
  item,
  busy,
  onSave,
}: {
  item: ErrorItem;
  busy: boolean;
  onSave: (corrected: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(item.corrected);
  const [error, setError] = useState('');
  if (!open)
    return (
      <button disabled={busy} onClick={() => setOpen(true)}>
        Fix it
      </button>
    );
  return (
    <div className="reported-fix">
      <p>
        <small>
          You wrote: <span lang="zh-Hant-TW">{item.original}</span>
          {item.pattern ? ` — ${item.pattern}` : ''}
        </small>
      </p>
      <label>
        Corrected sentence (must still contain “{buildErrorCloze(item).answer}”)
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          lang="zh-Hant-TW"
          style={{ width: '100%', fontSize: 16 }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button
        disabled={busy}
        onClick={() =>
          void onSave(text.trim()).then(
            () => setOpen(false),
            (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
          )
        }
      >
        Save and check
      </button>
      <button onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

async function fixItem(
  item: ErrorItem,
  corrected: string,
  lexicon: import('@anan/core').Lexicon,
): Promise<void> {
  const answer = buildErrorCloze(item).answer;
  const patched = patchExerciseSentence(item, corrected);
  if (!patched) throw new Error(`The sentence must contain “${answer}” exactly once.`);
  const llm = new FetchTutorLLM();
  const protectedTerms = await getProtectedTerms(db);
  // the edit goes through Part B before the item comes back: the rules and an
  // independent check of the whole sentence, then the usual blank rules
  const sentence = await verifySentenceText({ lexicon, llm, protectedTerms }, corrected, { en: item.en });
  if (!sentence.ok) throw new Error(sentence.problem || 'Failed the check.');
  const candidate: ErrorItem = {
    ...patched,
    status: 'pending_check',
    report: undefined,
    blockedReason: undefined,
  };
  const checked = await checkErrorItem(candidate, {
    lexicon,
    allowedNames: await allowedLatinNames(db),
  });
  if (checked.status === 'blocked') throw new Error(checked.blockedReason ?? 'Failed the check.');
  await db.errorItems.put({ ...checked, status: 'active' });
}
