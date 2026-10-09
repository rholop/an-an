import { useRef, useState } from 'react';
import { useKeyboardShortcut } from '../lib/keyboard-shortcuts.js';
import {
  gradeSentenceDictation,
  gradeWordDictation,
  listeningEvidenceKind,
  type DictationOutcome,
  type Exercise,
  type Lexicon,
  type Word,
} from '@anan/core';
import { getSlow, playUrl, setSlow } from '../lib/audio.js';
import { useProfile } from './ProfileGate.js';
import { AnnotatedInline } from './AnnotatedInline.js';
import type { AnnotationScript } from './AnnotatedText.js';
import { FEEDBACK_CORRECT, FEEDBACK_WRONG_TONE, NEXT } from '../lib/labels.js';
import { readingText, useAnswerInputMode, useReadingSettings } from '../lib/reading.js';
import { reportClip } from '../lib/report-actions.js';
import { REPORT_LABEL } from '../lib/labels.js';
import './ListenExercise.css';

export interface ListenResult {
  /** Evidence to record: one per (word, kind). Empty = skipped ("Sounds wrong"): no penalty. */
  evidence: Array<{ wordId: string; kind: ReturnType<typeof listeningEvidenceKind> }>;
  skipped?: boolean;
  correct: boolean;
}

interface Clip {
  url: string;
  kind: 'word' | 'sentence';
  id: string;
  hash: string;
  text: string;
}

type InputMode = 'hanzi' | 'pinyin' | 'zhuyin';

