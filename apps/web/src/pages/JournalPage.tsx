import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  dailyPrompt,
  findWordsUsed,
  lessonBadge,
  pickPromptWords,
  renderBracketsInline,
  type JournalIssue,
  type Level,
  type SkillCard,
  type Lexicon,
  type SelfFixRecord,
  type Word,
} from '@anan/core';
import { AnnotatedInline, AnnotatedWord, useReadingScript } from '../components/AnnotatedInline.js';
import type { AnnotationScript } from '../components/AnnotatedText.js';
import { JournalProgress } from '../components/JournalProgress.js';
import { db, gameService, learnerService } from '../db/instance.js';
import { useCurrentLevel } from '../lib/current-level.js';
import type { JournalEntryRow, JournalReviewRow } from '../db/schema.js';
import { FakeTutorLLM } from '../lib/fake-tutor-llm.js';
import { JournalService } from '../lib/journal-service.js';
import { FetchTutorLLM } from '../lib/tutor-llm.js';
import { useLexicon } from '../lib/useLexicon.js';
import { useMyClass } from '../lib/my-class.js';
import { useTextbook } from '../lib/textbook-data.js';
import { useSetting } from '../lib/useSetting.js';
import './JournalPage.css';

const TYPE_LABEL: Record<JournalIssue['type'], string> = {
  error: 'Error',
  unnatural: 'Unnatural',
  mainland_style: 'Mainland wording',
};

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
  onDone,
}: { initialPromptId?: string; lesson?: number; onDone?: () => void } = {}) {
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

  const dailyP = useMemo(() => dailyPrompt(new Date()), []);
  // Phase 12: while "My class" is on, the current lesson's prompts come first.
  const myClass = useMyClass();
  const textbookState = useTextbook();
  const classPrompts = useMemo(
    () =>
      myClass.enabled && textbookState.status === 'ready'
        ? (textbookState.book.lessons[(lesson ?? myClass.currentLesson) - 1]?.journalPrompts ?? [])
        : [],
    [myClass, textbookState, lesson],
  );
  const [donePromptIds, setDonePromptIds] = useState<Set<string>>(new Set());
  const [chosenId, setChosenId] = useState<string | null>(initialPromptId ?? null);
  useEffect(() => {
    db.journalEntries
      .where('status')
      .equals('finished')
      .toArray()
      .then((rows) => setDonePromptIds(new Set(rows.flatMap((r) => (r.promptId ? [r.promptId] : [])))))
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
    return pickPromptWords(dueCards, lexiconState.lexicon, new Date(), 3, learnerLevel);
  }, [lexiconState, dueCards, learnerLevel, chosenClass]);
  const grammarHints = useMemo(
    () =>
      lexiconState.status === 'ready' && chosenClass
        ? chosenClass.useGrammar.flatMap((id) => lexiconState.lexicon.grammarItemById(id)?.pattern ?? [])
        : [],
    [lexiconState, chosenClass],
  );

  const reload = useCallback(
    async (id: string) => {
      if (!service) return;
      const [e, r] = await Promise.all([service.getEntry(id), service.getReview(id)]);
      setEntry(e ?? null);
      setReview(r ?? null);
    },
    [service],
  );

  // Resume an unfinished entry, and pick the learner's level + prompt words.
  useEffect(() => {
    if (lexiconState.status !== 'ready' || !service) return;
    let cancelled = false;
    (async () => {
      const now = new Date();
      const [due, entries] = await Promise.all([
        learnerService.dueCards(now, 200),
        db.journalEntries.where('status').notEqual('finished').sortBy('createdAt'),
      ]);
      if (cancelled) return;
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
            <p>
              <span className="textbook-badge" lang="zh-Hant">
                {lessonBadge(lesson ?? myClass.currentLesson)}
              </span>{' '}
              Prompts from class
            </p>
            <div role="radiogroup" aria-label="Choose a prompt">
              {classPrompts.map((p, i) => (
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
      });
      setText(''); // submitted: the draft is done
      onSubmitted(entry, review);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
                <span className="journal-muted">{w.glossEn}</span>
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
      />
      <p className="journal-muted">
        Don&apos;t know a word? Write it in English inside brackets, like{' '}
        <code>今天我去 [gym]</code>, and we&apos;ll translate it and add it to your practice.
      </p>
      {error && (
        <p role="alert" className="journal-error">
          {error}
        </p>
      )}
      <button onClick={submit} disabled={busy || !text.trim()}>
        {busy ? 'Checking…' : 'Submit for feedback'}
      </button>
    </section>
  );
}

/** Splits `text` into plain and highlighted runs for the given issues. */
function HighlightedText({ text, issues }: { text: string; issues: JournalIssue[] }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  issues.forEach((issue, i) => {
    if (issue.span[0] > cursor) parts.push(text.slice(cursor, issue.span[0]));
    parts.push(
      <mark
        key={i}
        className={`journal-hl journal-hl--${issue.type}`}
        title={TYPE_LABEL[issue.type]}
        data-issue={i}
      >
        {text.slice(issue.span[0], issue.span[1])}
      </mark>,
    );
    cursor = issue.span[1];
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return (
    <p className="journal-text" lang="zh-Hant">
      {parts}
    </p>
  );
}

function Legend() {
  return (
    <p className="journal-legend">
      <mark className="journal-hl journal-hl--error">error</mark>{' '}
      <mark className="journal-hl journal-hl--unnatural">unnatural</mark>{' '}
      <mark className="journal-hl journal-hl--mainland_style">mainland wording</mark>
    </p>
  );
}

function BracketList({ review }: { review: JournalReviewRow }) {
  if (review.brackets.length === 0) return null;
  return (
    <div className="journal-brackets">
      <h3>Gaps filled in</h3>
      <ul>
        {review.brackets.map((b) => (
          <li key={b.en}>
            [{b.en}] →{' '}
            {b.zh ? (
              <>
                <strong lang="zh-Hant">
                  <Zh text={b.zh} />
                </strong>{' '}
                <span className="journal-muted">
                  ({b.source === 'lexicon' ? 'dictionary' : 'tutor suggestion'}; added to your next
                  review)
                </span>
              </>
            ) : (
              <span className="journal-muted">no good translation found — look this one up</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SelfCorrectStage({
  service,
  entry,
  review,
  onChange,
}: {
  service: JournalService;
  entry: JournalEntryRow;
  review: JournalReviewRow;
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

  return (
    <section className="journal-correct">
      <h2>Spot the mistakes</h2>
      <p>
        {review.issues.length === 1 ? 'One part' : `${review.issues.length} parts`} of your entry
        might need another look. Try fixing {review.issues.length === 1 ? 'it' : 'them'} yourself
        before seeing the answers.
      </p>
      <Legend />
      <HighlightedText text={entry.text} issues={review.issues} />
      <BracketList review={review} />
      <ol className="journal-fixes">
        {review.issues.map((issue, i) => {
          const result = results[i];
          return (
            <li key={i}>
              <span className={`journal-hl journal-hl--${issue.type}`}>
                {TYPE_LABEL[issue.type]}
              </span>
              <input
                lang="zh-Hant"
                value={attempts[i] ?? ''}
                onChange={(e) => setAttempts((a) => ({ ...a, [i]: e.target.value }))}
                aria-label={`Your fix for part ${i + 1}`}
              />
              <button onClick={() => check(i)} disabled={busy === i}>
                {busy === i ? 'Checking…' : 'Check'}
              </button>
              {result && (
                <span className={result.fixed ? 'journal-ok' : 'journal-muted'} role="status">
                  {result.fixed ? '✓ Looks good' : 'Not there yet'}
                  {result.note && ` — ${result.note}`}
                </span>
              )}
            </li>
          );
        })}
      </ol>
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
  onChange,
  onFinished,
}: {
  service: JournalService;
  entry: JournalEntryRow;
  review: JournalReviewRow;
  promptWords: Word[];
  lexicon: Lexicon;
  onChange: () => void;
  onFinished: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function flag(i: number) {
    await service.toggleFlag(entry.id, i);
    onChange();
  }

  async function finish() {
    await service.finish(entry.id);
    onFinished();
  }

  return (
    <section className="journal-reveal">
      <h2>Feedback</h2>
      <HighlightedText text={entry.text} issues={review.issues} />
      <BracketList review={review} />
      {Object.keys(review.selfFix).length > 0 && (
        <p className="journal-muted">Parts you fixed yourself are marked ✓ — nicely done.</p>
      )}

      {review.issues.length === 0 && <p>Nothing stood out to correct. Nice writing!</p>}
      <ol className="journal-issues">
        {review.issues.map((issue, i) => {
          const flagged = review.flagged.includes(i);
          const fixed = review.selfFix[i]?.fixed;
          const more = review.explainMore[i];
          return (
            <li
              key={i}
              className={flagged ? 'journal-issue journal-issue--flagged' : 'journal-issue'}
            >
              <div>
                <span className={`journal-hl journal-hl--${issue.type}`}>
                  {TYPE_LABEL[issue.type]}
                </span>{' '}
                {fixed && <span className="journal-ok">✓ You fixed this yourself</span>}{' '}
                <span className="journal-muted">confidence: {issue.confidence}</span>
              </div>
              <p lang="zh-Hant">
                <del>{entry.text.slice(...issue.span)}</del> →{' '}
                <strong>
                  <Zh text={issue.correction} />
                </strong>
              </p>
              <p>{issue.explanationEn}</p>
              {review.selfFix[i]?.alternative && review.selfFix[i]?.note && (
                <p className="journal-muted">Your version: {review.selfFix[i]!.note}</p>
              )}
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
                <button onClick={() => flag(i)} aria-pressed={flagged}>
                  {flagged ? 'Flagged — won’t be practised (undo)' : 'Flag this correction'}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
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
            Your gaps: {renderBracketsInline(entry.text, inline)}
          </p>
        )}
      </div>

      <button onClick={finish}>Finish entry</button>
    </section>
  );
}
