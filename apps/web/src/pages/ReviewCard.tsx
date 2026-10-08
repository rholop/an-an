import { useMemo, useState } from 'react';
import type { GrammarItem, Lexicon, ReviewFace, SkillCard, Word } from '@anan/core';
import {
  charsInWord,
  glossFor,
  homeLessonOfTags,
  nextLeechTreatment,
  normaliseAnswer,
  reviewFace,
  sandhiNotes,
  shuffleIn,
} from '@anan/core';
import { AnnotatedInline } from '../components/AnnotatedInline.js';
import type { AnnotationScript } from '../components/AnnotatedText.js';
import { NopeButton } from '../components/Nope.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import { FACE_LABEL, FEEDBACK_CORRECT, feedbackWrong, lessonLabel, NEXT } from '../lib/labels.js';
import { readingText } from '../lib/reading.js';
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
}) {
  const lesson = grammar ? homeLessonOfTags(grammar.tags ?? []) : word ? homeLessonOfTags(word.tags) : undefined;
  const gloss = word ? glossFor(word) : '';
  const reading = word ? readingText(word, script) : '';
  const options = useMemo(() => {
    if (!word || !confusables || card.skill !== 'production') return null;
    const picks = confusables.index.pick(word, {
      seed: `${card.item.id}|${card.card.reps}`,
      preferred: confusables.preferred,
      ...(confusables.confusions.get(word.id) ? { confusedWith: confusables.confusions.get(word.id)! } : {}),
    });
    return picks.length >= 3 ? shuffleIn(word, picks.slice(0, 3), `pick|${card.card.reps}`) : null;
  }, [word, confusables, card]);
  let face = grammar ? 'grammar' : reviewFace(card);
  if (face === 'pick' && !options) face = 'recall';

  return (
    <div className={`review-card review-card--${face}`} data-testid="review-card" data-face={face}>
      <div className="review-card-skill">
        {isNew && <span className="review-new-chip" data-testid="review-new">New · </span>}
        <span data-testid="review-face">{FACE_LABEL[face]}</span>
        {devPosition && <span data-testid="dev-session-position"> · {devPosition}</span>}
        {lesson !== undefined && (
          <span className="textbook-badge" lang="zh-Hant">
            {lessonLabel(lesson.n, lesson.bookId)}
          </span>
        )}
      </div>
      {face === 'pick' && word && options ? (
        <PickFace word={word} options={options} gloss={gloss} script={script} onRate={onRate} onNope={onNope} />
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
  const front = grammar ? grammar.pattern : zhFront ? (word?.headword ?? '(unknown item)') : gloss || '(unknown item)';
  const typedOk =
    face === 'recall' && word && typed.trim()
      ? [word.headword, ...word.variants].map(normaliseAnswer).includes(normaliseAnswer(typed))
      : undefined;
  const notes = face === 'say' && word ? sandhiNotes(word) : [];
  return (
    <>
      <div className="review-card-front" lang={grammar || zhFront ? 'zh-Hant' : undefined}>
        {front}
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
              grammar.explanationEn
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
                    <AnnotatedInline text={word.headword} lexicon={lexicon} script={script} />
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
          {card.leech && word && <LeechBreakdown card={card} word={word} lexicon={lexicon} script={script} />}
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
  word,
  options,
  gloss,
  script,
  onRate,
  onNope,
}: {
  word: Word;
  options: Word[];
  gloss: string;
  script: AnnotationScript;
  onRate: (grade: Grade, extra: RateExtra) => void;
  onNope: () => void;
}) {
  const [picked, setPicked] = useState<Word | null>(null);
  const right = picked?.id === word.id;
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
      {picked ? (
        <>
          <p className={`review-typed ${right ? 'review-typed--ok' : 'review-typed--bad'}`} data-testid="review-pick-result">
            {right ? FEEDBACK_CORRECT : feedbackWrong(word.headword, readingText(word, script))}
          </p>
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

function LeechBreakdown({
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
  // Phase 2 only actually implements the char_breakdown treatment (shown
  // below, unconditionally, since that's what this panel is); the other
  // three rotation slots are stubs — this note just previews what the
  // rotation would suggest trying next.
  const treatment = nextLeechTreatment({ leechTreatmentsTried: card.leechTreatmentsTried });
  return (
    <div className="leech-panel">
      <div className="leech-title">Leech — character breakdown</div>
      <div className="leech-chars">
        {/* Phase 21: each character's reading IN THIS WORD (MOE), not its first dictionary entry */}
        {charsInWord(word, lexicon).map((c, i) => (
          <div className="leech-char" key={i}>
            <div className="leech-char-glyph">{c.ch}</div>
            <div className="leech-char-reading">{readingText(c, script) || '?'}</div>
            <div className="leech-char-gloss">{c.glossEn ?? '(not its own lexicon entry)'}</div>
          </div>
        ))}
      </div>
      {treatment !== 'char_breakdown' && (
        <div className="leech-stub-note">
          ({treatment.replace('_', ' ')} — coming in a later phase)
        </div>
      )}
    </div>
  );
}
