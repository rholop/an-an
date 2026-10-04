import { useEffect, useMemo, useState } from 'react';
import {
  classScope,
  levelIndex,
  buildClozeExercise,
  buildErrorCloze,
  buildLePlacementExercise,
  buildMainlandVsTaiwanExercise,
  buildMultipleChoiceOptions,
  buildReorderExercise,
  buildMixedSession,
  buildWordBankOptions,
  gradeClozeAnswer,
  gradeErrorAnswer,
  reviewErrorItem,
  selectDueErrorItems,
  type ChoiceOption,
  type ClozeInputMode,
  type ErrorItem,
  type JournalSentenceSource,
  type Lexicon,
  type Level,
  type NaturalPairExercise,
  type SessionEntry,
  type SessionItem,
} from '@anan/core';
import { db, gameService, learnerService } from '../db/instance.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { allChatLines, allJournalSentences } from '../db/queries.js';
import { useLexicon } from '../lib/useLexicon.js';
import { useScenarios } from '../lib/useScenarios.js';
import { useSentenceBank } from '../lib/useSentenceBank.js';
import { useMyClass } from '../lib/my-class.js';
import { sentenceOrdinal, useTextbookSentences } from '../lib/textbook-data.js';
import './ClozePage.css';

type Outcome = 'correct' | 'correct_wrong_tone' | 'wrong';

function evidenceKindFor(
  outcome: Outcome,
): 'cloze_correct_nohint' | 'cloze_correct_hint' | 'cloze_wrong' {
  if (outcome === 'correct') return 'cloze_correct_nohint';
  if (outcome === 'correct_wrong_tone') return 'cloze_correct_hint';
  return 'cloze_wrong';
}

/** 1 in 3 rung-3 (typed) items with an available sentence becomes a reorder
 * exercise instead — phase doc §5's "exercise variety... reuse same
 * infrastructure", interleaved into the main ladder rather than bolted on
 * as a disconnected screen, so it still has a clear item/card to grade. */
function useReorderSubstitution(item: SessionItem | undefined): boolean {
  return useMemo(() => {
    if (!item || item.exerciseKind !== 'typed' || !item.source) return false;
    // Deterministic-ish on the item id so it doesn't flicker on re-render.
    let hash = 0;
    for (const ch of item.card.item.id) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
    return hash % 3 === 0;
  }, [item]);
}

