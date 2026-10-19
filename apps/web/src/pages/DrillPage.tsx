// Phase 49 Part C: the TOCFL test drill (Reader → Test drill, and the Home readiness line). Five short
// Band A-style reading items built in code from the lesson practice sentences, with a gentle timer of
// about a minute each: running out of time marks the item "slow", never wrong, and nothing stops.
// Answers count like Phase 45 practice (core `drillAnswerEvidence`): the word's first answer of the
// day is a real review, later ones are practice; a drill never adds a word, a face or a session.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildDrillRound,
  drillAnswerEvidence,
  drillScore,
  sessionKeyAt,
  TEST_PREP_CONFIG,
  type DrillItem,
} from '@anan/core';
import { learnerService } from '../db/instance.js';
import { useConfusables } from '../lib/confusables.js';
import { DONE, drillResultLine, TEST_DRILL } from '../lib/labels.js';
import { getLedgerNow } from '../lib/ledger.js';
import { getReviewSettings } from '../lib/review-settings.js';
import { useSaveWhenDone } from '../lib/save-progress.js';
import { loadTextbookSentences } from '../lib/textbook-data.js';
import { useLexicon } from '../lib/useLexicon.js';
import './DrillPage.css';

const QUESTION: Record<DrillItem['type'], string> = {
  gap: 'Which word fits the blank?',
  meaning: 'What does this sentence mean?',
  context: 'What does the underlined word mean here?',
};

/** Sentences shown in this visit's earlier rounds (a new round uses others while it can). */
const shownThisVisit = new Set<string>();

export function DrillPage({ onExit, exitLabel = '← Back' }: { onExit: () => void; exitLabel?: string }) {
  const lexiconState = useLexicon();
  const lexicon = lexiconState.status === 'ready' ? lexiconState.lexicon : null;
  const confusables = useConfusables(lexicon);
  const [items, setItems] = useState<DrillItem[] | null>(null);
  const [round, setRound] = useState(0);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Array<{ correct: boolean; seconds: number }>>([]);
  const started = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const done = items !== null && items.length > 0 && index >= items.length;
  useSaveWhenDone(done);

  const build = useCallback(async () => {
    if (!lexicon || !confusables) return;
    const [ledger, sentences] = await Promise.all([getLedgerNow(new Date()), loadTextbookSentences()]);
    const prep = ledger.testPrep();
    const fresh = buildDrillRound({
      lexicon,
      sentences,
      wordIds: ledger.drillWordIds(),
      comprehensibleIds: ledger.comprehensible().ids,
      testWordIds: new Set(ledger.testWords().map((i) => i.id)),
      target: prep.target,
      index: confusables.index,
      preferred: confusables.preferred,
      seed: `${ledger.dayKey()}|${shownThisVisit.size}`,
      avoid: shownThisVisit,
    });
    fresh.forEach((it) => it.sentenceIds.forEach((id) => shownThisVisit.add(id)));
    setItems(fresh);
    setIndex(0);
    setPicked(null);
    setAnswers([]);
    started.current = Date.now();
    setElapsed(0);
  }, [lexicon, confusables]);

  useEffect(() => {
    void build();
  }, [build, round]);

  // the visible timer (seconds on this item); it never stops the drill
  useEffect(() => {
    if (picked !== null || done) return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 500);
    return () => clearInterval(id);
  }, [index, picked, done]);

  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;
  if (items === null) return <p>Loading…</p>;

  const header = (
    <div className="drill-head">
      <button type="button" className="link-button" onClick={onExit} data-testid="drill-exit">
        {exitLabel}
      </button>
      <h1>{TEST_DRILL}</h1>
    </div>
  );

  if (items.length === 0)
    return (
      <div className="drill-page" data-testid="drill-page">
        {header}
        <p data-testid="drill-empty">Learn a few test words in Review first: the drill asks about words you have already met.</p>
      </div>
    );

  if (done) {
    const s = drillScore(answers);
    return (
      <div className="drill-page" data-testid="drill-page">
        {header}
        <p className="drill-result" data-testid="drill-result">
          {drillResultLine(s.right, s.total, s.inTime)}
        </p>
        <div className="drill-actions">
          <button type="button" onClick={() => setRound((r) => r + 1)} data-testid="drill-again">
            Another round
          </button>
          <button type="button" onClick={onExit}>
            {DONE}
          </button>
        </div>
      </div>
    );
  }

  const item = items[index]!;
  const limit = TEST_PREP_CONFIG.secondsPerItem;
  const left = limit - elapsed;
  const slow = left < 0;

  async function choose(i: number) {
    if (picked !== null) return;
    const at = new Date();
    const seconds = (at.getTime() - started.current) / 1000;
    setPicked(i);
    setAnswers((a) => [...a, { correct: i === item.answer, seconds }]);
    const ledger = await getLedgerNow(at);
    const sessionKey = sessionKeyAt(at, await getReviewSettings());
    for (const e of drillAnswerEvidence(ledger, item, i === item.answer, at, sessionKey)) await learnerService.record(e, at);
  }

  function next() {
    setPicked(null);
    setIndex((n) => n + 1);
    started.current = Date.now();
    setElapsed(0);
  }

  return (
    <div className="drill-page" data-testid="drill-page">
      {header}
      <p className="drill-progress">
        <span>
          {index + 1} / {items.length}
        </span>
        <span className={`drill-timer${slow ? ' drill-timer--slow' : ''}`} data-testid="drill-timer" aria-live="off">
          {slow ? 'Over time · take your time' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}
        </span>
      </p>
      <div className="drill-passage" lang="zh-Hant" data-testid="drill-passage">
        {item.passage.map((sentence, si) => (
          <span key={si} className="drill-sentence">
            {sentence.map((x, xi) =>
              x.mark === 'blank' ? (
                <span key={xi} className="drill-blank" aria-label="blank">
                  {picked !== null ? item.options[item.answer] : x.text}
                </span>
              ) : x.mark === 'underline' ? (
                <u key={xi} className="drill-underline">
                  {x.text}
                </u>
              ) : (
                <span key={xi}>{x.text}</span>
              ),
            )}
          </span>
        ))}
      </div>
      <p className="drill-question">{QUESTION[item.type]}</p>
      <div className={`drill-options drill-options--${item.optionLang}`} role="group" aria-label={QUESTION[item.type]}>
        {item.options.map((o, i) => {
          const state = picked === null ? '' : i === item.answer ? ' drill-option--right' : i === picked ? ' drill-option--wrong' : '';
          return (
            <button
              key={o}
              type="button"
              className={`drill-option${state}`}
              lang={item.optionLang === 'zh' ? 'zh-Hant' : 'en'}
              disabled={picked !== null}
              onClick={() => void choose(i)}
              data-testid="drill-option"
              data-right={i === item.answer ? 'true' : undefined}
            >
              {o}
            </button>
          );
        })}
      </div>
      {picked !== null && (
        <div className="drill-after">
          <p data-testid="drill-feedback">
            {picked === item.answer ? '✓ Right' : `The answer: ${item.options[item.answer]}`}
            {slow ? ' · slow' : ''}
          </p>
          <button type="button" onClick={next} data-testid="drill-next">
            Next
          </button>
        </div>
      )}
    </div>
  );
}
