// Phase 49: Settings → Study → "TOCFL test prep" (per profile, synced, off by default). While it is
// on, the TOCFL words up to the target level that no lesson teaches come right after the current
// lessons in the study order, inside the same daily limits. Days to the test show here and on the
// results screen only (never on Home).
import { LEVEL_IDS, levelIndex, sanitizeTestPrep, TEST_PREP_CONFIG, type Level } from '@anan/core';
import { daysToTestLine, END_TEST_PREP, levelLabel, TEST_PREP } from '../lib/labels.js';
import { useLedger } from '../lib/ledger.js';
import { useStudySettings } from '../lib/study.js';
import { setTestPrep } from '../lib/test-prep.js';

export function TestPrepSettings() {
  const prep = sanitizeTestPrep(useStudySettings().testPrep);
  const view = useLedger()?.testPrep();
  const targets = LEVEL_IDS.filter((l) => TEST_PREP_CONFIG.targets.includes(l));
  return (
    <section data-testid="settings-test-prep">
      <h2>{TEST_PREP}</h2>
      <label className="review-settings-radio">
        <input
          type="checkbox"
          checked={prep.on}
          onChange={(e) => void setTestPrep({ on: e.target.checked })}
          data-testid="test-prep-toggle"
        />{' '}
        Prepare for the TOCFL (listening and reading)
      </label>
      <p className="review-settings-muted">
        Test words (TOCFL words up to your target) that no lesson teaches come right after your current lessons, before
        anything above the target. Tutoring words still come first, and your daily limits stay the same.
      </p>
      <label>
        Target level:{' '}
        <select
          value={prep.target}
          onChange={(e) => void setTestPrep({ target: e.target.value as Level })}
          data-testid="test-prep-target"
        >
          {targets.map((l) => (
            <option key={l} value={l}>
              {levelLabel(l)}
            </option>
          ))}
        </select>
      </label>
      <p className="review-settings-muted">
        Must pass: {levelLabel(levelIndex(TEST_PREP_CONFIG.mustPass) <= levelIndex(prep.target) ? TEST_PREP_CONFIG.mustPass : prep.target)}
      </p>
      <label>
        Test date (optional):{' '}
        <input
          type="date"
          value={prep.testDate ?? ''}
          onChange={(e) => void setTestPrep({ testDate: e.target.value || undefined })}
          data-testid="test-prep-date"
        />
      </label>
      {view?.daysToTest !== undefined && (
        <p className="review-settings-muted" data-testid="test-prep-days">
          {daysToTestLine(view.daysToTest)}
        </p>
      )}
      {prep.on && (
        <p>
          <button type="button" onClick={() => void setTestPrep({ on: false })} data-testid="test-prep-end">
            {END_TEST_PREP}
          </button>{' '}
          <span className="review-settings-muted">Only the study order goes back to normal; nothing is deleted.</span>
        </p>
      )}
    </section>
  );
}