export function ClozePage() {
  const lexiconState = useLexicon();
  const scenariosState = useScenarios();

  const [dueCards, setDueCards] = useState<Awaited<
    ReturnType<typeof learnerService.dueCards>
  > | null>(null);
  const [knownIds, setKnownIds] = useState<Set<string> | null>(null);
  const [chatLines, setChatLines] = useState<Awaited<ReturnType<typeof allChatLines>> | null>(null);
  const [journalSentences, setJournalSentences] = useState<JournalSentenceSource[] | null>(null);
  const [errorItems, setErrorItems] = useState<ErrorItem[] | null>(null);
  // Phase 7: the global "My level" — never hides due reviews, only steers
  // sentence-level preference and the new-item pool.
  const { level: learnerLevel } = useCurrentLevel();

  useEffect(() => {
    if (lexiconState.status !== 'ready' || scenariosState.status !== 'ready') return;
    let cancelled = false;
    (async () => {
      const now = new Date();
      const [due, known, lines, journal, errors] = await Promise.all([
        learnerService.dueCards(now, 200),
        learnerService.knownSet('review'),
        allChatLines(db, scenariosState.scenarios),
        allJournalSentences(db),
        db.errorItems.toArray(),
      ]);
      if (cancelled) return;
      setJournalSentences(journal);
      setErrorItems(errors);
      setDueCards(due);
      setKnownIds(known);
      setChatLines(lines);
    })();
    return () => {
      cancelled = true;
    };
  }, [lexiconState.status, scenariosState.status]);

  const neededLevels = useMemo(() => {
    if (!dueCards || lexiconState.status !== 'ready') return [];
    const levels = new Set<Level>();
    for (const card of dueCards) {
      if (card.item.kind !== 'word') continue;
      const word = lexiconState.lexicon.byId(card.item.id);
      if (word?.level) levels.add(word.level);
    }
    return [...levels];
  }, [dueCards, lexiconState]);
  const sentenceBankState = useSentenceBank(neededLevels);
  // Phase 12: the lesson sentences (lessons up to the class's current one) join the bank while My class is on.
  const myClass = useMyClass();
  const textbookSentences = useTextbookSentences(myClass.enabled);

  const [session, setSession] = useState<SessionEntry[] | null>(null);
  const [index, setIndex] = useState(0);
  const [tally, setTally] = useState({ correct: 0, hinted: 0, wrong: 0 });
  const [showBonus, setShowBonus] = useState(false);

  const ready =
    lexiconState.status === 'ready' &&
    scenariosState.status === 'ready' &&
    sentenceBankState.status === 'ready' &&
    textbookSentences.status === 'ready' &&
    dueCards !== null &&
    knownIds !== null &&
    chatLines !== null &&
    journalSentences !== null &&
    errorItems !== null;
  const dueErrorCount = errorItems
    ? selectDueErrorItems(errorItems, new Date(), Infinity).length
    : 0;

  function startSession() {
    if (!ready || lexiconState.status !== 'ready' || sentenceBankState.status !== 'ready') return;
    const built = buildMixedSession(dueCards!, {
      lexicon: lexiconState.lexicon,
      knownIds: knownIds!,
      learnerLevel,
      journalSentences: journalSentences!,
      chatLines: chatLines!,
      bankSentences: [
        ...sentenceBankState.sentences,
        ...(myClass.enabled && textbookSentences.status === 'ready'
          ? textbookSentences.sentences.filter(
              (x) =>
                (sentenceOrdinal(x) ?? 0) <= classScope(myClass).currentLesson &&
                levelIndex(x.level) <= levelIndex(learnerLevel),
            )
          : []),
      ],
      errorItems: errorItems!,
      now: new Date(),
    });
    setSession(built);
    setIndex(0);
    setTally({ correct: 0, hinted: 0, wrong: 0 });
    setShowBonus(false);
  }

  async function recordOutcome(item: SessionItem, outcome: Outcome) {
    const now = new Date();
    await learnerService.record(
      { item: item.card.item, skill: item.card.skill, kind: evidenceKindFor(outcome), at: now },
      now,
    );
    setTally((t) => ({
      correct: t.correct + (outcome === 'correct' ? 1 : 0),
      hinted: t.hinted + (outcome === 'correct_wrong_tone' ? 1 : 0),
      wrong: t.wrong + (outcome === 'wrong' ? 1 : 0),
    }));
  }

  /** Phase 5 §7: an error-bank answer reschedules the error item's own FSRS
   * card. It deliberately writes no learner Evidence — an error item is a
   * sentence-level drill, not a vocabulary-item review. */
  async function recordErrorOutcome(error: ErrorItem, outcome: 'correct' | 'wrong') {
    const at = new Date();
    await db.errorItems.put(reviewErrorItem(error, outcome, at));
    if (outcome === 'correct') await gameService.onErrorFixed(error.id, at);
    setTally((t) => ({
      ...t,
      correct: t.correct + (outcome === 'correct' ? 1 : 0),
      wrong: t.wrong + (outcome === 'wrong' ? 1 : 0),
    }));
  }

  function next() {
    setIndex((i) => i + 1);
  }

  if (lexiconState.status === 'loading' || scenariosState.status === 'loading')
    return <p>Loading…</p>;
  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;
  if (scenariosState.status === 'error')
    return <p>Failed to load scenarios: {scenariosState.error}</p>;

  if (!session) {
    return (
      <div className="cloze-page">
        <h1>Cloze review</h1>
        {!ready ? (
          <p>Loading your review queue…</p>
        ) : dueCards!.length === 0 && dueErrorCount === 0 ? (
          <p>Nothing due right now — nice work.</p>
        ) : (
          <>
            <p className="cloze-level-note">Your level: {learnerLevel}</p>
            {dueErrorCount > 0 && (
              <p className="cloze-level-note">
                {dueErrorCount} sentence{dueErrorCount === 1 ? '' : 's'} from your journal
                corrections {dueErrorCount === 1 ? 'is' : 'are'} due.
              </p>
            )}
            <button onClick={startSession}>
              Start session ({Math.min(dueCards!.length + dueErrorCount, 20)} items)
            </button>
          </>
        )}
      </div>
    );
  }

  const entry = session[index];

  if (!entry) {
    return (
      <div className="cloze-page">
        <h1>Session complete</h1>
        <ul className="cloze-summary">
          <li>{tally.correct} correct, no hint</li>
          <li>{tally.hinted} right word, wrong tone</li>
          <li>{tally.wrong} wrong</li>
        </ul>
        <button onClick={() => setSession(null)}>Back</button>
        <button onClick={() => setShowBonus((v) => !v)}>
          {showBonus ? 'Hide' : 'Show'} bonus practice
        </button>
        {showBonus && <BonusPractice />}
      </div>
    );
  }

  if (entry.kind === 'error') {
    return (
      <div className="cloze-page">
        <div className="cloze-header">
          <span>
            Item {index + 1} / {session.length}
          </span>
          <span className="cloze-badge">From your journal</span>
          {entry.error.pattern && <span className="cloze-badge">{entry.error.pattern}</span>}
        </div>
        <ErrorClozeView
          key={entry.error.id}
          error={entry.error}
          onAnswer={(outcome) => recordErrorOutcome(entry.error, outcome)}
          onNext={next}
        />
      </div>
    );
  }

  const item = entry.item;

  return (
    <div className="cloze-page">
      <div className="cloze-header">
        <span>
          Item {index + 1} / {session.length}
        </span>
        <span className="cloze-badge">Rung {item.card.clozeRung}</span>
        <span className="cloze-badge">{item.card.skill}</span>
      </div>
      {item.source && <div className="cloze-source-label">{item.source.sourceLabel}</div>}

      <ExerciseView
        key={item.card.item.id + index}
        item={item}
        lexicon={lexiconState.lexicon}
        onAnswer={(outcome) => recordOutcome(item, outcome)}
        onNext={next}
      />
    </div>
  );
}

