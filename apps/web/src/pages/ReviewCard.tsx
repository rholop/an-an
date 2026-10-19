import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { maskChinese, type GrammarItem, type Lexicon, type ReviewFace, type SkillCard, type Word } from '@anan/core';
import { useKeyboardShortcut } from '../lib/keyboard-shortcuts.js';
import {
  charsInWord,
  glossFor,
  homeLessonOfTags,
  nextLeechTreatment,
  normaliseAnswer,
  pickIsHard,
  reviewFace,
  sandhiNotes,
  shuffleIn,
} from '@anan/core';
import { AnnotatedInline } from '../components/AnnotatedInline.js';
import type { AnnotationScript } from '../components/AnnotatedText.js';
import { NopeButton } from '../components/Nope.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import { WithSimplified } from '../components/SimplifiedHint.js';
import { CHARACTERS, FACE_LABEL, FEEDBACK_CORRECT, feedbackWrong, LEECH_BREAKDOWN, lessonLabel, NEXT, WHICH_PATTERN } from '../lib/labels.js';
import { CHAR_BREAKDOWN_SETTING, useCharGlosses } from '../lib/char-glosses.js';
import { useSetting } from '../lib/useSetting.js';
import { readingText } from '../lib/reading.js';
import { GrammarExerciseCard, usePointExercise } from './GrammarStep.js';
import type { ConfusableContext } from '../lib/confusables.js';

export type Grade = 'again' | 'hard' | 'good' | 'easy';
const GRADES: { grade: Grade; label: string }[] = [
  { grade: 'again', label: 'Again' },
  { grade: 'hard', label: 'Hard' },
  { grade: 'good', label: 'Good' },
  { grade: 'easy', label: 'Easy' },
];

/** What an answer on a face adds to its evidence (the production ladder, a wrong pick). */
export interface RateExtra {
  face: ReviewFace;
  pickedId?: string;
}

/**
 * Phase 23 Part B: one Review card, on the face its skill and ladder call for. Meaning (中文 →
 * English), Pick the Mandarin (English → one of 4 look-alikes; a right pick is Hard or Good, never
 * Easy), Recall the Mandarin (English → recall or type, then rate), Say it (中文 → pinyin with
 * tones), and grammar patterns.
 */