/** Every exercise starts with a Play button the learner taps — nothing autoplays. */
export function ListenExercise({
  exercise,
  lexicon,
  clipFor,
  wordIdOf,
  onDone,
}: {
  exercise: Exercise;
  lexicon: Lexicon;
  /** The clip this exercise plays (null = no usable clip: the runner skips it). */
  clipFor: (e: Exercise, which?: 'a' | 'b') => Clip | null;
  /** Items that receive evidence for this exercise. */
  wordIdOf: (e: Exercise) => string[];
  onDone: (r: ListenResult) => void;
}) {
  const { profile } = useProfile();
  const { script } = useReadingSettings();
  const clip = clipFor(exercise);
  const [plays, setPlays] = useState(0);
  const [slowUsed, setSlowUsed] = useState(false);
  const [slow, setSlowState] = useState(getSlow);
  const [error, setError] = useState(false);
  const [answered, setAnswered] = useState<null | { correct: boolean; outcome: DictationOutcome; note?: string; evidence: ListenResult['evidence'] }>(null);
  const usage = () => ({ replays: Math.max(0, plays - 1), slow: slowUsed });
  const done = useRef(false);
  const [diff, setDiff] = useState<DiffPartLike[] | null>(null);

  async function play(forceSlow?: boolean) {
    if (!clip) return;
    const s = forceSlow ?? slow;
    setError(false);
    try {
      await playUrl(clip.url, s);
      setPlays((p) => p + 1);
      if (s) setSlowUsed(true);
    } catch {
      setError(true);
    }
  }

  function soundsWrong() {
    if (!clip || done.current) return;
    done.current = true;
    // Phase 21: the shared report (with Undo; sent once the Undo window has passed).
    reportClip({ kind: clip.kind, id: clip.id, hash: clip.hash, status: 'flagged', text: clip.text, profileId: profile.id });
    onDone({ evidence: [], skipped: true, correct: false });
  }

  function finish(outcome: DictationOutcome, wordIds: string[], note?: string) {
    const kind = listeningEvidenceKind(outcome, usage());
    setAnswered({
      correct: outcome !== 'wrong',
      outcome,
      ...(note ? { note } : {}),
      evidence: wordIds.map((wordId) => ({ wordId, kind })),
    });
  }

  const next = () => {
    if (done.current || !answered) return;
    done.current = true;
    onDone({ evidence: answered.evidence, correct: answered.outcome === 'correct' });
  };

  useKeyboardShortcut('play-audio', () => void play(), true);
  useKeyboardShortcut('next', next, Boolean(answered));

  const word = (id: string): Word | undefined => lexicon.byId(id);
  const targets = wordIdOf(exercise);

  return (
    <div className="listen-exercise" data-testid="listen-exercise" data-type={exercise.type}>
      <div className="listen-controls">
        <button type="button" className="listen-play" onClick={() => void play()} disabled={!clip} data-testid="listen-play">
          ▶ {plays === 0 ? 'Play' : 'Replay'}
        </button>
        <button
          type="button"
          aria-pressed={slow}
          onClick={() => {
            setSlow(!slow);
            setSlowState(!slow);
          }}
          title="Slow (0.75×) — counts like a replay"
        >
          slow
        </button>
        <button type="button" onClick={() => void play(true)} disabled={!clip} data-testid="listen-slow-play">
          ▶ slow
        </button>
        <button type="button" className="listen-wrong" onClick={soundsWrong} data-testid="listen-sounds-wrong">
          {REPORT_LABEL}
        </button>
      </div>
      {plays > 0 && <p className="listen-meta">Plays: {plays}</p>}
      {error && <p className="listen-meta">Not available offline yet.</p>}

      {exercise.type === 'hear_pick' && (
        <Options
          prompt="Which word did you hear?"
          options={exercise.options}
          answer={exercise.answer}
          disabled={plays === 0 || answered !== null}
          onPick={(o) => finish(o === exercise.answer ? 'correct' : 'wrong', targets)}
          lang="zh-Hant"
        />
      )}
      {exercise.type === 'tone_check' && (
        <Options
          prompt="Which tone pattern did you hear?"
          options={exercise.options}
          answer={exercise.answer}
          disabled={plays === 0 || answered !== null}
          onPick={(o) => finish(o === exercise.answer ? 'correct' : 'wrong', targets)}
        />
      )}
      {exercise.type === 'tone_pair' && (
        <TonePairView
          a={word(exercise.a)}
          b={word(exercise.b)}
          script={script}
          play={exercise.play}
          disabled={plays === 0 || answered !== null}
          onPick={(side) => finish(side === exercise.play ? 'correct' : 'wrong', targets)}
        />
      )}
      {exercise.type === 'listen_understand' && (
        <>
          <Options
            prompt="What does it mean?"
            options={exercise.options}
            answer={exercise.answer}
            disabled={plays === 0 || answered !== null}
            onPick={(o) => finish(o === exercise.answer ? 'correct' : 'wrong', targets)}
          />
          {answered && (
            <p lang="zh-Hant" className="listen-reveal">
              <AnnotatedInline text={exercise.zh} lexicon={lexicon} script={script} />
            </p>
          )}
        </>
      )}
      {exercise.type === 'hear_type' && (
        <TypeView
          disabled={plays === 0 || answered !== null}
          onSubmit={(typed) => {
            const w = word(exercise.wordId)!;
            const r = gradeWordDictation(typed, w);
            const note =
              r.outcome === 'wrong_tone'
                ? `${FEEDBACK_WRONG_TONE} (syllable ${r.toneWrongAt.map((i) => i + 1).join(', ')}): ${readingText(w, script)}`
                : undefined;
            finish(r.outcome, targets, note);
          }}
        />
      )}
      {exercise.type === 'sentence_dictation' && (
        <SentenceView
          disabled={plays === 0 || answered !== null}
          onSubmit={(typed) => {
            const r = gradeSentenceDictation(typed, exercise.zh, lexicon);
            // each word of the sentence gets its own listening evidence
            const ev = r.words.flatMap((w) =>
              w.wordId ? [{ wordId: w.wordId, kind: listeningEvidenceKind(w.hit ? 'correct' : 'wrong', usage()) }] : [],
            );
            setAnswered({ correct: r.allCorrect, outcome: r.allCorrect ? 'correct' : 'wrong', evidence: ev });
            setDiff(r.diff);
          }}
        />
      )}
      {diffParts(diff, answered)}

      {answered && (
        <div role="status" className="listen-feedback" data-testid="listen-feedback">
          {answered.outcome === 'correct' && FEEDBACK_CORRECT}
          {answered.outcome === 'wrong_tone' && (answered.note ?? FEEDBACK_WRONG_TONE)}
          {answered.outcome === 'wrong' && exercise.type !== 'sentence_dictation' && (
            <>✗ Not quite — it's <strong lang="zh-Hant">{answerText(exercise, word, script)}</strong></>
          )}
          {exercise.type === 'sentence_dictation' && answered.outcome === 'wrong' && ' ✗ Missed words are marked above.'}{' '}
          <button type="button" onClick={next} data-testid="listen-next">
            {NEXT}
          </button>
          {exercise.type === 'sentence_dictation' && (
            <p lang="zh-Hant" className="listen-reveal">
              <AnnotatedInline text={exercise.zh} lexicon={lexicon} script={script} />
            </p>
          )}
          {(exercise.type === 'hear_pick' || exercise.type === 'hear_type' || exercise.type === 'tone_check') &&
            word(exercise.wordId) && (
              <p lang="zh-Hant" className="listen-reveal">
                <AnnotatedInline text={word(exercise.wordId)!.headword} lexicon={lexicon} script={script} />
              </p>
            )}
        </div>
      )}
    </div>
  );
}

type DiffPartLike = { text: string; status: 'ok' | 'missed' | 'extra' };
function diffParts(d: DiffPartLike[] | null, answered: unknown) {
  if (!d || !answered) return null;
  return (
    <p className="listen-diff" lang="zh-Hant" data-testid="listen-diff">
      {d.map((p, i) => (
        <span key={i} className={`listen-diff--${p.status}`}>
          {p.text}
        </span>
      ))}
    </p>
  );
}

function answerText(e: Exercise, word: (id: string) => Word | undefined, script: AnnotationScript): string {
  switch (e.type) {
    case 'hear_pick':
    case 'tone_check':
    case 'listen_understand':
      return e.answer;
    case 'hear_type': {
      const w = word(e.wordId);
      return w ? `${w.headword} (${readingText(w, script)})` : e.headword;
    }
    case 'tone_pair': {
      const w = word(e.play === 'a' ? e.a : e.b);
      return w ? `${w.headword} (${readingText(w, script)})` : '';
    }
    case 'sentence_dictation':
      return e.zh;
  }
}

