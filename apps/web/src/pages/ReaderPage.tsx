import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TouchEvent } from 'react';
import {
  checkTaiwanness,
  classScope,
  lessonIndex,
  coverage,
  isReaderFocus,
  levelIndex,
  LEVEL_IDS,
  READER_FOCUSES,
  type Level,
  type Lexicon,
  type ReaderFocus,
} from '@anan/core';
import {
  AnnotatedText,
  type AnnotatedToken,
  type AnnotationMode,
  type AnnotationScript,
} from '../components/AnnotatedText.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import { db, learnerService } from '../db/instance.js';
import { getSiteCode } from '../lib/api.js';
import { defineUnlisted, reportGloss, type AiDefinition } from '../lib/gloss-reports.js';
import { FakeTutorLLM } from '../lib/fake-tutor-llm.js';
import { FetchTutorLLM } from '../lib/tutor-llm.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { annotate } from '../lib/annotate.js';
import { ReaderService, type NextSentenceResult } from '../lib/reader-service.js';
import { useLexicon, type LexiconLoadState } from '../lib/useLexicon.js';
import { useScenarios } from '../lib/useScenarios.js';
import { useSentenceBank } from '../lib/useSentenceBank.js';
import { useMyClass } from '../lib/my-class.js';
import { getStudyBooks, getStudyFocusNow, useStudyFocus } from '../lib/study.js';
import { useTextbookSentences } from '../lib/textbook-data.js';
import { useSetting } from '../lib/useSetting.js';

const SAMPLE = '我們搭捷運去便利商店，路上還遇到陳雅婷。他還沒還我錢，這件事情我做不了。';

const MODES: AnnotationMode[] = ['always', 'hover', 'off', 'tone-only'];
const SCRIPTS: AnnotationScript[] = ['pinyin', 'zhuyin', 'both'];

const LEVEL_ORDER: readonly Level[] = LEVEL_IDS;

/** Phase 9 §2: the last 20 sentences stay reachable with Back. */
const HISTORY_LIMIT = 20;
const SWIPE_MIN_PX = 60;

const FOCUS_LABELS: Record<ReaderFocus, string> = {
  mixed: 'Mixed',
  review: 'Review',
  new: 'New words',
  lesson: 'Lesson',
};

/** One thing shown in the reader. `pick` entries come from the New sentence
 * button; `sample` is the text the page opens with; `paste` is the learner's own text. */
interface Entry {
  key: string;
  kind: 'sample' | 'pick' | 'paste';
  /** Sentence id (picks only) — what shown-history and evidence refer to. */
  id?: string;
  text: string;
  en?: string;
  reason?: string;
  sourceLabel?: string;
  /** False = "Couldn't find a perfect match". */
  exact: boolean;
  /** chat_read_no_lookup already recorded when the learner moved on. */
  left: boolean;
  englishShown: boolean;
  /** "Show English" already counted as a weak lookup. */
  englishRecorded: boolean;
}

interface Nav {
  entries: Entry[];
  pos: number;
}

let entryCounter = 0;
const newKey = () => `e${++entryCounter}`;

const SAMPLE_ENTRY = (): Entry => ({
  key: newKey(),
  kind: 'sample',
  text: SAMPLE,
  reason: 'Sample text — press New sentence for one at your level',
  exact: true,
  left: true,
  englishShown: false,
  englishRecorded: false,
});

export function ReaderPage() {
  const lexiconState = useLexicon();
  if (lexiconState.status === 'loading') return <p>Loading lexicon…</p>;
  if (lexiconState.status === 'error') {
    return (
      <p>
        Failed to load lexicon: {lexiconState.error}. Run <code>pnpm pipeline:build</code> then{' '}
        <code>pnpm --filter @anan/web sync:lexicon</code>.
      </p>
    );
  }
  return <ReaderView lexiconState={lexiconState} />;
}