export function ReviewCard({
  card,
  isNew,
  script,
  word,
  grammar,
  lexicon,
  revealed,
  onReveal,
  onRate,
  onNope,
  devPosition,
  confusables,
  glossLesson,
}: {
  card: SkillCard;
  isNew: boolean;
  script: AnnotationScript;
  word: Word | undefined;
  grammar?: GrammarItem;
  lexicon: Lexicon;
  revealed: boolean;
  onReveal: () => void;
  onRate: (grade: Grade, extra: RateExtra) => void;
  /** Phase 20: take this word out of review. */
  onNope: () => void;
  /** Phase 19 Part C (dev builds): the card's place in the session, to check spacing by eye. */
  devPosition?: string;
  /** Look-alike options for Pick the Mandarin (without them, production shows Recall). */
  confusables?: ConfusableContext | null;
  /** Phase 25: the lesson the card is studied in; otherwise the word's own lesson gives its meaning. */
  glossLesson?: { bookId: string; n: number };
}) {
  const lesson = grammar ? homeLessonOfTags(grammar.tags ?? []) : word ? homeLessonOfTags(word.tags) : undefined;
  // Phase 25: the meaning the word's lesson teaches (分 = minute in book 1 L9)
  const meaningLesson = glossLesson ?? (lesson ? { bookId: lesson.bookId, n: lesson.n } : undefined);
  const gloss = word ? glossFor(word, meaningLesson ? { lesson: meaningLesson } : {}) : '';
  const reading = word ? readingText(word, script) : '';
  // a seed that changes with every answer (the options reshuffle each time the card comes back)
  const answeredAt = new Date(card.updatedAt).getTime();
  const options = useMemo(() => {
    if (!word || !confusables || card.skill !== 'production') return null;
    // Phase 48: every option close to the answer, never the odd one out, harder after 2 right picks;
    // 3 options when only 2 are close, Recall when fewer (never filler)
    const picks = confusables.index.pick(word, {
      seed: `${card.item.id}|${answeredAt}`,
      preferred: confusables.preferred,
      hard: pickIsHard(card),
      ...(confusables.levelCap ? { levelCap: confusables.levelCap } : {}),
      ...(confusables.confusions.get(word.id) ? { confusedWith: confusables.confusions.get(word.id)! } : {}),
    });
    return picks.length >= 2 ? shuffleIn(word, picks.slice(0, 3), `pick|${answeredAt}`) : null;
  }, [word, confusables, card]);
  let face = grammar ? 'grammar' : reviewFace(card);
  if (face === 'pick' && !options) face = 'recall';
  // Phase 25 B7 / Phase 46: a grammar card is one exercise from the lesson step's builders, from any
  // source that has a sentence for the point (else the flip card).
  const grammarEx = usePointExercise(grammar?.id, lexicon, `${card.item.id}|${answeredAt}`);
  // Phase 38: a card whose word or grammar point the loaded word list lacks is never shown.
  if (!word && !grammar) return null;

  return (
    <div className={`review-card review-card--${face}`} data-testid="review-card" data-face={face}>
      <div className="review-card-skill">
        {isNew && <span className="review-new-chip" data-testid="review-new">New · </span>}
        {/* the dev-only session position is a tooltip, so the dev card lays out as production does
            (the laptop-fit checks measure it) */}
        <span data-testid="review-face" title={devPosition}>
          {FACE_LABEL[face]}
        </span>
        {lesson !== undefined && (
          <span className="textbook-badge" lang="zh-Hant">
            {lessonLabel(lesson.n, lesson.bookId)}
          </span>
        )}
      </div>
      {grammar && grammarEx === undefined ? (
        <p>Loading…</p>
      ) : grammar && grammarEx ? (
        <>
          {/* Phase 46: the pattern is masked until the answer (GrammarPrompt), never the card's front */}
          <GrammarExerciseCard
            ex={grammarEx}
            item={grammar}
            lexicon={lexicon}
            script={script}
            wrapPattern={(text) => <WithSimplified text={text}>{text}</WithSimplified>}
            onDone={(ok) => onRate(ok ? 'good' : 'again', { face: 'grammar' })}
            collapseAfter
            actions={
              <div className="review-actions">
                <NopeButton onNope={onNope} />
              </div>
            }
          />
        </>
      ) : face === 'pick' && word && options ? (
        <PickFace card={card} word={word} options={options} gloss={gloss} lexicon={lexicon} script={script} onRate={onRate} onNope={onNope} />
      ) : (
        <FlipFace
          face={face}
          card={card}
          word={word}
          grammar={grammar}
          lexicon={lexicon}
          script={script}
          gloss={gloss}
          reading={reading}
          revealed={revealed}
          onReveal={onReveal}
          onRate={onRate}
          onNope={onNope}
        />
      )}
    </div>
  );
}

/** Phase 46: the front of a grammar flip card: the explanation's meaning with the pattern's own
 * Chinese hidden ("＿＿…＿＿ means "together with…" and goes before the main verb."). */
function grammarFlipFront(grammar: GrammarItem): string {
  const runs = grammar.pattern.match(/\p{Script=Han}+/gu) ?? [];
  const first = grammar.explanationEn.split(/(?<=[.!?])\s+/u)[0] ?? grammar.explanationEn;
  return `${WHICH_PATTERN} ${maskChinese(first.replace(/[:：][^:：]*\p{Script=Han}[^:：]*$/u, '.'), runs, runs)}`;
}