function ExerciseView({
  item,
  lexicon,
  onAnswer,
  onNext,
}: {
  item: SessionItem;
  lexicon: Lexicon;
  onAnswer: (o: Outcome) => void;
  onNext: () => void;
}) {
  const [answered, setAnswered] = useState<Outcome | null>(null);
  const useReorder = useReorderSubstitution(item);
  const handleAnswer = (o: Outcome) => {
    setAnswered(o);
    onAnswer(o);
  };

  const exercise = item.source ? buildClozeExercise(item.word, item.source, lexicon) : null;

  if (item.exerciseKind === 'typed' && useReorder && item.source) {
    return (
      <ReorderExerciseView
        item={item}
        lexicon={lexicon}
        answered={answered}
        onAnswer={handleAnswer}
        onNext={onNext}
      />
    );
  }

  if (item.exerciseKind === 'typed') {
    return (
      <TypedExerciseView
        item={item}
        exercise={exercise}
        answered={answered}
        onAnswer={handleAnswer}
        onNext={onNext}
      />
    );
  }

  return (
    <ChoiceExerciseView
      item={item}
      lexicon={lexicon}
      exercise={exercise}
      answered={answered}
      onAnswer={handleAnswer}
      onNext={onNext}
    />
  );
}

function ErrorClozeView({
  error,
  onAnswer,
  onNext,
}: {
  error: ErrorItem;
  onAnswer: (o: 'correct' | 'wrong') => void;
  onNext: () => void;
}) {
  const cloze = buildErrorCloze(error);
  const [typed, setTyped] = useState('');
  const [answered, setAnswered] = useState<'correct' | 'wrong' | null>(null);

  function submit() {
    if (answered || !typed.trim()) return;
    const outcome = gradeErrorAnswer(typed, error);
    setAnswered(outcome);
    onAnswer(outcome);
  }

  return (
    <div className="cloze-exercise">
      <div className="cloze-source-label">from a sentence you corrected in your journal</div>
      <SentenceWithBlank sentence={cloze.sentence} start={cloze.blankStart} end={cloze.blankEnd} />
      <p className="cloze-prompt">Fill in the blank with the corrected wording.</p>
      <div className="cloze-input-row">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          disabled={answered !== null}
          placeholder="中文…"
          aria-label="Corrected wording"
          lang="zh-Hant-TW"
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button onClick={submit} disabled={answered !== null || !typed.trim()}>
          Submit
        </button>
      </div>
      {answered && (
        <div className={`cloze-feedback cloze-feedback--${answered}`}>
          <p>
            {answered === 'correct'
              ? '✓ Correct!'
              : `✗ Not quite — the corrected sentence is ${cloze.sentence}`}
          </p>
          <button onClick={onNext}>Next</button>
        </div>
      )}
    </div>
  );
}

