import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  glossFor,
  gradeMatch,
  gradePick,
  gradeSort,
  gradeTones,
  gradeTypedReading,
  markTone,
  newSessionSeed,
  PINYIN_EXERCISE_LABELS,
  pinyinSyllableToZhuyinBase,
  planPinyinSession,
  readingEvidence,
  sandhiNotes,
  seededRng,
  seededShuffle,
  toneTroubleByWord,
  wordSyllables,
  zhuyinWithTone,
  type Lexicon,
  type PinyinExercise,
  type PinyinResult,
  type SkillCard,
  type Word,
} from '@anan/core';
import type { AnnotationScript } from '../components/AnnotatedText.js';
import { useReadingScript } from '../components/AnnotatedInline.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import { db, learnerService } from '../db/instance.js';
import { useConfusables, noteConfusion, type ConfusableContext } from '../lib/confusables.js';
import { ensureFaceCards } from '../lib/face-cards.js';
import { FEEDBACK_CORRECT, FEEDBACK_WRONG_TONE, feedbackWrong, NEXT, PINYIN_TAB, toneLabel, UNDO } from '../lib/labels.js';
import { useListeningEnabled } from '../lib/listening.js';
import { readingText } from '../lib/reading.js';
import { useLexicon } from '../lib/useLexicon.js';
import { ListenPage } from './ListenPage.js';
import './ReviewPage.css';
import './PinyinPage.css';

/** Tone buttons: 1st–4th, then neutral (5). */
const TONES = [1, 2, 3, 4, 5] as const;

/** One syllable in the reading script ("lǎo", "ㄌㄠˇ", or both). */
function syllableText(base: string, tone: number, script: AnnotationScript, zhuyinBase?: string): string {
  const py = markTone(base, tone);
  if (script === 'pinyin') return py;
  let zb = zhuyinBase;
  if (!zb) {
    try {
      zb = pinyinSyllableToZhuyinBase(base);
    } catch {
      zb = undefined;
    }
  }
  const zh = zb ? zhuyinWithTone(zb, tone) : '';
  if (script === 'zhuyin') return zh || py;
  return zh ? `${py} · ${zh}` : py;
}

/** A word's reading from syllables (near misses included). */
function syllablesText(syl: { base: string; tone: number }[], script: AnnotationScript): string {
  if (script === 'both')
    return `${syl.map((s) => markTone(s.base, s.tone)).join(' ')} · ${syl.map((s) => syllableText(s.base, s.tone, 'zhuyin')).join(' ')}`;
  return syl.map((s) => syllableText(s.base, s.tone, script)).join(' ');
}

/** What one answered exercise hands back: per-word results (graded once, on the first try). */
type Answer = PinyinResult[];

/**
 * Phase 23 Part C: the "Pinyin & tones" tab. Seven tap-first exercises on the `reading` skill
 * (pinyin and tones from the characters). Questions ask for the dictionary tone; 一, 不 and 3rd + 3rd
 * notes show after the answer. Play buttons are optional, verified clips only, never autoplayed.
 */
