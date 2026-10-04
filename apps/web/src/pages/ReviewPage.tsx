import { useCallback, useEffect, useState } from 'react';
import type { Evidence, GrammarItem, Lexicon, SkillCard, Word } from '@anan/core';
import { firstLessonOfTags, lessonBadge, nextLeechTreatment } from '@anan/core';
import { db, learnerService } from '../db/instance.js';
import { dueForecast } from '../db/queries.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import { useLexicon } from '../lib/useLexicon.js';
import './ReviewPage.css';

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

type Grade = 'again' | 'hard' | 'good' | 'easy';
const GRADES: { grade: Grade; label: string }[] = [
  { grade: 'again', label: 'Again' },
  { grade: 'hard', label: 'Hard' },
  { grade: 'good', label: 'Good' },
  { grade: 'easy', label: 'Easy' },
];

/** `focusCards` (Phase 6 garden): review exactly these cards — e.g. a plot's
 * wilting words, which may not be formally due yet — instead of the due queue. */
export function ReviewPage({
  focusCards,
  onExit,
  exitLabel = '← Back to garden',
  title,
}: { focusCards?: SkillCard[]; onExit?: () => void; exitLabel?: string; title?: string } = {}) {
  const lexiconState = useLexicon();
  const [queue, setQueue] = useState<SkillCard[] | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [forecast, setForecast] = useState<number[] | null>(null);
  const [totalDue, setTotalDue] = useState(0);

  const loadQueue = useCallback(async () => {
    const now = new Date();
    const due = focusCards ?? (await learnerService.dueCards(now, 200));
    setQueue(shuffle(due)); // interleaved across topics: due order has no topical structure, shuffling avoids any incidental clustering
    setIndex(0);
    setRevealed(false);
    setTotalDue(due.length);
    setForecast(await dueForecast(db, now, 7));
  }, [focusCards]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  if (lexiconState.status === 'loading' || queue === null) return <p>Loading…</p>;
  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;

  const lexicon = lexiconState.lexicon;
  const current = queue[index];

  async function rate(grade: Grade) {
    if (!current) return;
    const evidence: Evidence = {
      item: current.item,
      skill: current.skill,
      kind: `review_${grade}`,
      at: new Date(),
    };
    await learnerService.record(evidence, evidence.at);
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  return (
    <div className="review-page">
      {onExit && <button onClick={onExit}>{exitLabel}</button>}
      <h1>{title ?? (focusCards ? 'Water these words' : 'Review')}</h1>
      <p className="review-meta">
        {Math.max(queue.length - index, 0)} due now (of {totalDue} this session)
        {forecast && <span className="review-forecast"> · next 7 days: {forecast.join(', ')}</span>}
      </p>

      {!current ? (
        <p className="review-done">
          {totalDue === 0 ? 'Nothing due right now.' : 'All done for now — nice work.'}
        </p>
      ) : (
        <ReviewCard
          card={current}
          word={current.item.kind === 'word' ? lexicon.byId(current.item.id) : undefined}
          grammar={current.item.kind === 'grammar' ? lexicon.grammarItemById(current.item.id) : undefined}
          lexicon={lexicon}
          revealed={revealed}
          onReveal={() => setRevealed(true)}
          onRate={rate}
        />
      )}
    </div>
  );
}

function ReviewCard({
  card,
  word,
  grammar,
  lexicon,
  revealed,
  onReveal,
  onRate,
}: {
  card: SkillCard;
  word: Word | undefined;
  grammar?: GrammarItem;
  lexicon: Lexicon;
  revealed: boolean;
  onReveal: () => void;
  onRate: (grade: Grade) => void;
}) {
  // Phase 12: grammar patterns are schedulable items too — pattern on the front,
  // the app's own explanation on the back.
  const lesson = grammar ? firstLessonOfTags(grammar.tags ?? []) : word ? firstLessonOfTags(word.tags) : undefined;
  const front = grammar
    ? grammar.pattern
    : card.skill === 'recognition'
      ? (word?.headword ?? '(unknown item)')
      : (word?.glossEn ?? '(unknown item)');
  const back = grammar
    ? grammar.explanationEn
    : card.skill === 'recognition'
      ? `${word?.pinyin ?? ''} · ${word?.zhuyin ?? ''} — ${word?.glossEn ?? ''}`
      : `${word?.headword ?? ''} (${word?.pinyin ?? ''})`;

  return (
    <div className="review-card">
      <div className="review-card-skill">
        {grammar ? 'grammar' : card.skill}
        {lesson !== undefined && (
          <span className="textbook-badge" lang="zh-Hant">
            {lessonBadge(lesson)}
          </span>
        )}
      </div>
      <div
        className="review-card-front"
        lang={grammar || card.skill === 'recognition' ? 'zh-Hant' : undefined}
      >
        {front}
      </div>

      {revealed ? (
        <>
          <div className="review-card-back">{back}</div>
          {word && <SpeakerButton kind="word" id={word.id} label={word.headword} />}
          {card.leech && word && <LeechBreakdown card={card} word={word} lexicon={lexicon} />}
          <div className="review-actions">
            <div className="review-buttons">
              {GRADES.map(({ grade, label }) => (
                <button
                  key={grade}
                  className={`review-btn review-btn--${grade}`}
                  onClick={() => onRate(grade)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="review-actions">
          <button className="review-reveal" onClick={onReveal}>
            Show answer
          </button>
        </div>
      )}
    </div>
  );
}

function LeechBreakdown({
  card,
  word,
  lexicon,
}: {
  card: SkillCard;
  word: Word;
  lexicon: Lexicon;
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
        {word.chars.map((ch, i) => {
          const info = lexicon.charInfo(ch);
          const entry = info.words[0];
          return (
            <div className="leech-char" key={i}>
              <div className="leech-char-glyph">{ch}</div>
              <div className="leech-char-reading">{entry?.pinyin ?? '?'}</div>
              <div className="leech-char-gloss">
                {entry?.glossEn ?? '(not its own lexicon entry)'}
              </div>
            </div>
          );
        })}
      </div>
      {treatment !== 'char_breakdown' && (
        <div className="leech-stub-note">
          ({treatment.replace('_', ' ')} — coming in a later phase)
        </div>
      )}
    </div>
  );
}