function SentenceWithBlank({
  sentence,
  start,
  end,
}: {
  sentence: string;
  start: number;
  end: number;
}) {
  return (
    <p className="cloze-sentence">
      {sentence.slice(0, start)}
      <span className="cloze-blank">____</span>
      {sentence.slice(end)}
    </p>
  );
}

function ChoiceExerciseView({
  item,
  lexicon,
  exercise,
  answered,
  onAnswer,
  onNext,
}: {
  item: SessionItem;
  lexicon: Lexicon;
  exercise: ReturnType<typeof buildClozeExercise>;
  answered: Outcome | null;
  onAnswer: (o: Outcome) => void;
  onNext: () => void;
}) {
  const [options] = useState<ChoiceOption[]>(() =>
    item.exerciseKind === 'word_bank'
      ? buildWordBankOptions(item.word, lexicon)
      : buildMultipleChoiceOptions(item.word, lexicon),
  );
  const [picked, setPicked] = useState<string | null>(null);

  function choose(option: ChoiceOption) {
    if (answered) return;
    setPicked(option.word.id);
    onAnswer(option.isCorrect ? 'correct' : 'wrong');
  }

  return (
    <div className="cloze-exercise">
      {exercise ? (
        <SentenceWithBlank
          sentence={exercise.sentence}
          start={exercise.blankStart}
          end={exercise.blankEnd}
        />
      ) : (
        <p className="cloze-prompt">
          Which word means: <strong>{item.word.glossEn || '(no gloss)'}</strong>?
        </p>
      )}
      <div className="cloze-options">
        {options.map((o) => (
          <button
            key={o.word.id}
            className={`cloze-chip ${answered && o.isCorrect ? 'cloze-chip--correct' : ''} ${answered && picked === o.word.id && !o.isCorrect ? 'cloze-chip--wrong' : ''}`}
            disabled={Boolean(answered)}
            onClick={() => choose(o)}
          >
            {o.word.headword}
          </button>
        ))}
      </div>
      {answered && (
        <Feedback
          outcome={answered}
          word={item.word}
          onNext={onNext}
          sentenceZh={item.source?.zh}
        />
      )}
    </div>
  );
}