export function PinyinPage({ onOpenListen }: { onOpenListen?: () => void } = {}) {
  const lexiconState = useLexicon();
  const lexicon = lexiconState.status === 'ready' ? lexiconState.lexicon : null;
  const confusables = useConfusables(lexicon);
  const script = useReadingScript();
  const listening = useListeningEnabled();
  const [plan, setPlan] = useState<PinyinExercise[] | null>(null);
  const [extra, setExtra] = useState(false);
  const [index, setIndex] = useState(0);
  const [tally, setTally] = useState({ words: 0, right: 0 });
  const [done, setDone] = useState(false);
  const [history, setHistory] = useState<{ index: number; tally: typeof tally; undos: (() => Promise<void>)[] }[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [listen, setListen] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!lexicon || !confusables) return;
    let cancelled = false;
    void (async () => {
      const now = new Date();
      await ensureFaceCards(now);
      const rows = await db.items.filter((c) => c.skill === 'reading').toArray();
      const cards = rows.map(({ pk: _pk, ...c }) => c as SkillCard);
      const since = new Date(now.getTime() - 30 * 86_400_000);
      const ev = await db.evidence.where('at').between(since, now, true, true).toArray();
      const p = planPinyinSession({
        readingCards: cards,
        wordById: (id) => lexicon.byId(id),
        now,
        seed: newSessionSeed('pinyin'),
        trouble: toneTroubleByWord(ev, now),
        confusables: confusables.index,
        preferred: confusables.preferred,
        confusions: confusables.confusions,
        extra,
      });
      if (cancelled) return;
      setPlan(p);
      setIndex(0);
      setTally({ words: 0, right: 0 });
      setHistory([]);
      setDone(false);
    })();
    return () => {
      cancelled = true;
    };
    // a session is planned once per start (and again for "Practise anyway")
  }, [lexicon, !!confusables, extra, round]);

  const answer = useCallback(
    async (results: Answer) => {
      const now = new Date();
      const undos: (() => Promise<void>)[] = [];
      for (const r of results) {
        const h = await learnerService.recordUndoable(readingEvidence(r, now), now);
        undos.push(h.undo);
        if (r.pickedId) noteConfusion(confusables, r.wordId, r.pickedId);
      }
      setHistory((h) => [...h, { index, tally, undos }]);
      setTally((t) => ({ words: t.words + results.length, right: t.right + results.filter((r) => r.kind === 'reading_correct').length }));
    },
    [confusables, index, tally],
  );

  const next = useCallback(() => {
    if (!plan) return;
    if (index + 1 >= plan.length) setDone(true);
    else setIndex(index + 1);
  }, [index, plan]);

  async function undo() {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    for (const u of last.undos) await u();
    setTally(last.tally);
    setIndex(last.index);
    setDone(false);
    setAttempt((a) => a + 1);
  }

  if (listen) return <ListenPage onExit={() => setListen(false)} exitLabel={`← ${PINYIN_TAB}`} />;
  if (!lexicon) return <p>Loading…</p>;
  const ex = plan?.[index];
  return (
    <div className="pinyin-page" data-testid="pinyin-page">
      <h1>{PINYIN_TAB}</h1>
      <p className="textbook-muted">
        Pinyin and tones from the characters. Answers use the dictionary tone; a note says when it changes in speech.
      </p>
      {listening && (
        <p>
          <button
            type="button"
            className="link-button pinyin-listen-link"
            data-testid="pinyin-open-listen"
            onClick={() => (onOpenListen ? onOpenListen() : setListen(true))}
          >
            Listening practice →
          </button>
        </p>
      )}
      {plan === null ? (
        <p>Loading…</p>
      ) : done ? (
        <div role="status" data-testid="pinyin-summary">
          <p>
            Done: {tally.right} of {tally.words} right.{' '}
            {history.length > 0 && (
              <button type="button" className="link-button" onClick={() => void undo()}>
                {UNDO}
              </button>
            )}
          </p>
          <button type="button" className="btn-primary" data-testid="pinyin-again" onClick={() => { setPlan(null); setExtra(true); setRound((r) => r + 1); }}>
            Practise more
          </button>
        </div>
      ) : plan.length === 0 ? (
        <div data-testid="pinyin-empty">
          <p>Nothing due. Words join Pinyin &amp; tones once you start learning them in Review.</p>
          {!extra && (
            <button type="button" data-testid="pinyin-extra" onClick={() => { setPlan(null); setExtra(true); }}>
              Practise anyway
            </button>
          )}
        </div>
      ) : ex ? (
        <>
          <p className="textbook-muted">
            {index + 1} of {plan.length} · <span data-testid="pinyin-kind">{PINYIN_EXERCISE_LABELS[ex.kind]}</span>
            {history.length > 0 && (
              <>
                {' '}
                <button type="button" className="link-button" data-testid="pinyin-undo" onClick={() => void undo()}>
                  {UNDO}
                </button>
              </>
            )}
          </p>
          <Exercise
            key={`${index}:${attempt}`}
            ex={ex}
            script={script}
            lexicon={lexicon}
            confusables={confusables}
            listening={listening}
            onAnswer={(r) => void answer(r)}
            onNext={next}
          />
        </>
      ) : null}
    </div>
  );
}

function Exercise(props: {
  ex: PinyinExercise;
  script: AnnotationScript;
  lexicon: Lexicon;
  confusables: ConfusableContext | null;
  listening: boolean;
  onAnswer: (r: Answer) => void;
  onNext: () => void;
}) {
  const { ex } = props;
  return (
    <div className="pinyin-exercise" data-testid="pinyin-exercise" data-kind={ex.kind}>
      {ex.kind === 'tones' ? (
        <TonesEx {...props} word={ex.word} />
      ) : ex.kind === 'match' ? (
        <MatchEx {...props} words={ex.words} />
      ) : ex.kind === 'chars' || ex.kind === 'lookalike' ? (
        <PickCharsEx {...props} word={ex.word} options={ex.options} lookalike={ex.kind === 'lookalike'} />
      ) : ex.kind === 'type' ? (
        <TypeEx {...props} word={ex.word} />
      ) : ex.kind === 'which' ? (
        <WhichEx {...props} word={ex.word} options={ex.options} />
      ) : (
        <SortEx {...props} words={ex.words} patterns={ex.patterns} />
      )}
    </div>
  );
}