function Options({
  prompt,
  options,
  answer,
  disabled,
  onPick,
  lang,
}: {
  prompt: string;
  options: string[];
  answer: string;
  disabled: boolean;
  onPick: (o: string) => void;
  lang?: string;
}) {
  const [picked, setPicked] = useState<string | null>(null);

  useKeyboardShortcut('choice-1', () => { if (!disabled && options[0]) { setPicked(options[0]); onPick(options[0]); } }, !disabled && Boolean(options[0]));
  useKeyboardShortcut('choice-2', () => { if (!disabled && options[1]) { setPicked(options[1]); onPick(options[1]); } }, !disabled && Boolean(options[1]));
  useKeyboardShortcut('choice-3', () => { if (!disabled && options[2]) { setPicked(options[2]); onPick(options[2]); } }, !disabled && Boolean(options[2]));
  useKeyboardShortcut('choice-4', () => { if (!disabled && options[3]) { setPicked(options[3]); onPick(options[3]); } }, !disabled && Boolean(options[3]));

  return (
    <>
      <p>{prompt}</p>
      <div className="listen-options">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            {...(lang ? { lang } : {})}
            disabled={disabled}
            className={picked ? (o === answer ? 'is-right' : o === picked ? 'is-wrong' : '') : ''}
            onClick={() => {
              setPicked(o);
              onPick(o);
            }}
          >
            {o}
          </button>
        ))}
      </div>
    </>
  );
}

function TonePairView({
  a,
  b,
  play,
  disabled,
  onPick,
  script,
}: {
  a: Word | undefined;
  b: Word | undefined;
  script: AnnotationScript;
  play: 'a' | 'b';
  disabled: boolean;
  onPick: (side: 'a' | 'b') => void;
}) {
  const [picked, setPicked] = useState<'a' | 'b' | null>(null);

  useKeyboardShortcut('choice-1', () => { if (!disabled) { setPicked('a'); onPick('a'); } }, !disabled);
  useKeyboardShortcut('choice-2', () => { if (!disabled) { setPicked('b'); onPick('b'); } }, !disabled);

  const label = (w: Word | undefined) => (w ? `${w.headword} · ${readingText(w, script)}` : '?');
  return (
    <>
      <p>Which of these two did you hear?</p>
      <div className="listen-options">
        {(['a', 'b'] as const).map((s) => (
          <button
            key={s}
            type="button"
            lang="zh-Hant"
            disabled={disabled}
            className={picked ? (s === play ? 'is-right' : s === picked ? 'is-wrong' : '') : ''}
            onClick={() => {
              setPicked(s);
              onPick(s);
            }}
          >
            {label(s === 'a' ? a : b)}
          </button>
        ))}
      </div>
    </>
  );
}

function TypeView({ disabled, onSubmit }: { disabled: boolean; onSubmit: (typed: string) => void }) {
  // Phase 21: the one remembered answer input mode (shared with Cloze and journal items).
  const [inputMode, setInputMode] = useAnswerInputMode();
  const mode: InputMode = inputMode === 'characters' ? 'hanzi' : inputMode;
  const setMode = (m: InputMode) => setInputMode(m === 'hanzi' ? 'characters' : m);
  const [typed, setTyped] = useState('');
  return (
    <>
      <p>Type what you heard.</p>
      <div className="cloze-mode-toggle">
        {(['hanzi', 'pinyin', 'zhuyin'] as const).map((m) => (
          <button key={m} type="button" className={mode === m ? 'cloze-mode--active' : ''} onClick={() => setMode(m)} disabled={disabled}>
            {m}
          </button>
        ))}
      </div>
      <div className="cloze-input-row">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && typed.trim() && !disabled && onSubmit(typed)}
          disabled={disabled}
          aria-label="Your answer"
          placeholder={mode === 'hanzi' ? '中文…' : mode === 'pinyin' ? 'ni3 hao3 / nǐ hǎo' : 'ㄋㄧˇ ㄏㄠˇ'}
          lang={mode === 'pinyin' ? 'en' : 'zh-Hant-TW'}
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="button" onClick={() => onSubmit(typed)} disabled={disabled || !typed.trim()}>
          Submit
        </button>
      </div>
    </>
  );
}

function SentenceView({ disabled, onSubmit }: { disabled: boolean; onSubmit: (typed: string) => void }) {
  const [typed, setTyped] = useState('');
  return (
    <>
      <p>Type the sentence you heard (characters).</p>
      <div className="cloze-input-row">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && typed.trim() && !disabled && onSubmit(typed)}
          disabled={disabled}
          aria-label="Your answer"
          lang="zh-Hant-TW"
          placeholder="中文…"
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="button" onClick={() => onSubmit(typed)} disabled={disabled || !typed.trim()}>
          Submit
        </button>
      </div>
    </>
  );
}