function ReaderView({
  lexiconState,
}: {
  lexiconState: Extract<LexiconLoadState, { status: 'ready' }>;
}) {
  const lexicon: Lexicon = lexiconState.lexicon;
  const { level: currentLevel } = useCurrentLevel();
  // Phase 8: display settings are per profile (stored in the profile's database).
  const [mode, setMode] = useSetting<AnnotationMode>('readerMode', 'always');
  const [script, setScript] = useSetting<AnnotationScript>('readerScript', 'pinyin');
  const [storedFocus, setFocus] = useSetting<ReaderFocus>('readerFocus', 'lesson');
  const { focus: studyFocus } = useStudyFocus();
  // Phase 14: with the study order on, "Lesson" is the default and always available.
  const studyOn = Boolean(studyFocus?.enabled && studyFocus.activeStep);
  const myClass = useMyClass();
  // "Lesson" only exists while My class is on; otherwise a stored 'lesson' falls back to Mixed.
  const focus: ReaderFocus =
    isReaderFocus(storedFocus) && (storedFocus !== 'lesson' || myClass.enabled || studyOn) ? storedFocus : 'mixed';
  const textbookSentences = useTextbookSentences(true);

  const [lookupLog, setLookupLog] = useState<string[]>([]);
  const [knownSet, setKnownSet] = useState<Set<string>>(new Set());
  const [nav, setNavState] = useState<Nav>(() => ({ entries: [SAMPLE_ENTRY()], pos: 0 }));
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [useFake, setUseFake] = useState(false);

  // Latest values for handlers that outlive a render (keyboard, async work).
  const navRef = useRef(nav);
  const busyRef = useRef(false);
  const lookedUp = useRef(new Map<string, Set<string>>());
  const prefetch = useRef<{ key: string; promise: Promise<NextSentenceResult | null> } | null>(null);
  const setNav = useCallback((next: Nav) => {
    navRef.current = next;
    setNavState(next);
  }, []);

  useEffect(() => {
    learnerService.knownSet('review').then(setKnownSet);
  }, []);

  const bankLevels = useMemo(
    () => LEVEL_IDS.filter((l) => levelIndex(l) <= levelIndex(currentLevel)),
    [currentLevel],
  );
  const bank = useSentenceBank(bankLevels);
  const scenarios = useScenarios();
  const llm = useMemo(() => (useFake ? new FakeTutorLLM() : new FetchTutorLLM()), [useFake]);
  const reader = useMemo(
    () =>
      new ReaderService({
        db,
        learnerService,
        lexicon,
        llm,
        staticBank: bank.status === 'ready' ? bank.sentences : [],
        classScope: classScope(myClass),
        studyFocus: getStudyFocusNow,
        lessonIndex: lessonIndex(getStudyBooks()),
        ...(textbookSentences.status === 'ready' ? { textbookSentences: textbookSentences.sentences } : {}),
        lesson:
          myClass.enabled && textbookSentences.status === 'ready'
            ? { bookId: myClass.textbookId, n: myClass.currentLesson, sentences: textbookSentences.sentences }
            : undefined,
        scenarios: scenarios.status === 'ready' ? scenarios.scenarios : [],
        // Live generation needs the household code (phase 8); dev has no gate.
        canGenerate: () => useFake || import.meta.env.DEV || Boolean(getSiteCode()),
      }),
    [lexicon, llm, bank, scenarios, useFake, myClass, textbookSentences],
  );

  const current = nav.entries[nav.pos]!;
  const text = current.text;

  const annotated = useMemo(
    () => annotate(text, lexicon, undefined, { textbook: current.sourceLabel?.startsWith('來學華語') }),
    [text, lexicon, current.sourceLabel],
  );
  const taiwanness = useMemo(() => checkTaiwanness(text), [text]);
  const cov = useMemo(
    () =>
      coverage(
        annotated.map((a) => a.token),
        lexicon,
        knownSet,
      ),
    [annotated, lexicon, knownSet],
  );

  const wordIdsOf = useCallback(
    (entryText: string): string[] =>
      annotate(entryText, lexicon).flatMap((a) => (a.wordId ? [a.wordId] : [])),
    [lexicon],
  );
  const lookedUpFor = (key: string): Set<string> => {
    let set = lookedUp.current.get(key);
    if (!set) lookedUp.current.set(key, (set = new Set()));
    return set;
  };

  const patchEntry = useCallback(
    (key: string, patch: Partial<Entry>) => {
      const cur = navRef.current;
      setNav({ ...cur, entries: cur.entries.map((e) => (e.key === key ? { ...e, ...patch } : e)) });
    },
    [setNav],
  );

  const push = useCallback(
    (entry: Entry) => {
      const cur = navRef.current;
      const entries = [...cur.entries, entry].slice(-HISTORY_LIMIT);
      for (const key of lookedUp.current.keys()) {
        if (!entries.some((e) => e.key === key)) lookedUp.current.delete(key);
      }
      setNav({ entries, pos: entries.length - 1 });
    },
    [setNav],
  );

  const sessionIds = (): Set<string> =>
    new Set(navRef.current.entries.flatMap((e) => (e.id ? [e.id] : [])));

  /** Quietly prepare the next sentence so the next press is instant. */
  const startPrefetch = useCallback(
    (ids: Set<string>) => {
      prefetch.current = {
        key: `${currentLevel}|${focus}`,
        promise: reader.next({ focus, level: currentLevel, sessionIds: ids }).catch(() => null),
      };
    },
    [reader, focus, currentLevel],
  );

  async function pressNew() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const leaving = navRef.current.entries[navRef.current.pos];
      // Moving on without looking up a due/learning word = read without help.
      if (leaving?.kind === 'pick' && leaving.id && !leaving.left) {
        patchEntry(leaving.key, { left: true });
        await reader
          .recordNoLookup(wordIdsOf(leaving.text), lookedUpFor(leaving.key), leaving.id)
          .catch(() => 0);
      }

      const ids = sessionIds();
      const key = `${currentLevel}|${focus}`;
      const pre = prefetch.current;
      prefetch.current = null;
      let result = pre && pre.key === key ? await pre.promise : null;
      if (result && ids.has(result.pick.sentence.id)) result = null;
      result ??= await reader.next({ focus, level: currentLevel, sessionIds: ids });

      if (!result) {
        setMessage(
          'No sentence found yet. Chat or write a journal entry to give the reader material, or paste your own text below.',
        );
        return;
      }
      const { pick } = result;
      await reader.markShown(pick.sentence.id).catch(() => undefined);
      push({
        key: newKey(),
        kind: 'pick',
        id: pick.sentence.id,
        text: pick.sentence.zh,
        en: pick.sentence.en,
        reason: pick.reason,
        sourceLabel: pick.sentence.sourceLabel,
        exact: pick.exact,
        left: false,
        englishShown: false,
        englishRecorded: false,
      });
      startPrefetch(new Set([...ids, pick.sentence.id]));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function goBack() {
    const cur = navRef.current;
    if (cur.pos > 0) setNav({ ...cur, pos: cur.pos - 1 });
  }

  async function toggleEnglish() {
    const entry = navRef.current.entries[navRef.current.pos];
    if (!entry?.en) return;
    patchEntry(entry.key, { englishShown: !entry.englishShown });
    // Revealing it counts as a weak lookup for the sentence's unknown words.
    if (!entry.englishShown && !entry.englishRecorded && entry.kind === 'pick' && entry.id) {
      patchEntry(entry.key, { englishRecorded: true });
      const seen = lookedUpFor(entry.key);
      const recorded = await reader
        .recordRevealEnglish(wordIdsOf(entry.text), seen, entry.id)
        .catch(() => [] as string[]);
      for (const id of recorded) seen.add(id);
      if (recorded.length > 0)
        setLookupLog((log) => [`${new Date().toISOString()} revealed English`, ...log].slice(0, 20));
    }
  }

  function onPaste(value: string) {
    setPasted(value);
    const cur = navRef.current;
    const here = cur.entries[cur.pos]!;
    if (here.kind === 'paste') {
      patchEntry(here.key, { text: value });
      return;
    }
    push({
      key: newKey(),
      kind: 'paste',
      text: value,
      reason: 'Your own text',
      exact: true,
      left: true,
      englishShown: false,
      englishRecorded: false,
    });
  }

  // ← / → keys (not while typing in a field).
  const pressNewRef = useRef(pressNew);
  pressNewRef.current = pressNew;
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        void pressNewRef.current();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goBackRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Swipe left = New sentence (swipe right = Back).
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = touchStart.current;
    const t = e.changedTouches[0];
    touchStart.current = null;
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(t.clientY - start.y) > Math.abs(dx)) return;
    if (dx < 0) void pressNew();
    else goBack();
  };

  async function reportFromPopover(at: AnnotatedToken) {
    if (!at.word) return;
    await reportGloss(db, {
      word: at.word,
      sense: at.sense,
      shownGloss: at.gloss,
      contextSentence: text,
    });
    setLookupLog((log) => [`reported definition of ${at.token.text}`, ...log].slice(0, 20));
  }

  async function handleLookup(at: AnnotatedToken, kind: 'gloss' | 'reading') {
    const line = `${new Date().toISOString()} lookup ${kind} ${at.token.text}`;
    console.log(line);
    setLookupLog((log) => [line, ...log].slice(0, 20));

    if (!at.wordId) return; // no lexicon entry to attach evidence to
    lookedUpFor(current.key).add(at.wordId);
    await reader.recordLookup(
      at.wordId,
      kind === 'gloss' ? 'chat_lookup_gloss' : 'chat_hover_reading',
      current.id,
    );
  }

  return (
    <div className="reader-page" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <h1>An'an reader</h1>
      <p className="reader-meta">
        Lexicon {lexiconState.meta.version} · {lexiconState.meta.wordCount} words · built{' '}
        {lexiconState.meta.buildDate}
      </p>

      <div className="reader-focus" role="radiogroup" aria-label="Sentence focus">
        {READER_FOCUSES.filter((f) => f !== "lesson" || myClass.enabled || studyOn).map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={focus === f}
            className={`reader-chip ${focus === f ? 'reader-chip--on' : ''}`}
            onClick={() => setFocus(f)}
          >
            {FOCUS_LABELS[f]}
          </button>
        ))}
      </div>

      <div className="reader-controls">
        <label>
          Mode:{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as AnnotationMode)}>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          Script:{' '}
          <select value={script} onChange={(e) => setScript(e.target.value as AnnotationScript)}>
            {SCRIPTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <AnnotatedText
        tokens={annotated}
        onReportGloss={(at) => void reportFromPopover(at)}
        mode={mode}
        script={script}
        onLookup={handleLookup}
        currentLevel={currentLevel}
      />

      {current.kind === 'pick' && <SpeakerButton kind="sentence" id={current.id} text={current.text} />}

      <p className="reader-reason" data-testid="reader-reason">
        {current.reason}
        {current.sourceLabel && current.kind === 'pick' && (
          <span className="reader-source"> · {current.sourceLabel}</span>
        )}
      </p>
      {!current.exact && (
        <p className="reader-nomatch" role="status">
          Couldn't find a perfect match
        </p>
      )}

      {current.kind === 'pick' && (
        <div className="reader-english">
          {current.en ? (
            <>
              <button type="button" onClick={() => void toggleEnglish()}>
                {current.englishShown ? 'Hide English' : 'Show English'}
              </button>
              {current.englishShown && (
                <span className="reader-english-text" data-testid="reader-english">
                  {current.en}
                </span>
              )}
            </>
          ) : (
            <span className="reader-source">No English for this sentence</span>
          )}
        </div>
      )}

      <div className="reader-nav">
        <button
          type="button"
          onClick={goBack}
          disabled={nav.pos === 0}
          aria-label="Previous sentence"
        >
          ← Back
        </button>
        <button
          type="button"
          className="reader-new"
          onClick={() => void pressNew()}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? 'Finding a sentence…' : 'New sentence →'}
        </button>
      </div>
      {message && (
        <p className="warning" role="status">
          {message}
        </p>
      )}

      <section className="reader-paste">
        <label htmlFor="reader-paste-input">Paste your own text</label>
        <textarea
          id="reader-paste-input"
          className="reader-input"
          value={pasted}
          onChange={(e) => onPaste(e.target.value)}
          rows={3}
          placeholder="Paste traditional Chinese text…"
        />
      </section>

      <UnlistedWords
        spans={annotated.filter((a) => a.token.kind === 'unknown').map((a) => a.token.text)}
        context={text}
      />

      {!taiwanness.isClean && (
        <div className="taiwanness-warnings">
          <h2>Taiwan-ness warnings</h2>
          {taiwanness.simplifiedChars.map((h, i) => (
            <div key={`s${i}`} className="warning warning--simplified">
              Simplified character <strong>{h.char}</strong> — traditional is{' '}
              <strong>{h.traditional}</strong>.
            </div>
          ))}
          {taiwanness.mainlandTerms.map((h, i) => (
            <div key={`m${i}`} className="warning warning--mainland">
              Mainland term <strong>{h.matched}</strong> — Taiwan uses <strong>{h.taiwan}</strong>.
              {h.note && <span className="warning-note"> {h.note}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="coverage">
        <h2>Level coverage</h2>
        <ul>
          {LEVEL_ORDER.filter((lvl) => cov.byLevel[lvl]).map((lvl) => (
            <li key={lvl}>
              {lvl}: {cov.byLevel[lvl]}
            </li>
          ))}
          {cov.byLevel.unleveled && <li>unleveled: {cov.byLevel.unleveled}</li>}
        </ul>
        <p className="coverage-known-note">
          {cov.knownCount} known / {cov.unknownCount} unknown word tokens (known = recognition card
          in review or mature)
        </p>
      </div>

      {lookupLog.length > 0 && (
        <div className="lookup-log">
          <h2>Lookup events (console + last 20, now feeding the learner model)</h2>
          <pre>{lookupLog.join('\n')}</pre>
        </div>
      )}

      {import.meta.env.DEV && (
        <label className="reader-dev">
          <input type="checkbox" checked={useFake} onChange={(e) => setUseFake(e.target.checked)} />{' '}
          Use fake tutor for generated sentences (dev)
        </label>
      )}
    </div>
  );
}

/** Phase 7 §B5: words the lexicon doesn't know get an on-demand AI definition —
 * clearly labelled, cached, and queued for human review (never for listed words). */
function UnlistedWords({ spans, context }: { spans: string[]; context: string }) {
  const unique = [...new Set(spans)];
  const [useFake, setUseFake] = useState(false);
  const llm = useMemo(() => (useFake ? new FakeTutorLLM() : new FetchTutorLLM()), [useFake]);
  const [results, setResults] = useState<Record<string, AiDefinition | string>>({});
  if (unique.length === 0) return null;

  async function define(word: string) {
    try {
      const def = await defineUnlisted(db, llm, word, context.slice(0, 200));
      setResults((r) => ({ ...r, [word]: def }));
    } catch (err) {
      setResults((r) => ({ ...r, [word]: err instanceof Error ? err.message : String(err) }));
    }
  }

  return (
    <div className="coverage" data-testid="unlisted-words">
      <h2>Not in the dictionary</h2>
      <ul>
        {unique.map((w) => {
          const r = results[w];
          return (
            <li key={w}>
              <span lang="zh-Hant">{w}</span>{' '}
              {r === undefined ? (
                <button onClick={() => define(w)}>Define (AI)</button>
              ) : typeof r === 'string' ? (
                <span className="warning">{r}</span>
              ) : (
                <span>
                  {r.pinyin} — {r.glossEn}{' '}
                  <em className="warning-note">AI-generated, queued for review</em>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {import.meta.env.DEV && (
        <label>
          <input type="checkbox" checked={useFake} onChange={(e) => setUseFake(e.target.checked)} />{' '}
          Use fake tutor (dev)
        </label>
      )}
    </div>
  );
}
