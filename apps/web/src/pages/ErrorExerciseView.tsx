import { useMemo, useState } from 'react';
import {
  gradeErrorItem,
  type ClozeInputMode,
  type ErrorItem,
  type ItemAnswer,
  type ItemGrade,
  type Lexicon,
  type Reconsidered,
  type Span,
} from '@anan/core';

export type ErrorOutcome = 'correct' | 'hint' | 'wrong';

const PUNCT_TOKEN = /^[\s，。、！？,.!?；;：:「」『』"'（）()…—]+$/;

/** `text` with the changed stretches highlighted (an insertion shows a ▾). */
function Marked({ text, spans, tone }: { text: string; spans: readonly Span[]; tone: 'wrong' | 'right' }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  [...spans]
    .sort((a, b) => a[0] - b[0])
    .forEach(([a, b], i) => {
      parts.push(text.slice(cursor, a));
      parts.push(
        b > a ? (
          <mark key={i} className={`cloze-mark cloze-mark--${tone}`}>
            {text.slice(a, b)}
          </mark>
        ) : (
          <span key={i} className={`cloze-mark cloze-mark--${tone}`} aria-label="something is missing here">
            ▾
          </span>
        ),
      );
      cursor = b;
    });
  parts.push(text.slice(cursor));
  return <span lang="zh-Hant-TW">{parts}</span>;
}

function shuffled<T>(arr: readonly T[], isSame: (a: T[]) => boolean): T[] {
  let out = [...arr];
  for (let attempt = 0; attempt < 5; attempt++) {
    out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    if (arr.length < 2 || !isSame(out)) break;
  }
  return out;
}

/**
 * Phase 17 Part D: one journal review card. The prompt line says what kind of
 * fix this is; after answering, the card always shows what the learner
 * wrote (mistake highlighted), the fully corrected sentence (change
 * highlighted), one line of explanation and the English meaning.
 */
export function ErrorExerciseView({
  item,
  lexicon,
  reconsider,
  onAnswer,
  onRegrade,
  onNext,
}: {
  item: ErrorItem;
  lexicon: Lexicon;
  reconsider: (item: ErrorItem, answer: ItemAnswer) => Promise<Reconsidered>;
  onAnswer: (o: ErrorOutcome) => void;
  /** The learner's answer was accepted after all: the item (now accepting it)
   * is rescheduled as a correct answer, and the wrong grade is undone. */
  onRegrade: (updated: ErrorItem) => void;
  onNext: () => void;
}) {
  const ex = item.exercise!;
  const [grade, setGrade] = useState<ItemGrade | null>(null);
  const [last, setLast] = useState<ItemAnswer | null>(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState(ex.kind === 'fix' ? item.original : '');
  const [mode, setMode] = useState<ClozeInputMode>('hanzi');
  const [placed, setPlaced] = useState<number[]>([]);
  const orderTokens = useMemo(
    () =>
      ex.tokens
        ? shuffled(
            ex.tokens.map((t, i) => ({ t, i })),
            (a) => a.every((x, k) => x.i === k),
          )
        : [],
    [ex.tokens],
  );
  const options = useMemo(() => (ex.options ? shuffled(ex.options, () => false) : []), [ex.options]);

  const done = grade !== null;
  const right = grade === 'correct' || grade === 'correct_wrong_tone';

  async function submit(answer: ItemAnswer) {
    if (done || checking) return;
    setLast(answer);
    const g = gradeErrorItem(item, answer, lexicon);
    if (g === 'needs_check' && ex.kind === 'fix') {
      // "Fix my sentence": the full-sentence check plus "the mistake is gone"
      setChecking(true);
      const res = await reconsider(item, answer).catch(
        (): Reconsidered => ({ accepted: false, reason: "Couldn't run the check just now." }),
      );
      setChecking(false);
      if (res.accepted) {
        setGrade('correct');
        onRegrade(res.item);
      } else {
        setNote(res.reason);
        setGrade('wrong');
        onAnswer('wrong');
      }
      return;
    }
    setGrade(g);
    onAnswer(g === 'correct' ? 'correct' : g === 'correct_wrong_tone' ? 'hint' : 'wrong');
  }

  async function mineToo() {
    if (!last || checking) return;
    setChecking(true);
    const res = await reconsider(item, last).catch(
      (): Reconsidered => ({ accepted: false, reason: "Couldn't run the check just now." }),
    );
    setChecking(false);
    if (res.accepted) {
      setGrade('correct');
      setNote('You\'re right, that works too. Counted as correct.');
      onRegrade(res.item);
    } else setNote(`Still not accepted: ${res.reason}`);
  }

  const blankSentence =
    ex.blankStart !== undefined ? (
      <p className="cloze-sentence" lang="zh-Hant-TW">
        {item.corrected.slice(0, ex.blankStart)}
        <span className="cloze-blank">____</span>
        {item.corrected.slice(ex.blankEnd)}
      </p>
    ) : null;

  return (
    <div className="cloze-exercise">
      <div className="cloze-source-label">from a sentence you wrote in your journal</div>
      <p className="cloze-prompt">{ex.prompt}</p>
      {item.en && <p className="cloze-gloss">{item.en}</p>}

      {ex.kind === 'cloze' && (
        <>
          {blankSentence}
          <div className="cloze-mode-toggle">
            {(['hanzi', 'pinyin', 'zhuyin'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={mode === m ? 'cloze-mode--active' : ''}
                onClick={() => setMode(m)}
                disabled={done}
              >
                {m === 'hanzi' ? '中文' : m === 'pinyin' ? 'pinyin' : 'ㄅㄆㄇ'}
              </button>
            ))}
          </div>
          <div className="cloze-input-row">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) =>
                e.key === 'Enter' && typed.trim() && void submit({ kind: 'text', text: typed, mode })
              }
              disabled={done}
              placeholder={mode === 'hanzi' ? '中文…' : mode === 'pinyin' ? 'pinyin' : 'ㄅㄆㄇ'}
              aria-label="Your answer"
              lang={mode === 'pinyin' ? 'en' : 'zh-Hant-TW'}
              enterKeyHint="done"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              onClick={() => void submit({ kind: 'text', text: typed, mode })}
              disabled={done || !typed.trim()}
            >
              Submit
            </button>
          </div>
        </>
      )}

      {ex.kind === 'choice' && (
        <>
          {blankSentence}
          <div className="cloze-chips">
            {options.map((o) => (
              <button
                key={o}
                className="cloze-chip"
                disabled={done}
                onClick={() => void submit({ kind: 'choice', option: o })}
                lang="zh-Hant-TW"
              >
                {o}
              </button>
            ))}
          </div>
        </>
      )}

      {ex.kind === 'extra_word' && (
        <p className="cloze-sentence" lang="zh-Hant-TW">
          {ex.tokens!.map((t, i) =>
            PUNCT_TOKEN.test(t) ? (
              <span key={i}>{t}</span>
            ) : (
              <button
                key={i}
                className="cloze-token"
                disabled={done}
                onClick={() => void submit({ kind: 'tap', tokenIndex: i })}
              >
                {t}
              </button>
            ),
          )}
        </p>
      )}

      {ex.kind === 'reorder' && (
        <>
          <p className="cloze-sentence" lang="zh-Hant-TW" aria-live="polite">
            {placed.length === 0 ? '…' : placed.map((i) => ex.tokens![i]).join(' ')}
          </p>
          <div className="cloze-chips">
            {orderTokens.map(({ t, i }) => (
              <button
                key={i}
                className="cloze-chip"
                disabled={done || placed.includes(i)}
                onClick={() => setPlaced((p) => [...p, i])}
                lang="zh-Hant-TW"
              >
                {t}
              </button>
            ))}
          </div>
          <div className="cloze-input-row">
            <button onClick={() => setPlaced((p) => p.slice(0, -1))} disabled={done || placed.length === 0}>
              Undo
            </button>
            <button
              onClick={() =>
                void submit({ kind: 'order', tokens: placed.map((i) => ex.tokens![i]!) })
              }
              disabled={done || placed.length !== ex.tokens!.length}
            >
              Check
            </button>
          </div>
        </>
      )}

      {ex.kind === 'fix' && (
        <>
          <p className="cloze-sentence">
            <span lang="zh-Hant-TW">{item.original}</span>
          </p>
          <div className="cloze-input-row">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) =>
                e.key === 'Enter' && typed.trim() && void submit({ kind: 'text', text: typed })
              }
              disabled={done || checking}
              aria-label="Your corrected sentence"
              lang="zh-Hant-TW"
              enterKeyHint="done"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              onClick={() => void submit({ kind: 'text', text: typed })}
              disabled={done || checking || !typed.trim()}
            >
              {checking ? 'Checking…' : 'Submit'}
            </button>
          </div>
        </>
      )}

      {done && (
        <div className={`cloze-feedback cloze-feedback--${right ? 'correct' : 'wrong'}`}>
          <p>{right ? '✓ Correct!' : '✗ Not quite.'}</p>
          <p>
            <strong>You wrote:</strong>{' '}
            <Marked text={item.original} spans={item.marks?.original ?? []} tone="wrong" />
          </p>
          <p>
            <strong>Correct:</strong>{' '}
            <Marked text={item.corrected} spans={item.marks?.corrected ?? []} tone="right" />
          </p>
          {item.explanationEn && <p>{item.explanationEn}</p>}
          {item.en && <p className="cloze-gloss">{item.en}</p>}
          {note && <p role="status">{note}</p>}
          {!right && last && ex.kind !== 'fix' && (
            <button onClick={() => void mineToo()} disabled={checking}>
              {checking ? 'Checking…' : 'I think mine is right too'}
            </button>
          )}
          <button onClick={onNext}>Next</button>
        </div>
      )}
    </div>
  );
}