type ExProps = { script: AnnotationScript; listening: boolean; onAnswer: (r: Answer) => void; onNext: () => void };

/** After an answer: the result line, the word's reading and meaning, 一 / 不 / 3+3 notes, Next. */
function AfterAnswer({
  words,
  ok,
  toneOnly,
  script,
  onNext,
  play,
}: {
  words: Word[];
  ok: boolean;
  toneOnly?: boolean;
  script: AnnotationScript;
  onNext: () => void;
  play?: Word;
}) {
  const notes = words.flatMap((w) => sandhiNotes(w));
  return (
    <div className="pinyin-after">
      <p className={`review-typed ${ok ? 'review-typed--ok' : 'review-typed--bad'}`} data-testid="pinyin-result">
        {ok ? FEEDBACK_CORRECT : toneOnly ? FEEDBACK_WRONG_TONE : words.length === 1 ? feedbackWrong(words[0]!.headword, readingText(words[0]!, script)) : '✗ Not all right'}
      </p>
      {words.length === 1 && (
        <p className="pinyin-word-info">
          <span lang="zh-Hant">{words[0]!.headword}</span> {readingText(words[0]!, script)} · {glossFor(words[0]!)}
        </p>
      )}
      {notes.map((n) => (
        <p key={n} className="review-sandhi-note" data-testid="sandhi-note">
          {n}
        </p>
      ))}
      {play && <SpeakerButton kind="word" id={play.id} label={play.headword} />}
      <button type="button" className="btn-primary" data-testid="pinyin-next" onClick={onNext} autoFocus>
        {NEXT}
      </button>
    </div>
  );
}

