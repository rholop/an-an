// Phase 49 Part E: one quiet line on Home while TOCFL test prep is on, all from the ledger:
// "Level 1 words 612/741 · Level 2 words 803/1,226 · Reading 78% (7 days) · Last mock: reading 19,
// listening 21". Tapping it opens the test drill. No countdown, streak, badge or pressure here; the
// only other line is a reminder to log a mock (weeks 4 and 7) or the real result (after the test day).
import { TEST_PREP_CONFIG, type Ledger } from '@anan/core';
import {
  AFTER_TEST_REMINDER,
  lastResultLine,
  LOG_A_RESULT,
  MOCK_REMINDER,
  readingAccuracyLine,
  testWordsLine,
} from '../lib/labels.js';
import { openPage } from './StreakBar.js';
import './ReadinessLine.css';

export function ReadinessLine({ ledger, onDrill }: { ledger: Ledger | undefined; onDrill: () => void }) {
  if (!ledger) return null;
  const prep = ledger.testPrep();
  if (!prep.on) return null;
  const cov = ledger.testCoverage();
  const shown = cov.upTo.filter((r) => r.level === cov.mustPass || r.level === cov.target);
  const acc = ledger.readingAccuracy();
  const text = [
    ...shown.map((r) => testWordsLine(r.level, r.learned, r.total)),
    readingAccuracyLine(acc?.share ?? null, TEST_PREP_CONFIG.accuracyDays),
    lastResultLine(prep.latest),
  ].join(' · ');
  return (
    <div className="readiness">
      <button type="button" className="readiness-line" onClick={onDrill} data-testid="readiness-line" title="Open the test drill">
        {text}
      </button>
      {prep.reminder && (
        <button type="button" className="readiness-reminder" onClick={() => openPage('progress', 'tocfl-results')} data-testid="readiness-reminder">
          {prep.reminder === 'after-test' ? `${AFTER_TEST_REMINDER} · Log your result` : `${MOCK_REMINDER} · ${LOG_A_RESULT}`}
        </button>
      )}
    </div>
  );
}