/** Meaning, Recall, Say it and grammar: show the front, reveal, rate. */
function FlipFace({
  face,
  card,
  word,
  grammar,
  lexicon,
  script,
  gloss,
  reading,
  revealed,
  onReveal,
  onRate,
  onNope,
}: {
  face: ReviewFace;
  card: SkillCard;
  word: Word | undefined;
  grammar: GrammarItem | undefined;
  lexicon: Lexicon;
  script: AnnotationScript;
  gloss: string;
  reading: string;
  revealed: boolean;
  onReveal: () => void;
  onRate: (grade: Grade, extra: RateExtra) => void;
  onNope: () => void;
}) {
  const [typed, setTyped] = useState('');
  const zhFront = face === 'meaning' || face === 'say';
  // Phase 38: Review never renders a card the word list can't show, so there is no fallback text.
  // Phase 46: a grammar flip card asks for the pattern from its meaning (its Chinese hidden); the
  // pattern itself is only on the back.
  const front = grammar ? grammarFlipFront(grammar) : zhFront ? (word?.headword ?? '') : gloss;
  const typedOk =
    face === 'recall' && word && typed.trim()
      ? [word.headword, ...word.variants].map(normaliseAnswer).includes(normaliseAnswer(typed))
      : undefined;
  const notes = face === 'say' && word ? sandhiNotes(word) : [];

  useKeyboardShortcut('next', () => onReveal(), !revealed);
  useKeyboardShortcut('choice-1', () => onRate('again', { face }), revealed);
  useKeyboardShortcut('choice-2', () => onRate('hard', { face }), revealed);
  useKeyboardShortcut('choice-3', () => onRate('good', { face }), revealed);
  useKeyboardShortcut('choice-4', () => onRate('easy', { face }), revealed);
  useKeyboardShortcut('next', () => onRate('good', { face }), revealed);

  return (
    <>
      <div className={`review-card-front${grammar ? ' review-card-front--small' : ''}`} lang={zhFront ? 'zh-Hant' : undefined}>
        {/* Phase 41: a Chinese front shows its simplified form from the start; an English one never */}
        {zhFront ? <WithSimplified text={front}>{front}</WithSimplified> : front}
      </div>
      {face === 'say' && !revealed && <p className="review-card-ask">Say it aloud: what are the pinyin and tones?</p>}
      {face === 'recall' && !revealed && (
        <input
          className="review-recall-input"
          lang="zh-Hant"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onReveal();
          }}
          placeholder="Type it (optional)"
          aria-label="Type the Mandarin (optional)"
          data-testid="review-recall-input"
        />
      )}

      {revealed ? (
        <>
          <div className="review-card-back" data-testid="review-back">
            {grammar ? (
              <>
                <span lang="zh-Hant" data-testid="grammar-pattern" data-masked="no">
                  <WithSimplified text={grammar.pattern}>{grammar.pattern}</WithSimplified>
                </span>
                <br />
                {grammar.explanationEn}
              </>
            ) : face === 'meaning' ? (
              <>
                {reading} — {gloss}
              </>
            ) : face === 'say' ? (
              <>
                <span className="review-say-reading">{reading}</span> — {gloss}
              </>
            ) : (
              <>
                {word ? (
                  <span lang="zh-Hant">
                    {/* Phase 41: Recall shows the simplified form only now, with the answer */}
                    <WithSimplified text={word.headword}>
                      <AnnotatedInline text={word.headword} lexicon={lexicon} script={script} />
                    </WithSimplified>
                  </span>
                ) : null}{' '}
                ({reading})
              </>
            )}
          </div>
          {typedOk !== undefined && word && (
            <p className={`review-typed ${typedOk ? 'review-typed--ok' : 'review-typed--bad'}`} data-testid="review-typed-result">
              {typedOk ? FEEDBACK_CORRECT : feedbackWrong(word.headword)}
            </p>
          )}
          {notes.map((n) => (
            <p key={n} className="review-sandhi-note" data-testid="sandhi-note">
              {n}
            </p>
          ))}
          {word && <SpeakerButton kind="word" id={word.id} label={word.headword} />}
          {word && <CharBreakdown card={card} word={word} lexicon={lexicon} script={script} />}
          <div className="review-actions">
            <div className="review-buttons">
              {GRADES.map(({ grade, label }) => (
                <button
                  key={grade}
                  className={`review-btn review-btn--${grade}`}
                  onClick={() => onRate(grade, { face })}
                >
                  {label}
                </button>
              ))}
              <NopeButton onNope={onNope} />
            </div>
          </div>
        </>
      ) : (
        <div className="review-actions">
          <div className="review-reveal-row">
            <button className="review-reveal btn-primary" onClick={onReveal}>
              Show answer
            </button>
            <NopeButton onNope={onNope} />
          </div>
        </div>
      )}
    </>
  );
}