/** 1. Pick the tones: one row of tone buttons per syllable; graded per syllable. */
function TonesEx({ word, script, listening, onAnswer, onNext }: ExProps & { word: Word }) {
  const syl = useMemo(() => wordSyllables(word), [word]);
  const [given, setGiven] = useState<(number | undefined)[]>(() => syl.map(() => undefined));
  const [graded, setGraded] = useState<{ wrongAt: number[]; result: PinyinResult } | null>(null);
  const complete = given.every((g) => g !== undefined);
  function check() {
    const g = gradeTones(word, given.map((x) => x ?? 0));
    setGraded(g);
    onAnswer([g.result]);
  }
  return (
    <>
      <div className="pinyin-front" lang="zh-Hant">
        {word.headword}
      </div>
      <p className="pinyin-ask">{glossFor(word)}</p>
      {listening && <SpeakerButton kind="word" id={word.id} label={word.headword} />}
      <div className="pinyin-syllables">
        {syl.map((s, i) => (
          <div key={i} className="pinyin-syllable" data-testid="pinyin-syllable">
            <span className="pinyin-syllable-char" lang="zh-Hant">
              {s.char}
            </span>
            <div className="pinyin-tone-row" role="group" aria-label={`Tone of ${s.char}`}>
              {TONES.map((t) => {
                const chosen = given[i] === t;
                const state = graded ? (t === s.tone ? ' pinyin-opt--right' : chosen ? ' pinyin-opt--wrong' : '') : chosen ? ' pinyin-opt--chosen' : '';
                return (
                  <button
                    key={t}
                    type="button"
                    className={`pinyin-opt pinyin-tone${state}`}
                    aria-pressed={chosen}
                    disabled={!!graded}
                    title={`${toneLabel(t)} tone`}
                    data-testid="pinyin-tone"
                    data-tone={t}
                    data-right={t === s.tone ? 'true' : undefined}
                    onClick={() => setGiven((g) => g.map((x, j) => (j === i ? t : x)))}
                  >
                    {syllableText(s.base, t, script, s.zhuyinBase)}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {graded ? (
        <AfterAnswer words={[word]} ok={graded.wrongAt.length === 0} toneOnly script={script} onNext={onNext} />
      ) : (
        <button type="button" className="btn-primary" disabled={!complete} data-testid="pinyin-check" onClick={check}>
          Check
        </button>
      )}
    </>
  );
}

/** 2. Match pinyin to characters: tap a word, then its reading. Each word is graded on its first try. */
function MatchEx({ words, script, onAnswer, onNext }: ExProps & { words: Word[] }) {
  const readings = useMemo(() => seededShuffle([...words], seededRng(words.map((w) => w.id).join('|'))), [words]);
  const [selected, setSelected] = useState<Word | null>(null);
  const [matched, setMatched] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, PinyinResult>>(new Map());
  const [wrongFlash, setWrongFlash] = useState<string | null>(null);
  const finished = matched.size === words.length;

  function tapReading(r: Word) {
    if (!selected || matched.has(r.id)) return;
    const res = gradeMatch(selected, r);
    const first = !results.has(selected.id);
    const nextResults = first ? new Map(results).set(selected.id, res) : results;
    if (first) setResults(nextResults);
    if (res.kind === 'reading_correct') {
      const m = new Set(matched).add(selected.id).add(r.id);
      setMatched(m);
      setSelected(null);
      if (words.every((w) => m.has(w.id))) onAnswer(words.map((w) => nextResults.get(w.id)!));
    } else {
      setWrongFlash(r.id);
    }
  }
  return (
    <>
      <p className="pinyin-ask">Tap a word, then its reading.</p>
      <div className="pinyin-match">
        <div className="pinyin-match-col">
          {words.map((w) => (
            <button
              key={w.id}
              type="button"
              lang="zh-Hant"
              className={`pinyin-opt pinyin-match-zh${matched.has(w.id) ? ' pinyin-opt--right' : selected?.id === w.id ? ' pinyin-opt--chosen' : ''}`}
              disabled={matched.has(w.id)}
              data-testid="pinyin-match-word"
              data-id={w.id}
              onClick={() => {
                setSelected(w);
                setWrongFlash(null);
              }}
            >
              {w.headword}
            </button>
          ))}
        </div>
        <div className="pinyin-match-col">
          {readings.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`pinyin-opt${matched.has(r.id) ? ' pinyin-opt--right' : wrongFlash === r.id ? ' pinyin-opt--wrong' : ''}`}
              disabled={matched.has(r.id) || !selected}
              data-testid="pinyin-match-reading"
              data-id={r.id}
              onClick={() => tapReading(r)}
            >
              {readingText(r, script)}
            </button>
          ))}
        </div>
      </div>
      {finished && (
        <AfterAnswer
          words={words}
          ok={[...results.values()].every((r) => r.kind === 'reading_correct')}
          script={script}
          onNext={onNext}
        />
      )}
    </>
  );
}

/** 3. Pick the characters (from pinyin + an English hint), and 7. Look-alike characters. */
function PickCharsEx({
  word,
  options,
  lookalike,
  script,
  listening,
  onAnswer,
  onNext,
}: ExProps & { word: Word; options: Word[]; lookalike: boolean }) {
  const [picked, setPicked] = useState<Word | null>(null);
  return (
    <>
      <div className="pinyin-front">{readingText(word, script)}</div>
      <p className="pinyin-ask">{glossFor(word)}</p>
      {listening && !lookalike && <SpeakerButton kind="word" id={word.id} label={word.headword} />}
      <div className="review-pick-options" role="group" aria-label="Pick the characters">
        {options.map((o) => {
          const state = !picked ? '' : o.id === word.id ? ' review-pick--right' : o.id === picked.id ? ' review-pick--wrong' : '';
          return (
            <button
              key={o.id}
              type="button"
              lang="zh-Hant"
              className={`review-pick${state}`}
              disabled={!!picked}
              data-testid="pinyin-pick-option"
              data-right={o.id === word.id ? 'true' : undefined}
              onClick={() => {
                setPicked(o);
                onAnswer([gradePick(word, { wordId: o.id })]);
              }}
            >
              <span className="review-pick-zh">{o.headword}</span>
              {picked && (
                <span className="review-pick-info" lang="en">
                  {readingText(o, script)} · {glossFor(o)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {picked && <AfterAnswer words={[word]} ok={picked.id === word.id} script={script} onNext={onNext} />}
    </>
  );
}

/** 4. Type the pinyin (or zhuyin): right sound with a wrong tone counts as Hard. */
function TypeEx({ word, script, onAnswer, onNext }: ExProps & { word: Word }) {
  const [typed, setTyped] = useState('');
  const [graded, setGraded] = useState<ReturnType<typeof gradeTypedReading> | null>(null);
  function check() {
    if (!typed.trim()) return;
    const g = gradeTypedReading(word, typed);
    setGraded(g);
    onAnswer([g.result]);
  }
  return (
    <>
      <div className="pinyin-front" lang="zh-Hant">
        {word.headword}
      </div>
      <p className="pinyin-ask">{glossFor(word)}</p>
      <input
        className="review-recall-input"
        value={typed}
        disabled={!!graded}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !graded) check();
        }}
        placeholder={script === 'zhuyin' ? 'ㄎㄚ ㄈㄟ' : 'ka1 fei1 or kā fēi'}
        aria-label="Type the reading"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-testid="pinyin-type-input"
      />
      {graded ? (
        <AfterAnswer words={[word]} ok={graded.outcome === 'correct'} toneOnly={graded.outcome === 'wrong_tone'} script={script} onNext={onNext} />
      ) : (
        <button type="button" className="btn-primary" disabled={!typed.trim()} data-testid="pinyin-check" onClick={check}>
          Check
        </button>
      )}
    </>
  );
}

/** 5. Which pinyin is right: the real reading and one near miss. */
function WhichEx({
  word,
  options,
  script,
  listening,
  onAnswer,
  onNext,
}: ExProps & { word: Word; options: Extract<PinyinExercise, { kind: 'which' }>['options'] }) {
  const [picked, setPicked] = useState<number | null>(null);
  const result = picked === null ? null : gradePick(word, { syllables: options[picked]!.syllables });
  return (
    <>
      <div className="pinyin-front" lang="zh-Hant">
        {word.headword}
      </div>
      <p className="pinyin-ask">{glossFor(word)}</p>
      {listening && <SpeakerButton kind="word" id={word.id} label={word.headword} />}
      <div className="pinyin-which" role="group" aria-label="Which reading is right">
        {options.map((o, i) => {
          const state = picked === null ? '' : o.right ? ' pinyin-opt--right' : picked === i ? ' pinyin-opt--wrong' : '';
          return (
            <button
              key={i}
              type="button"
              className={`pinyin-opt pinyin-which-opt${state}`}
              disabled={picked !== null}
              data-testid="pinyin-which-option"
              data-right={o.right ? 'true' : undefined}
              onClick={() => {
                setPicked(i);
                onAnswer([gradePick(word, { syllables: o.syllables })]);
              }}
            >
              {syllablesText(o.syllables, script)}
            </button>
          );
        })}
      </div>
      {result && (
        <AfterAnswer
          words={[word]}
          ok={result.kind === 'reading_correct'}
          toneOnly={result.kind === 'reading_tone_wrong'}
          script={script}
          onNext={onNext}
        />
      )}
    </>
  );
}

/** 6. Tone pattern sort: give each two-syllable word its pattern ("2 + 4"). */
function SortEx({ words, patterns, script, onAnswer, onNext }: ExProps & { words: Word[]; patterns: string[] }) {
  const [given, setGiven] = useState<Map<string, string>>(new Map());
  const [graded, setGraded] = useState<Map<string, PinyinResult> | null>(null);
  function check() {
    const m = new Map(words.map((w) => [w.id, gradeSort(w, given.get(w.id) ?? '')] as const));
    setGraded(m);
    onAnswer(words.map((w) => m.get(w.id)!));
  }
  return (
    <>
      <p className="pinyin-ask">Give each word its tone pattern (0 = neutral).</p>
      <div className="pinyin-sort">
        {words.map((w) => {
          const want = wordSyllables(w).map((s) => (s.tone === 5 ? '0' : String(s.tone))).join(' + ');
          return (
            <div key={w.id} className="pinyin-sort-row" data-testid="pinyin-sort-row">
              <span className="pinyin-sort-word" lang="zh-Hant">
                {w.headword}
                {graded && <span className="pinyin-sort-reading"> {readingText(w, script)}</span>}
              </span>
              <div className="pinyin-tone-row" role="group" aria-label={`Tone pattern of ${w.headword}`}>
                {patterns.map((p) => {
                  const chosen = given.get(w.id) === p;
                  const state = graded ? (p === want ? ' pinyin-opt--right' : chosen ? ' pinyin-opt--wrong' : '') : chosen ? ' pinyin-opt--chosen' : '';
                  return (
                    <button
                      key={p}
                      type="button"
                      className={`pinyin-opt${state}`}
                      aria-pressed={chosen}
                      disabled={!!graded}
                      data-testid="pinyin-sort-pattern"
                      data-right={p === want ? 'true' : undefined}
                      onClick={() => setGiven((g) => new Map(g).set(w.id, p))}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {graded ? (
        <AfterAnswer words={words} ok={[...graded.values()].every((r) => r.kind === 'reading_correct')} script={script} onNext={onNext} />
      ) : (
        <button type="button" className="btn-primary" disabled={given.size < words.length} data-testid="pinyin-check" onClick={check}>
          Check
        </button>
      )}
    </>
  );
}
