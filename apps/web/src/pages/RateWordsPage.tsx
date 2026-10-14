import { useEffect, useState } from 'react';
import { glossFor, reviewFace, type Evidence, type SkillCard, type Word } from '@anan/core';
import { useReadingScript } from '../components/AnnotatedInline.js';
import { learnerService } from '../db/instance.js';
import {
  FACE_LABEL,
  RATE_EASY,
  RATE_GOOD,
  RATE_NOT_YET,
  RATE_WORDS,
  RATE_WORDS_DONE,
  RATE_WORDS_INTRO,
  rateWordsLeft,
} from '../lib/labels.js';
import { useLedger } from '../lib/ledger.js';
import { readingText } from '../lib/reading.js';
import { useLexicon } from '../lib/useLexicon.js';
import './ReviewPage.css';

type Rating = 'face_rating_good' | 'face_rating_easy' | 'face_rating_not_yet';

/**
 * Phase 42 (owner, 2026-10-14): a one-time pass, opened whenever there is time, through every card
 * already seen (Meaning, production, Say it): reveal the answer, then say Not yet / Good / Easy. Good
 * and Easy set the "I know this" marker that releases the word's next face (Easy also counts toward
 * Mastered); nothing here moves a card's due date. The list is taken once when the page opens, so it
 * does not shift under the learner; a card they leave can be rated next time.
 */
export function RateWordsPage() {
  const lexiconState = useLexicon();
  const ledger = useLedger();
  const script = useReadingScript();
  const [queue, setQueue] = useState<SkillCard[] | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ledger && queue === null) setQueue(ledger.faceRatingQueue());
  }, [ledger, queue]);

  if (lexiconState.status !== 'ready' || !queue) return <p>Loading…</p>;
  const lexicon = lexiconState.lexicon;
  const card = queue[index];

  async function rate(kind: Rating) {
    if (!card || busy) return;
    setBusy(true);
    const now = new Date();
    const e: Evidence = { item: card.item, skill: card.skill, kind, at: now, context: { source: 'review' } };
    try {
      await learnerService.record(e, now);
      setIndex((i) => i + 1);
      setRevealed(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rate-words" data-testid="rate-words">
      <h2>{RATE_WORDS}</h2>
      <p>{RATE_WORDS_INTRO}</p>
      {!card ? (
        <p data-testid="rate-words-done">{RATE_WORDS_DONE}</p>
      ) : (
        (() => {
          const word = lexicon.byId(card.item.id);
          if (!word) {
            // a card the loaded word list can't show (Phase 38): skip it, never rate it blind
            return (
              <p>
                <button className="btn-primary" onClick={() => setIndex((i) => i + 1)}>
                  Skip
                </button>
              </p>
            );
          }
          return (
            <div className="review-card" data-testid="rate-words-card">
              <FaceView card={card} word={word} script={script} revealed={revealed} />
              <p className="review-card-skill" data-testid="rate-words-left">
                {rateWordsLeft(queue.length - index)}
              </p>
              <div className="review-actions">
                {revealed ? (
                  <div className="review-buttons">
                    <button className="review-btn review-btn--again" disabled={busy} onClick={() => void rate('face_rating_not_yet')}>
                      {RATE_NOT_YET}
                    </button>
                    <button className="review-btn review-btn--good" disabled={busy} onClick={() => void rate('face_rating_good')}>
                      {RATE_GOOD}
                    </button>
                    <button className="review-btn review-btn--easy" disabled={busy} onClick={() => void rate('face_rating_easy')}>
                      {RATE_EASY}
                    </button>
                  </div>
                ) : (
                  <button className="review-reveal btn-primary" onClick={() => setRevealed(true)}>
                    Show answer
                  </button>
                )}
              </div>
            </div>
          );
        })()
      )}
    </section>
  );
}

/** The card's front, and with the answer revealed its back. Production is always shown as Recall
 * here (English → the Mandarin): the learner says whether they know it, there is no pick to make. */
function FaceView({ card, word, script, revealed }: { card: SkillCard; word: Word; script: Parameters<typeof readingText>[1]; revealed: boolean }) {
  const face = reviewFace(card);
  const faceKey = face === 'pick' ? 'recall' : face === 'grammar' ? 'meaning' : face;
  const gloss = glossFor(word, {});
  const reading = readingText(word, script);
  const zhFront = faceKey === 'meaning' || faceKey === 'say';
  return (
    <>
      <div className="review-card-skill" data-testid="rate-words-face">
        {FACE_LABEL[faceKey]}
      </div>
      <div className="review-card-front" lang={zhFront ? 'zh-Hant' : undefined}>
        {zhFront ? word.headword : gloss}
      </div>
      {faceKey === 'say' && !revealed && <p className="review-card-ask">Say it aloud: what are the pinyin and tones?</p>}
      {revealed && (
        <div className="review-card-back" data-testid="rate-words-back">
          {faceKey === 'recall' ? (
            <>
              <span lang="zh-Hant">{word.headword}</span> ({reading})
            </>
          ) : faceKey === 'say' ? (
            <>
              <span className="review-say-reading">{reading}</span> — {gloss}
            </>
          ) : (
            <>
              {reading} — {gloss}
            </>
          )}
        </div>
      )}
    </>
  );
}