/** Pick the Mandarin: English shown, 4 same-length look-alikes; afterwards all four with their
 * pinyin and meaning, so the difference is visible. */
function PickFace({
  card,
  word,
  options,
  gloss,
  lexicon,
  script,
  onRate,
  onNope,
}: {
  card: SkillCard;
  word: Word;
  options: Word[];
  gloss: string;
  lexicon: Lexicon;
  script: AnnotationScript;
  onRate: (grade: Grade, extra: RateExtra) => void;
  onNope: () => void;
}) {
  const [picked, setPicked] = useState<Word | null>(null);
  const right = picked?.id === word.id;

  useKeyboardShortcut('choice-1', () => { if (!picked && options[0]) setPicked(options[0]); }, !picked);
  useKeyboardShortcut('choice-2', () => { if (!picked && options[1]) setPicked(options[1]); }, !picked);
  useKeyboardShortcut('choice-3', () => { if (!picked && options[2]) setPicked(options[2]); }, !picked);
  useKeyboardShortcut('choice-4', () => { if (!picked && options[3]) setPicked(options[3]); }, !picked);

  useKeyboardShortcut('choice-2', () => { if (picked && right) onRate('hard', { face: 'pick' }); }, Boolean(picked && right));
  useKeyboardShortcut('choice-3', () => { if (picked && right) onRate('good', { face: 'pick' }); }, Boolean(picked && right));
  useKeyboardShortcut('next', () => {
    if (!picked) return;
    if (right) onRate('good', { face: 'pick' });
    else onRate('again', { face: 'pick', pickedId: picked.id });
  }, Boolean(picked));

  return (
    <>
      <div className="review-card-front">{gloss}</div>
      <div className="review-pick-options" role="group" aria-label="Pick the Mandarin">
        {options.map((o) => {
          const state = !picked ? '' : o.id === word.id ? ' review-pick--right' : o.id === picked.id ? ' review-pick--wrong' : '';
          return (
            <button
              key={o.id}
              type="button"
              lang="zh-Hant"
              className={`review-pick${state}`}
              disabled={!!picked}
              onClick={() => setPicked(o)}
              data-testid="review-pick-option"
              data-right={o.id === word.id ? 'true' : undefined}
            >
              {/* Phase 41: after answering, the right word shows its simplified form */}
              {picked && o.id === word.id ? (
                <WithSimplified text={o.headword}>
                  <span className="review-pick-zh">{o.headword}</span>
                </WithSimplified>
              ) : (
                <span className="review-pick-zh">{o.headword}</span>
              )}
              {picked && (
                <span className="review-pick-info" lang="en">
                  {readingText(o, script)} · {glossFor(o)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {picked ? (
        <>
          <p className={`review-typed ${right ? 'review-typed--ok' : 'review-typed--bad'}`} data-testid="review-pick-result">
            {right ? FEEDBACK_CORRECT : feedbackWrong(word.headword, readingText(word, script))}
          </p>
          <CharBreakdown card={card} word={word} lexicon={lexicon} script={script} />
          <div className="review-actions">
            <div className="review-buttons">
              {right ? (
                <>
                  <button className="review-btn review-btn--hard" onClick={() => onRate('hard', { face: 'pick' })}>
                    Hard
                  </button>
                  <button className="review-btn review-btn--good btn-primary" onClick={() => onRate('good', { face: 'pick' })}>
                    Good
                  </button>
                </>
              ) : (
                <button
                  className="review-btn btn-primary"
                  onClick={() => onRate('again', { face: 'pick', pickedId: picked.id })}
                  data-testid="review-pick-next"
                >
                  {NEXT}
                </button>
              )}
              <NopeButton onNope={onNope} />
            </div>
          </div>
        </>
      ) : (
        <div className="review-actions">
          <div className="review-reveal-row">
            <NopeButton onNope={onNope} />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Phase 44 (from the Phase 2 leech breakdown): each character of the word with its reading in this
 * word (Phase 21) and a short meaning, under the answer only, so it never gives the answer away.
 * Every word of 2 or more characters when the setting is on; a leech card always, under its own
 * title and warning colour. On a laptop where the row would push the buttons below the window it
 * starts as a "Characters ▸" line that opens on tap (Phase 30).
 */
/**
 * A laptop answers without scrolling (Phase 30); a phone may scroll, but the grade buttons stay in
 * view above its tab bar. Either way the row starts collapsed when it would break that.
 */
function rowWouldNotFit(panel: HTMLElement): boolean {
  const tabbar = document.querySelector('nav.tabbar');
  const bottom = window.innerHeight - (tabbar ? tabbar.getBoundingClientRect().height : 0);
  const buttons = panel.closest('[data-testid="review-card"]')?.querySelector('.review-buttons');
  if (buttons && buttons.getBoundingClientRect().bottom > bottom) return true;
  return window.innerWidth >= 700 && document.documentElement.scrollHeight > window.innerHeight;
}

function CharBreakdown({
  card,
  word,
  lexicon,
  script,
}: {
  card: SkillCard;
  word: Word;
  lexicon: Lexicon;
  script: AnnotationScript;
}) {
  const [enabled] = useSetting<boolean>(CHAR_BREAKDOWN_SETTING, true);
  const show = card.leech || (enabled && word.chars.length >= 2);
  const glosses = useCharGlosses(show);
  const [open, setOpen] = useState(true);
  const touched = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!show || touched.current || !open || !panel.current) return;
    if (rowWouldNotFit(panel.current)) setOpen(false);
  }, [show, open, glosses]);
  if (!show) return null;
  // Phase 2 only actually implements the char_breakdown treatment (shown
  // below, unconditionally, since that's what this panel is); the other
  // three rotation slots are stubs — this note just previews what the
  // rotation would suggest trying next.
  const treatment = card.leech ? nextLeechTreatment({ leechTreatmentsTried: card.leechTreatmentsTried }) : null;
  const title = card.leech ? LEECH_BREAKDOWN : CHARACTERS;
  return (
    <div
      ref={panel}
      className={card.leech ? 'leech-panel' : 'char-panel'}
      data-testid="char-breakdown"
      data-open={open ? 'true' : 'false'}
    >
      <button
        type="button"
        className="leech-title char-panel-toggle"
        aria-expanded={open}
        onClick={() => {
          touched.current = true;
          setOpen((o) => !o);
        }}
      >
        {title} {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="leech-chars">
          {/* Phase 21: each character's reading IN THIS WORD (MOE), not its first dictionary entry */}
          {charsInWord(word, lexicon, glosses).map((c, i) => (
            <div className="leech-char" key={i} data-testid="char-tile">
              <div className="leech-char-glyph" lang="zh-Hant">
                {c.ch}
              </div>
              <div className="leech-char-reading">{readingText(c, script) || '?'}</div>
              {c.glossEn && (
                <div className="leech-char-gloss" data-testid="char-gloss">
                  {c.glossEn}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {open && treatment && treatment !== 'char_breakdown' && (
        <div className="leech-stub-note">
          ({treatment.replace('_', ' ')} — coming in a later phase)
        </div>
      )}
    </div>
  );
}