function TypedExerciseView({
  item,
  exercise,
  answered,
  onAnswer,
  onNext,
}: {
  item: SessionItem;
  exercise: ReturnType<typeof buildClozeExercise>;
  answered: Outcome | null;
  onAnswer: (o: Outcome) => void;
  onNext: () => void;
}) {
  const [mode, setMode] = useState<ClozeInputMode>(
    item.card.skill === 'production' ? 'hanzi' : 'pinyin',
  );
  const [typed, setTyped] = useState('');

  function submit() {
    if (answered || !typed.trim()) return;
    onAnswer(gradeClozeAnswer(typed, item.word, mode));
  }

  return (
    <div className="cloze-exercise">
      {exercise ? (
        <SentenceWithBlank
          sentence={exercise.sentence}
          start={exercise.blankStart}
          end={exercise.blankEnd}
        />
      ) : (
        <p className="cloze-prompt">
          {mode === 'hanzi' ? (
            <>
              Type the Chinese word for: <strong>{item.word.glossEn}</strong>
            </>
          ) : (
            <>
              Type the reading of: <strong lang="zh-Hant">{item.word.headword}</strong>
            </>
          )}
        </p>
      )}
      <div className="cloze-mode-toggle">
        {(['hanzi', 'pinyin', 'zhuyin'] as const).map((m) => (
          <button
            key={m}
            className={mode === m ? 'cloze-mode--active' : ''}
            onClick={() => setMode(m)}
            disabled={Boolean(answered)}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="cloze-input-row">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          disabled={Boolean(answered)}
          placeholder={
            mode === 'hanzi' ? '中文…' : mode === 'pinyin' ? 'ni3 hao3 / nǐ hǎo' : 'ㄋㄧˇ ㄏㄠˇ'
          }
          // iPhone: no auto-capitals / auto-correct on a typed answer, the right
          // Chinese keyboard, and a "done" key. (inputMode keeps Latin keyboards for pinyin.)
          lang={mode === 'pinyin' ? 'en' : 'zh-Hant-TW'}
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button onClick={submit} disabled={Boolean(answered) || !typed.trim()}>
          Submit
        </button>
      </div>
      {answered && (
        <Feedback
          outcome={answered}
          word={item.word}
          onNext={onNext}
          sentenceZh={item.source?.zh}
        />
      )}
    </div>
  );
}

function ReorderExerciseView({
  item,
  lexicon,
  answered,
  onAnswer,
  onNext,
}: {
  item: SessionItem;
  lexicon: Lexicon;
  answered: Outcome | null;
  onAnswer: (o: Outcome) => void;
  onNext: () => void;
}) {
  const [exercise] = useState(() => buildReorderExercise(item.source!.zh, lexicon));
  const order = exercise.shuffled;
  const [picked, setPicked] = useState<number[]>([]);

  function pick(i: number) {
    if (answered || picked.includes(i)) return;
    setPicked((p) => [...p, i]);
  }

  function submit() {
    if (answered || picked.length !== order.length) return;
    const attempt = picked.map((i) => order[i]);
    const correct = attempt.join('') === exercise.correctOrder.join('');
    onAnswer(correct ? 'correct' : 'wrong');
  }

  return (
    <div className="cloze-exercise">
      <p className="cloze-prompt">Put the sentence back in order:</p>
      <div className="cloze-reorder-answer">{picked.map((i) => order[i]).join('') || ' '}</div>
      <div className="cloze-options">
        {order.map((token, i) => (
          <button
            key={i}
            className="cloze-chip"
            disabled={Boolean(answered) || picked.includes(i)}
            onClick={() => pick(i)}
          >
            {token}
          </button>
        ))}
      </div>
      {!answered && (
        <button onClick={submit} disabled={picked.length !== order.length}>
          Submit
        </button>
      )}
      {answered && (
        <Feedback
          outcome={answered}
          word={item.word}
          onNext={onNext}
          sentenceZh={item.source?.zh}
          correctTextOverride={exercise.correctOrder.join('')}
        />
      )}
    </div>
  );
}

function Feedback({
  outcome,
  word,
  onNext,
  correctTextOverride,
  sentenceZh,
}: {
  outcome: Outcome;
  word: SessionItem['word'];
  onNext: () => void;
  correctTextOverride?: string;
  /** The full sentence the exercise came from: its clip (if any) plays after answering. */
  sentenceZh?: string;
}) {
  return (
    <div className={`cloze-feedback cloze-feedback--${outcome}`}>
      <p>
        {outcome === 'correct' && '✓ Correct!'}
        {outcome === 'correct_wrong_tone' && `Right word, wrong tone — it's ${word.pinyin}`}
        {outcome === 'wrong' &&
          `✗ Wrong — it's ${correctTextOverride ?? `${word.headword} (${word.pinyin})`}`}
      </p>
      <div className="cloze-audio">
        {sentenceZh && <SpeakerButton kind="sentence" text={sentenceZh} label="the sentence" />}
        <SpeakerButton kind="word" id={word.id} label={word.headword} />
      </div>
      <button onClick={onNext}>Next</button>
    </div>
  );
}

function BonusPractice() {
  const [kind, setKind] = useState<'mainland' | 'le' | null>(null);
  const [exercise, setExercise] = useState<NaturalPairExercise | null>(null);
  const [revealed, setRevealed] = useState(false);

  function start(k: 'mainland' | 'le') {
    setKind(k);
    setExercise(k === 'mainland' ? buildMainlandVsTaiwanExercise() : buildLePlacementExercise());
    setRevealed(false);
  }

  return (
    <div className="cloze-bonus">
      <p>Untracked extra practice — not scheduled by your review queue.</p>
      <div className="cloze-options">
        <button onClick={() => start('mainland')}>Taiwan vs. Mainland</button>
        <button onClick={() => start('le')}>了-placement</button>
      </div>
      {kind && exercise && (
        <div className="cloze-exercise">
          <p className="cloze-prompt">
            {kind === 'mainland' ? 'Which is used in Taiwan?' : 'Which sentence is correct?'}
          </p>
          <div className="cloze-options">
            <button onClick={() => setRevealed(true)}>{exercise.optionA}</button>
            <button onClick={() => setRevealed(true)}>{exercise.optionB}</button>
          </div>
          {revealed && (
            <p className="cloze-bonus-answer">
              Correct: {exercise.correctIndex === 0 ? exercise.optionA : exercise.optionB}
              {exercise.note && <> — {exercise.note}</>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
