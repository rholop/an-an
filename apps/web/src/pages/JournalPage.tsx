import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  dailyPrompt,
  findWordsUsed,
  courseLessonLevel,
  filterByLevel,
  LAIXUE_COURSE,
  glossFor,
  pickPromptWords,
  studyGrammarId,
  studyTargetWordIds,
  renderBracketsInline,
  alternativeLine,
  ruleNoteFor,
  sameMistakeCount,
  sentenceRange,
  JOURNAL_ASK_MAX_TURNS,
  type JournalIssue,
  type Lesson,
  type Level,
  type SkillCard,
  type Lexicon,
  type SelfFixRecord,
  type Word,
} from '@anan/core';
import { AnnotatedInline, AnnotatedWord, useReadingScript } from '../components/AnnotatedInline.js';
import type { AnnotationScript } from '../components/AnnotatedText.js';
import { BottomSheet } from '../components/BottomSheet.js';
import { JournalProgress } from '../components/JournalProgress.js';
import { db, gameService, learnerService } from '../db/instance.js';
import { getLedgerNow } from '../lib/ledger.js';
import { useReviewSettings } from '../lib/review-settings.js';
import { useCurrentLevel } from '../lib/current-level.js';
import type { JournalEntryRow, JournalReviewRow } from '../db/schema.js';
import { FakeTutorLLM } from '../lib/fake-tutor-llm.js';
import { JournalService, notPractised } from '../lib/journal-service.js';
import { aiErrorText, FetchTutorLLM } from '../lib/tutor-llm.js';
import { useLexicon } from '../lib/useLexicon.js';
import { useMyClass } from '../lib/my-class.js';
import { useTextbook } from '../lib/textbook-data.js';
import { useStudyFocus } from '../lib/study.js';
import { SHEET_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { useSetting } from '../lib/useSetting.js';
import { ProtectedTerms } from '../components/ProtectedTerms.js';
import {
  ADD_TO_REVIEW,
  ADDED_TO_REVIEW,
  ASK_ABOUT_THIS,
  CHECKING_EXPLANATION,
  CURRENT_LESSON,
  FEEDBACK_CORRECT,
  ISSUE_TYPE_LABEL,
  ISSUE_TYPE_MEANING,
  MINE_IS_RIGHT_JOURNAL,
  NOT_SURE_EXPLANATION,
  REPORT_LABEL,
  REPORT_THANKS,
  UNDERSTANDABLE_NOTE,
  WHAT_DID_YOU_MEAN,
  WHY,
  YOU_ARE_RIGHT_REMOVED,
  lessonLabel,
  readAsLine,
  sameMistakeLine,
  stillAMistake,
  yourClassLabel,
} from '../lib/labels.js';
import { showToast } from '../lib/toast.js';
import './JournalPage.css';

type JournalPromptLike = Lesson['journalPrompts'][number];

const TYPE_LABEL: Record<JournalIssue['type'], string> = ISSUE_TYPE_LABEL;

/** Chinese shown by the journal (prompts, corrections, suggested words) is
 * annotated text: reading always on screen, definition on hover and click.
 * The lexicon and the reading script are provided once at the top. */
const AnnotationContext = createContext<{ lexicon: Lexicon; script: AnnotationScript } | null>(
  null,
);

function Zh({ text }: { text: string }) {
  const ctx = useContext(AnnotationContext);
  return ctx ? (
    <AnnotatedInline text={text} lexicon={ctx.lexicon} script={ctx.script} />
  ) : (
    <span lang="zh-Hant">{text}</span>
  );
}

function ZhWord({ word }: { word: Word }) {
  const ctx = useContext(AnnotationContext);
  return ctx ? (
    <AnnotatedWord word={word} script={ctx.script} />
  ) : (
    <span lang="zh-Hant">{word.headword}</span>
  );
}

/** `initialPromptId` / `onDone` let the textbook's "Study this lesson" session
 * open one of the lesson's prompts and carry on when the entry is saved. */
export function JournalPage({
  initialPromptId,
  lesson,
  bookId,
  onDone,
}: { initialPromptId?: string; lesson?: number; bookId?: string; onDone?: () => void } = {}) {
  const lexiconState = useLexicon();
  const script = useReadingScript();
  const [useFakeLLM, setUseFakeLLM] = useState(false);
  const tutorLLM = useMemo(
    () => (useFakeLLM ? new FakeTutorLLM() : new FetchTutorLLM()),
    [useFakeLLM],
  );
  const service = useMemo(
    () =>
      lexiconState.status === 'ready'
        ? new JournalService(
            db,
            lexiconState.lexicon,
            learnerService,
            tutorLLM,
            undefined,
            undefined,
            (entryId, selfFixed, at) => gameService.onJournalFinished(entryId, selfFixed, at),
          )
        : null,
    [lexiconState, tutorLLM],
  );

  const { level: learnerLevel } = useCurrentLevel();
  const [dueCards, setDueCards] = useState<SkillCard[]>([]);
  const [entry, setEntry] = useState<JournalEntryRow | null>(null);
  const [review, setReview] = useState<JournalReviewRow | null>(null);
  const [progressKey, setProgressKey] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const { timeZone } = useReviewSettings();
  const dailyP = useMemo(() => dailyPrompt(new Date(), timeZone), [timeZone]);
  // Phase 12: while "My class" is on, the current lesson's prompts come first.
  const myClass = useMyClass();
  const textbookState = useTextbook();
  const promptBook = bookId ?? myClass.textbookId;
  // Phase 14: the study order's active lesson (prompts first, words and grammar from unmastered items).
  const { focus: studyFocus } = useStudyFocus();
  // Phase 21: each group of prompts sits under its own lesson's label (the active study lesson's
  // first, then your class's lesson); lessons are found by their number, never by position.
  const promptGroups = useMemo((): Array<{ label: string; prompts: JournalPromptLike[] }> => {
    if (textbookState.status !== 'ready') return [];
    const lessonOf = (b: string, n: number) =>
      textbookState.books.find((x) => x.id === b)?.lessons.find((l) => l.n === n);
    // A "Study this lesson" session (explicit lesson) works for any lesson, class or not.
    if (lesson !== undefined) {
      const prompts = lessonOf(promptBook, lesson)?.journalPrompts ?? [];
      return prompts.length ? [{ label: lessonLabel(lesson, promptBook), prompts }] : [];
    }
    const groups: Array<{ label: string; prompts: JournalPromptLike[] }> = [];
    const a = studyFocus?.enabled ? studyFocus.activeLesson : undefined;
    if (a) {
      const prompts = lessonOf(a.bookId, a.n)?.journalPrompts ?? [];
      if (prompts.length) groups.push({ label: `${CURRENT_LESSON}: ${lessonLabel(a.n, a.bookId)}`, prompts });
    }
    if (myClass.enabled && !(a && a.bookId === myClass.textbookId && a.n === myClass.currentLesson)) {
      const prompts = lessonOf(myClass.textbookId, myClass.currentLesson)?.journalPrompts ?? [];
      // Phase 13: the header level picker shows your level first, easier below, harder hidden.
      const rest = filterByLevel(
        prompts,
        (p) => p.level ?? courseLessonLevel(LAIXUE_COURSE, myClass.textbookId, myClass.currentLesson),
        learnerLevel,
      );
      if (rest.length) groups.push({ label: yourClassLabel(myClass.currentLesson, myClass.textbookId), prompts: rest });
    }
    return groups;
  }, [myClass, textbookState, lesson, promptBook, learnerLevel, studyFocus]);
  const classPrompts = useMemo(() => promptGroups.flatMap((g) => g.prompts), [promptGroups]);
  const [donePromptIds, setDonePromptIds] = useState<Set<string>>(new Set());
  const [chosenId, setChosenId] = useState<string | null>(initialPromptId ?? null);
  useEffect(() => {
    db.journalEntries
      .where('status')
      .equals('finished')
      .toArray()
      .then((rows) =>
        setDonePromptIds(new Set(rows.flatMap((r) => (r.promptId ? [r.promptId] : [])))),
      )
      .catch(() => undefined);
  }, [progressKey]);
  const chosenClass =
    classPrompts.find((p) => p.id === chosenId) ??
    (chosenId === null ? classPrompts.find((p) => !donePromptIds.has(p.id)) : undefined);
  const prompt = useMemo(
    () =>
      chosenClass
        ? { id: chosenClass.id, en: chosenClass.promptEn, starterZh: chosenClass.promptZh ?? '' }
        : dailyP,
    [chosenClass, dailyP],
  );
  // Phase 7: recomputed when "My level" changes — no reload needed.
  const promptWords = useMemo(() => {
    if (lexiconState.status !== 'ready') return [];
    if (chosenClass)
      return chosenClass.useWords.flatMap((id) => lexiconState.lexicon.byId(id) ?? []);
    // Phase 14: with the study order on, the 3 words come from unmastered textbook items first.
    const study = studyTargetWordIds(studyFocus, 3).flatMap((id) => lexiconState.lexicon.byId(id) ?? []);
    if (study.length >= 3) return study;
    const rest = pickPromptWords(dueCards, lexiconState.lexicon, new Date(), 3, learnerLevel).filter(
      (w) => !study.some((s) => s.id === w.id),
    );
    return [...study, ...rest].slice(0, 3);
  }, [lexiconState, dueCards, learnerLevel, chosenClass, studyFocus]);
  const grammarHints = useMemo(
    () =>
      lexiconState.status === 'ready' && chosenClass
        ? chosenClass.useGrammar.flatMap(
            (id) => lexiconState.lexicon.grammarItemById(id)?.pattern ?? [],
          )
        : lexiconState.status === 'ready' && studyGrammarId(studyFocus)
          ? ([lexiconState.lexicon.grammarItemById(studyGrammarId(studyFocus)!)?.pattern].filter(Boolean) as string[])
          : [],
    [lexiconState, chosenClass, studyFocus],
  );

  // Phase 31 Part E: every correction so far, for "You've made this mistake N times".
  const [pastIssues, setPastIssues] = useState<JournalIssue[]>([]);
  const reload = useCallback(
    async (id: string) => {
      if (!service) return;
      const [e, r] = await Promise.all([service.getEntry(id), service.getReview(id)]);
      setEntry(e ?? null);
      setReview(r ?? null);
      const all = await db.journalReviews.toArray();
      setPastIssues(all.flatMap((x) => x.issues.filter((_, i) => !notPractised(x).has(i))));
      // Phase 31 Part A.4: explanations that couldn't be checked yet are checked now
      if (r?.issues.some((i) => i.explainStatus === 'pending')) {
        const changed = await service.retryExplanations(id).catch(() => false);
        if (changed) setReview((await service.getReview(id)) ?? null);
      }
    },
    [service],
  );

  // Resume an unfinished entry, and pick the learner's level + prompt words.
  useEffect(() => {
    if (lexiconState.status !== 'ready' || !service) return;
    let cancelled = false;
    (async () => {
      const now = new Date();
      // Phase 27: prompt words come from this review session (between sessions, the next one's).
      const [due, entries] = await Promise.all([
        getLedgerNow(now).then((l) => l.session(l.status.session === 'between' ? { early: true } : {}).cards.slice(0, 200)),
        db.journalEntries.where('status').notEqual('finished').sortBy('createdAt'),
      ]);
      if (cancelled) return;
      // Phase 31 Part D.4: list the old rule's gap words on the Reported page (once)
      void service.migrateLegacyGaps().catch(() => undefined);
      setDueCards(due);
      const open = entries.at(-1);
      if (open) await reload(open.id);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [lexiconState, service, reload]);

  if (lexiconState.status === 'loading') return <p>Loading…</p>;
  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;
  if (!service || !loaded) return <p>Loading…</p>;

  function startOver() {
    setEntry(null);
    setReview(null);
    setProgressKey((k) => k + 1);
  }

  return (
    <AnnotationContext.Provider value={{ lexicon: lexiconState.lexicon, script }}>
      <div className="journal-page">
        <h1>Journal</h1>
        <ProtectedTerms lexicon={lexiconState.lexicon} />
        <p className="journal-disclaimer">
          An AI tutor suggests the corrections here. It is often right, but not always — if
          something looks wrong or unnatural to you, flag it and it won&apos;t be added to your
          practice.
        </p>
        <label className="journal-dev-toggle">
          <input
            type="checkbox"
            checked={useFakeLLM}
            onChange={(e) => setUseFakeLLM(e.target.checked)}
          />{' '}
          Use fake tutor (dev, no API key)
        </label>

        {!entry && classPrompts.length > 0 && (
          <div className="journal-class-prompts" data-testid="class-prompts">
            <div role="radiogroup" aria-label="Choose a prompt">
              {classPrompts.map((p, i) => (
                <Fragment key={p.id}>
                {promptGroups.find((g) => g.prompts[0] === p) && (
                  <p className="journal-prompt-group">
                    <span className="textbook-badge" lang="zh-Hant">
                      {promptGroups.find((g) => g.prompts[0] === p)!.label}
                    </span>
                  </p>
                )}
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={chosenClass?.id === p.id}
                  className={`reader-chip ${chosenClass?.id === p.id ? 'reader-chip--on' : ''}`}
                  onClick={() => setChosenId(p.id)}
                >
                  {donePromptIds.has(p.id) ? '✓ ' : ''}Prompt {i + 1}
                </button>
                </Fragment>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={!chosenClass}
                className={`reader-chip ${!chosenClass ? 'reader-chip--on' : ''}`}
                onClick={() => setChosenId('daily')}
              >
                Daily prompt
              </button>
            </div>
          </div>
        )}

        {!entry && (
          <WriteStage
            service={service}
            lexicon={lexiconState.lexicon}
            learnerLevel={learnerLevel}
            prompt={prompt}
            promptWords={promptWords}
            grammarHints={grammarHints}
            onSubmitted={(e, r) => {
              setEntry(e);
              setReview(r);
            }}
          />
        )}

        {entry && review && entry.status === 'self_correcting' && (
          <SelfCorrectStage
            service={service}
            entry={entry}
            review={review}
            pastIssues={pastIssues}
            onChange={() => reload(entry.id)}
          />
        )}

        {entry && review && entry.status === 'revealed' && (
          <RevealStage
            service={service}
            entry={entry}
            review={review}
            promptWords={entry.promptWordIds.flatMap((id) => lexiconState.lexicon.byId(id) ?? [])}
            lexicon={lexiconState.lexicon}
            pastIssues={pastIssues}
            onChange={() => reload(entry.id)}
            onFinished={() => reload(entry.id).then(() => setProgressKey((k) => k + 1))}
          />
        )}

        {entry && entry.status === 'finished' && (
          <section>
            <p role="status">
              Entry saved. Your corrections will come back as practice sentences in Cloze review.
            </p>
            <button onClick={startOver}>Write another entry</button>
            {onDone && (
              <button onClick={onDone} data-testid="journal-done">
                Finish lesson
              </button>
            )}
          </section>
        )}

        <JournalProgress refreshKey={progressKey} />
      </div>
    </AnnotationContext.Provider>
  );
}

function WriteStage({
  service,
  lexicon,
  learnerLevel,
  prompt,
  promptWords,
  grammarHints,
  onSubmitted,
}: {
  service: JournalService;
  lexicon: Lexicon;
  learnerLevel: Level;
  prompt: ReturnType<typeof dailyPrompt>;
  promptWords: Word[];
  grammarHints: string[];
  onSubmitted: (e: JournalEntryRow, r: JournalReviewRow) => void;
}) {
  // Phase 8: the draft is kept in the profile's database, so it survives a
  // reload and is saved before switching to the other profile.
  const [text, setText] = useSetting('journalDraft', '', 400);
  const [intendedEn, setIntendedEn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const used = useMemo(
    () => findWordsUsed(text, promptWords, lexicon),
    [text, promptWords, lexicon],
  );

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { entry, review } = await service.submit({
        text,
        learnerLevel,
        promptId: prompt.id,
        promptWordIds: promptWords.map((w) => w.id),
        ...(intendedEn.trim() ? { intendedEn: intendedEn.trim() } : {}),
      });
      setText(''); // submitted: the draft is done
      setIntendedEn('');
      onSubmitted(entry, review);
    } catch (err) {
      setError(aiErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="journal-write">
      <h2>Today&apos;s prompt</h2>
      <p className="journal-prompt">
        {prompt.en}{' '}
        {prompt.starterZh && (
          <span lang="zh-Hant">
            <Zh text={prompt.starterZh} />
          </span>
        )}
      </p>
      {promptWords.length > 0 && (
        <div className="journal-prompt-words">
          <p>Try to use these words:</p>
          <ul>
            {promptWords.map((w) => (
              <li key={w.id} className={used.has(w.id) ? 'journal-word--used' : ''}>
                <input
                  type="checkbox"
                  checked={used.has(w.id)}
                  readOnly
                  aria-label={`${w.headword} used`}
                />{' '}
                <span lang="zh-Hant">
                  <ZhWord word={w} />
                </span>{' '}
                <span className="journal-muted">{glossFor(w)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {grammarHints.length > 0 && (
        <p className="journal-muted">
          Try this pattern: <span lang="zh-Hant">{grammarHints.join('；')}</span>
        </p>
      )}
      <textarea
        className="journal-textarea"
        lang="zh-Hant"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder="寫下你的想法… 不會寫的字可以用 [English] 先代替。"
        aria-label="Journal entry"
        enterKeyHint="enter"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <p className="journal-muted">
        Don&apos;t know a word? Write it in English inside brackets, like{' '}
        <code lang="zh-Hant">今天我去 [gym]</code> or{' '}
        <code lang="zh-Hant">今天我去【gym】</code>, and we&apos;ll suggest words that fit.
      </p>
      <label className="journal-intended">
        <span>
          {WHAT_DID_YOU_MEAN} <span className="journal-muted">(optional, in English)</span>
        </span>
        <input
          value={intendedEn}
          onChange={(e) => setIntendedEn(e.target.value)}
          placeholder="I enjoy studying Chinese. My teacher is very nice."
          maxLength={300}
        />
      </label>
      {error && (
        <p role="alert" className="journal-error">
          {error}
        </p>
      )}
      <button className="journal-submit btn-primary" onClick={submit} disabled={busy || !text.trim()}>
        {busy ? 'Checking…' : 'Submit for feedback'}
      </button>
    </section>
  );
}

/** Splits `text` into plain and highlighted runs for the given issues. */
function HighlightedText({
  text,
  issues,
  onSelect,
}: {
  text: string;
  issues: JournalIssue[];
  /** Phones: tapping a highlighted part opens its correction in a sheet. */
  onSelect?: (index: number) => void;
}) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  issues.forEach((issue, i) => {
    // Phase 21: the learner's own text is tap-to-lookup too (the marked parts open their correction).
    if (issue.span[0] > cursor) parts.push(<Zh key={`t${i}`} text={text.slice(cursor, issue.span[0])} />);
    parts.push(
      <mark
        key={i}
        className={`journal-hl journal-hl--${issue.type} ${onSelect ? 'journal-hl--tap' : ''}`}
        title={TYPE_LABEL[issue.type]}
        data-issue={i}
        {...(onSelect
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': `${TYPE_LABEL[issue.type]}: part ${i + 1}`,
              onClick: () => onSelect(i),
              onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && onSelect(i),
            }
          : {})}
      >
        {text.slice(issue.span[0], issue.span[1])}
      </mark>,
    );
    cursor = issue.span[1];
  });
  if (cursor < text.length) parts.push(<Zh key="tail" text={text.slice(cursor)} />);
  return (
    <p className="journal-text" lang="zh-Hant">
      {parts}
    </p>
  );
}

/** Phase 31 Part A.3: the legend explains itself (tap a label for one line). */
function Legend() {
  const [open, setOpen] = useState<JournalIssue['type'] | null>(null);
  const types: JournalIssue['type'][] = ['error', 'unnatural', 'mainland_style'];
  return (
    <div className="journal-legend">
      <p>
        {types.map((t) => (
          <Fragment key={t}>
            <button
              type="button"
              className={`journal-hl journal-hl--${t} journal-legend-btn`}
              aria-expanded={open === t}
              onClick={() => setOpen(open === t ? null : t)}
            >
              {TYPE_LABEL[t].toLowerCase()}
            </button>{' '}
          </Fragment>
        ))}
      </p>
      {open && (
        <p className="journal-muted" role="status" data-testid="legend-meaning">
          {ISSUE_TYPE_MEANING[open]}
        </p>
      )}
    </div>
  );
}

/** Phase 31 Part A: the "Why?" of one correction, shown only once it passed the check. */
function IssueWhy({ issue, pastIssues }: { issue: JournalIssue; pastIssues: readonly JournalIssue[] }) {
  if (issue.explainStatus === 'pending')
    return (
      <p className="journal-muted" role="status">
        {CHECKING_EXPLANATION}
      </p>
    );
  if (issue.explainStatus === 'unsure')
    return (
      <p className="journal-muted" role="status" data-testid="journal-unsure">
        {NOT_SURE_EXPLANATION}
      </p>
    );
  const e = issue.explain;
  const rule = ruleNoteFor(issue.pattern);
  const n = sameMistakeCount(issue.pattern, pastIssues);
  return (
    <div className="journal-why" data-testid="journal-why">
      {e ? (
        <>
          <p>
            <strong>What&apos;s wrong:</strong> {e.wrongEn}
          </p>
          <p>
            <strong>The fix:</strong> {e.fixEn}
          </p>
          <p lang="zh-Hant" className="journal-pair">
            <span className="journal-pair-wrong">
              <Zh text={e.exampleWrong} /> ✗
            </span>{' '}
            →{' '}
            <span className="journal-ok">
              <Zh text={e.exampleRight} /> ✓
            </span>
          </p>
          {issue.type === 'unnatural' && (
            <p>
              {e.nativeEn ? `${e.nativeEn} ` : ''}
              {UNDERSTANDABLE_NOTE}
            </p>
          )}
        </>
      ) : (
        <p>{issue.explanationEn}</p>
      )}
      {rule && (
        <details className="journal-rule">
          <summary>{rule.title}</summary>
          <p>{rule.explanationEn}</p>
          <ul lang="zh-Hant">
            {rule.examples.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </details>
      )}
      {n >= 2 && <p className="journal-muted">{sameMistakeLine(n)}</p>}
    </div>
  );
}

/** A "Why?" button that opens the explanation (open by default once the answers are shown). */
function WhyToggle({
  issue,
  pastIssues,
  initiallyOpen = false,
}: {
  issue: JournalIssue;
  pastIssues: readonly JournalIssue[];
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {WHY}
      </button>
      {open && <IssueWhy issue={issue} pastIssues={pastIssues} />}
    </>
  );
}

/** Phase 31 Part C.1: "Ask about this", up to 5 questions, saved with the entry. */
function AskPanel({
  service,
  entryId,
  index,
  turns,
  onChange,
}: {
  service: JournalService;
  entryId: string;
  index: number;
  turns: readonly { q: string; a: string; examples: { zh: string; en: string }[] }[];
  onChange: () => void;
}) {
  const ctx = useContext(AnnotationContext);
  const [open, setOpen] = useState(turns.length > 0);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    setError(null);
    try {
      // examples are built from the words the learner knows (vocabulary ladder rung 1)
      const ledger = await getLedgerNow(new Date());
      const known = ctx
        ? [...ledger.comprehensible().knownIds].slice(0, 400).flatMap((id) => ctx.lexicon.byId(id)?.headword ?? []).slice(0, 80)
        : [];
      await service.ask(entryId, index, q, known);
      setQ('');
      onChange();
    } catch (err) {
      setError(aiErrorText(err));
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)}>
        {ASK_ABOUT_THIS}
      </button>
    );
  return (
    <div className="journal-ask" data-testid="journal-ask">
      {turns.map((t, i) => (
        <div key={i} className="journal-ask-turn">
          <p className="journal-ask-q">{t.q}</p>
          <p>{t.a}</p>
          {t.examples.length > 0 && (
            <ul>
              {t.examples.map((x) => (
                <li key={x.zh}>
                  <span lang="zh-Hant">
                    <Zh text={x.zh} />
                  </span>{' '}
                  <span className="journal-muted">{x.en}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {turns.length < JOURNAL_ASK_MAX_TURNS && (
        <div className="journal-ask-form">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Why is this wrong if…?"
            aria-label={ASK_ABOUT_THIS}
            enterKeyHint="send"
            onKeyDown={(e) => e.key === 'Enter' && q.trim() && !busy && void send()}
          />
          <button type="button" onClick={send} disabled={busy || !q.trim()}>
            {busy ? 'Asking…' : 'Ask'}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="journal-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Phase 31 Part C.3: "I think mine is right", with the check's answer once it has one. */
function DisputeLine({
  service,
  entryId,
  index,
  dispute,
  onChange,
}: {
  service: JournalService;
  entryId: string;
  index: number;
  dispute?: { verdict: 'upheld' | 'still_wrong'; problem?: string };
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (dispute)
    return (
      <p role="status" className={dispute.verdict === 'upheld' ? 'journal-ok' : 'journal-muted'}>
        {dispute.verdict === 'upheld' ? YOU_ARE_RIGHT_REMOVED : stillAMistake(dispute.problem)}
      </p>
    );
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await service.dispute(entryId, index);
            onChange();
          } catch (err) {
            setError(aiErrorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Checking…' : MINE_IS_RIGHT_JOURNAL}
      </button>
      {error && (
        <p role="alert" className="journal-error">
          {error}
        </p>
      )}
    </>
  );
}

/** Phase 31 Part C.2: the meaning the corrector assumed ("Read as: …"), which the learner can fix
 * (the sentence is checked again aiming at it). */
function MeaningLine({
  service,
  entry,
  review,
  issue,
  onChange,
}: {
  service: JournalService;
  entry: JournalEntryRow;
  review: JournalReviewRow;
  issue: JournalIssue;
  onChange: () => void;
}) {
  const start = sentenceRange(entry.text, issue.span)[0];
  const own = review.meanings?.[start] ?? entry.intendedEn;
  const shown = own ?? issue.meaningEn;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(shown ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canFix = entry.status !== 'finished';
  if (!shown && !canFix) return null;
  return (
    <div className="journal-meaning">
      {!editing && (
        <p className="journal-muted">
          {shown ? (own ? `You meant: ${shown}` : readAsLine(shown)) : ''}{' '}
          {canFix && (
            <button type="button" className="journal-link" onClick={() => setEditing(true)}>
              {shown ? 'Not what I meant' : WHAT_DID_YOU_MEAN}
            </button>
          )}
        </p>
      )}
      {editing && (
        <div className="journal-ask-form">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={WHAT_DID_YOU_MEAN}
            placeholder="I meant…"
          />
          <button
            type="button"
            disabled={busy || !value.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await service.setMeaning(entry.id, value, start);
                setEditing(false);
                onChange();
              } catch (err) {
                setError(aiErrorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Checking…' : 'Check again'}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="journal-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Phase 31 Part D: each gap's options, with pinyin, meaning and a usage note. Nothing goes to
 * review until the learner taps "Add to review". */
function BracketList({
  review,
  service,
  onChange,
}: {
  review: JournalReviewRow;
  service?: JournalService;
  onChange?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (review.brackets.length === 0) return null;
  return (
    <div className="journal-brackets">
      <h3>Gaps filled in</h3>
      <ul>
        {review.brackets.map((b) => {
          const options =
            b.options ?? (b.zh ? [{ zh: b.zh, pinyin: '', meaningEn: '', usageEn: '', corrected: '', checked: false }] : []);
          return (
            <li key={b.en} data-testid="journal-gap">
              <span>[{b.en}]</span>
              {options.length === 0 ? (
                <span className="journal-muted"> no good fit found — look this one up</span>
              ) : (
                <ol className="journal-gap-options">
                  {options.map((o) => {
                    const added = b.added?.includes(o.zh) ?? (!b.options && !!b.wordId);
                    return (
                      <li key={o.zh}>
                        <strong lang="zh-Hant">
                          <Zh text={o.zh} />
                        </strong>
                        {o.pinyin && <span className="journal-muted"> {o.pinyin}</span>}
                        {o.meaningEn && <span> · {o.meaningEn}</span>}
                        {o.usageEn && <div className="journal-muted">{o.usageEn}</div>}
                        {o.corrected && (
                          <div lang="zh-Hant" className="journal-muted">
                            <Zh text={o.corrected} />
                          </div>
                        )}
                        {b.options && service && (
                          <button
                            type="button"
                            disabled={added || busy === `${b.en}:${o.zh}`}
                            onClick={async () => {
                              setBusy(`${b.en}:${o.zh}`);
                              try {
                                await service.addGapWord(review.entryId, b.en, o.zh);
                                onChange?.();
                              } finally {
                                setBusy(null);
                              }
                            }}
                          >
                            {added ? ADDED_TO_REVIEW : ADD_TO_REVIEW}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Phones: one 44px button per highlighted part (the marks in the text are small). */
function IssueButtons({
  issues,
  onOpen,
  hint,
}: {
  issues: JournalIssue[];
  onOpen: (index: number) => void;
  hint: string;
}) {
  if (issues.length === 0) return null;
  return (
    <div className="journal-issue-buttons">
      <p className="journal-muted">{hint}</p>
      {issues.map((issue, i) => (
        <button key={i} type="button" onClick={() => onOpen(i)}>
          <span className={`journal-hl journal-hl--${issue.type}`}>{TYPE_LABEL[issue.type]}</span>{' '}
          <span>Part {i + 1}</span>
        </button>
      ))}
    </div>
  );
}

function SelfCorrectStage({
  service,
  entry,
  review,
  pastIssues,
  onChange,
}: {
  service: JournalService;
  entry: JournalEntryRow;
  review: JournalReviewRow;
  pastIssues: readonly JournalIssue[];
  onChange: () => void;
}) {
  const [attempts, setAttempts] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      review.issues.map((issue, i) => [
        i,
        review.selfFix[i]?.attempt ?? entry.text.slice(...issue.span),
      ]),
    ),
  );
  const [busy, setBusy] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, SelfFixRecord | undefined>>(review.selfFix);
  const sheetMode = useMediaQuery(SHEET_QUERY);
  const [openPart, setOpenPart] = useState<number | null>(null);

  async function check(i: number) {
    setBusy(i);
    try {
      const record = await service.recheckSpan(entry.id, i, attempts[i] ?? '');
      setResults((r) => ({ ...r, [i]: record }));
    } finally {
      setBusy(null);
    }
  }

  async function reveal() {
    await service.reveal(entry.id);
    onChange();
  }

  const fixRow = (issue: JournalIssue, i: number) => {
    const result = results[i];
    return (
      <>
        <span className={`journal-hl journal-hl--${issue.type}`}>{TYPE_LABEL[issue.type]}</span>
        <input
          lang="zh-Hant-TW"
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={attempts[i] ?? ''}
          onChange={(e) => setAttempts((a) => ({ ...a, [i]: e.target.value }))}
          aria-label={`Your fix for part ${i + 1}`}
        />
        <button onClick={() => check(i)} disabled={busy === i}>
          {busy === i ? 'Checking…' : 'Check'}
        </button>
        {result && (
          // Phase 31 Part B: the feedback line is built from fields: the verdict, the learner's
          // fix, other wordings with their meanings. Then the "Why?", right or wrong.
          <div className="journal-feedback" role="status">
            <span className={result.fixed ? 'journal-ok' : 'journal-muted'}>
              {result.fixed ? FEEDBACK_CORRECT : '✗ Not quite yet'}
              {!result.fixed && result.note && ` — ${result.note}`}
            </span>
            {(result.alternatives ?? []).map((alt) => (
              <div key={alt.zh} lang="zh-Hant" className="journal-muted">
                {alternativeLine(alt)}
              </div>
            ))}
            <IssueWhy issue={issue} pastIssues={pastIssues} />
            <MeaningLine service={service} entry={entry} review={review} issue={issue} onChange={onChange} />
            <div className="journal-actions">
              <AskPanel service={service} entryId={entry.id} index={i} turns={review.asks?.[i] ?? []} onChange={onChange} />
              <DisputeLine service={service} entryId={entry.id} index={i} dispute={review.disputes?.[i]} onChange={onChange} />
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <section className="journal-correct">
      <h2>Spot the mistakes</h2>
      <p>
        {review.issues.length === 1 ? 'One part' : `${review.issues.length} parts`} of your entry
        might need another look. Try fixing {review.issues.length === 1 ? 'it' : 'them'} yourself
        before seeing the answers.
      </p>
      <Legend />
      <HighlightedText
        text={entry.text}
        issues={review.issues}
        onSelect={sheetMode ? setOpenPart : undefined}
      />
      <BracketList review={review} service={service} onChange={onChange} />
      {sheetMode ? (
        <IssueButtons
          issues={review.issues}
          onOpen={setOpenPart}
          hint="Tap a highlighted part to try fixing it."
        />
      ) : (
        <ol className="journal-fixes">
          {review.issues.map((issue, i) => (
            <li key={i}>{fixRow(issue, i)}</li>
          ))}
        </ol>
      )}
      {openPart !== null && review.issues[openPart] && (
        <BottomSheet label={`Part ${openPart + 1}`} onClose={() => setOpenPart(null)}>
          <div className="journal-fixes journal-fixes--sheet">
            {fixRow(review.issues[openPart]!, openPart)}
          </div>
        </BottomSheet>
      )}
      <button onClick={reveal}>Show corrections</button>
    </section>
  );
}

function RevealStage({
  service,
  entry,
  review,
  promptWords,
  lexicon,
  pastIssues,
  onChange,
  onFinished,
}: {
  service: JournalService;
  entry: JournalEntryRow;
  review: JournalReviewRow;
  pastIssues: readonly JournalIssue[];
  promptWords: Word[];
  lexicon: Lexicon;
  onChange: () => void;
  onFinished: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sheetMode = useMediaQuery(SHEET_QUERY);
  const [openPart, setOpenPart] = useState<number | null>(null);
  const inline = useMemo(
    () => new Map(review.brackets.filter((b) => b.zh).map((b) => [b.en, b.zh])),
    [review.brackets],
  );
  const used = findWordsUsed(
    entry.text,
    promptWords,
    lexicon,
    review.issues.map((i) => i.span),
  );
  const patterns = [...new Set(review.issues.flatMap((i) => (i.pattern ? [i.pattern] : [])))];

  async function explain(i: number) {
    setBusy(i);
    setError(null);
    try {
      await service.explainMore(entry.id, i);
      onChange();
    } catch (err) {
      setError(aiErrorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function flag(i: number) {
    const on = await service.toggleFlag(entry.id, i);
    onChange();
    // Phase 21: the same "⚑ Something's wrong" as everywhere, with Undo; listed on the Reported page.
    if (on)
      showToast(`${REPORT_THANKS} This correction won't be practised.`, async () => {
        await service.toggleFlag(entry.id, i).catch(() => false);
        onChange();
      });
  }

  async function finish() {
    await service.finish(entry.id);
    onFinished();
  }

  const issueBody = (issue: JournalIssue, i: number) => {
    const flagged = review.flagged.includes(i);
    const fixed = review.selfFix[i]?.fixed;
    const more = review.explainMore[i];
    return (
      <>
        <div>
          <span className={`journal-hl journal-hl--${issue.type}`}>{TYPE_LABEL[issue.type]}</span>{' '}
          {fixed && <span className="journal-ok">✓ You fixed this yourself</span>}{' '}
          <span className="journal-muted">confidence: {issue.confidence}</span>
        </div>
        <p lang="zh-Hant">
          <del>{entry.text.slice(...issue.span)}</del> →{' '}
          <strong>
            <Zh text={issue.correction} />
          </strong>
        </p>
        <WhyToggle issue={issue} pastIssues={pastIssues} initiallyOpen />
        {(review.selfFix[i]?.alternatives ?? []).map((alt) => (
          <p key={alt.zh} lang="zh-Hant" className="journal-muted">
            {alternativeLine(alt)}
          </p>
        ))}
        <MeaningLine service={service} entry={entry} review={review} issue={issue} onChange={onChange} />
        {more && (
          <div className="journal-more">
            <p>{more.explanationEn}</p>
            <ul>
              {more.examples.map((e) => (
                <li key={e.zh}>
                  <span lang="zh-Hant">
                    <Zh text={e.zh} />
                  </span>{' '}
                  <span className="journal-muted">{e.en}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="journal-actions">
          {!more && (
            <button onClick={() => explain(i)} disabled={busy === i}>
              {busy === i ? 'Asking…' : 'Explain more'}
            </button>
          )}
          <AskPanel service={service} entryId={entry.id} index={i} turns={review.asks?.[i] ?? []} onChange={onChange} />
          <DisputeLine service={service} entryId={entry.id} index={i} dispute={review.disputes?.[i]} onChange={onChange} />
          <button onClick={() => flag(i)} aria-pressed={flagged}>
            {flagged ? 'Reported: won’t be practised (Undo)' : REPORT_LABEL}
          </button>
        </div>
      </>
    );
  };

  return (
    <section className="journal-reveal">
      <h2>Feedback</h2>
      <Legend />
      <HighlightedText
        text={entry.text}
        issues={review.issues}
        onSelect={sheetMode ? setOpenPart : undefined}
      />
      <BracketList review={review} service={service} onChange={onChange} />
      {Object.keys(review.selfFix).length > 0 && (
        <p className="journal-muted">Parts you fixed yourself are marked ✓ — nicely done.</p>
      )}

      {review.issues.length === 0 && <p>Nothing stood out to correct. Nice writing!</p>}
      {sheetMode ? (
        <IssueButtons
          issues={review.issues}
          onOpen={setOpenPart}
          hint="Tap a highlighted part to see its correction."
        />
      ) : (
        <ol className="journal-issues">
          {review.issues.map((issue, i) => (
            <li
              key={i}
              className={
                review.flagged.includes(i) || review.disputes?.[i]?.verdict === 'upheld'
                  ? 'journal-issue journal-issue--flagged'
                  : 'journal-issue'
              }
            >
              {issueBody(issue, i)}
            </li>
          ))}
        </ol>
      )}
      {openPart !== null && review.issues[openPart] && (
        <BottomSheet label={`Correction ${openPart + 1}`} onClose={() => setOpenPart(null)}>
          <div
            className={
              review.flagged.includes(openPart)
                ? 'journal-issue journal-issue--flagged'
                : 'journal-issue'
            }
          >
            {issueBody(review.issues[openPart]!, openPart)}
          </div>
        </BottomSheet>
      )}
      {error && (
        <p role="alert" className="journal-error">
          {error}
        </p>
      )}

      {review.naturalRewrite && (
        <div className="journal-rewrite">
          <h3>A natural way to say it</h3>
          <p lang="zh-Hant">
            <Zh text={review.naturalRewrite} />
          </p>
          <p className="journal-muted">
            One way a Taiwanese speaker might write it — not the only way.
          </p>
        </div>
      )}

      <div className="journal-summary">
        <h3>About this entry</h3>
        <p>{review.levelHeadline}</p>
        {review.errorsPer100Chars !== null && (
          <p className="journal-muted">
            {review.errorsPer100Chars.toFixed(1)} suggested corrections per 100 characters.
          </p>
        )}
        {review.wordsUsed.length > 0 && (
          <p>
            Words you used:{' '}
            <span lang="zh-Hant">
              {review.wordsUsed.map((w, i) => (
                <span key={`${w}-${i}`}>
                  {i > 0 && '、'}
                  <Zh text={w} />
                </span>
              ))}
            </span>
          </p>
        )}
        {promptWords.length > 0 && (
          <p>
            Prompt words used:{' '}
            {promptWords.map((w) => (
              <span
                key={w.id}
                lang="zh-Hant"
                className={used.has(w.id) ? 'journal-ok' : 'journal-muted'}
              >
                {used.has(w.id) ? '✓' : '·'}
                <ZhWord word={w} />{' '}
              </span>
            ))}
          </p>
        )}
        {patterns.length > 0 && (
          <p>
            Patterns to watch:{' '}
            {patterns.map((p) => (
              <code key={p}>{p} </code>
            ))}
          </p>
        )}
        {inline.size > 0 && (
          <p className="journal-muted lang-note">
            Your gaps: <span lang="zh-Hant">{renderBracketsInline(entry.text, inline)}</span>
          </p>
        )}
      </div>

      <button onClick={finish}>Finish entry</button>
    </section>
  );
}
