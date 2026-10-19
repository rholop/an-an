// Phase 49 Part D: Progress → "TOCFL results". Log an official mock or the real test (a score or a
// level per skill, whichever the report gives), see a small trend per skill. A score under the
// configured pass mark is flagged "(unverified pass mark)": no other screen claims an official mark.
import { useState } from 'react';
import { LEVEL_IDS, levelIndex, underPassMarks, type Level, type TestResult, type TestSkillResult } from '@anan/core';
import {
  daysToTestLine,
  LOG_A_RESULT,
  resultSkill,
  testLevel,
  TOCFL_RESULTS,
  UNVERIFIED_PASS_MARK,
} from '../lib/labels.js';
import { useLedger } from '../lib/ledger.js';
import { addTestResult, removeTestResult, restoreTestResult } from '../lib/test-prep.js';
import { showToast } from '../lib/toast.js';

type Entry = { mode: 'score' | 'level'; score: string; level: Level };
const emptyEntry = (): Entry => ({ mode: 'score', score: '', level: 'L1' });
const toSkill = (e: Entry): TestSkillResult | undefined =>
  e.mode === 'score' ? (e.score.trim() === '' || !Number.isFinite(Number(e.score)) ? undefined : { score: Number(e.score) }) : { level: e.level };

export function TestResults() {
  const ledger = useLedger();
  const [open, setOpen] = useState(false);
  if (!ledger) return null;
  const view = ledger.testPrep();
  const results = view.results;
  const trend = (skill: 'listening' | 'reading') =>
    results
      .map((r) => r[skill])
      .flatMap((s) => (s?.score !== undefined ? [String(s.score)] : s?.level ? [testLevel(s.level)] : []))
      .join(' → ');
  return (
    <section data-testid="tocfl-results" id="tocfl-results">
      <h2>{TOCFL_RESULTS}</h2>
      {view.daysToTest !== undefined && <p className="progress-muted">{daysToTestLine(view.daysToTest)}</p>}
      {results.length === 0 ? (
        <p className="progress-muted" data-testid="tocfl-results-none">
          No results yet. Log an official mock test here when you take one.
        </p>
      ) : (
        <>
          <ul className="progress-results" data-testid="tocfl-results-list">
            {[...results].reverse().map((r) => (
              <ResultRow key={r.id} r={r} />
            ))}
          </ul>
          {results.length > 1 && (
            <p data-testid="tocfl-results-trend">
              {trend('reading') && <span>Reading: {trend('reading')}. </span>}
              {trend('listening') && <span>Listening: {trend('listening')}.</span>}
            </p>
          )}
        </>
      )}
      {open ? (
        <ResultForm today={ledger.dayKey()} onDone={() => setOpen(false)} />
      ) : (
        <button type="button" onClick={() => setOpen(true)} data-testid="tocfl-log">
          {LOG_A_RESULT}
        </button>
      )}
    </section>
  );
}

function ResultRow({ r }: { r: TestResult }) {
  const under = underPassMarks(r);
  const parts = [resultSkill('listening', r.listening), resultSkill('reading', r.reading)].filter(Boolean);
  return (
    <li data-testid="tocfl-result">
      <strong>{r.date}</strong> · {r.kind === 'official' ? 'official test' : 'mock'}: {parts.join(', ') || 'no scores'}
      {under.length > 0 && (
        <span className="progress-warn" data-testid="tocfl-under-mark">
          {' '}
          · under the {under.join(' and ')} mark {UNVERIFIED_PASS_MARK}
        </span>
      )}{' '}
      <button
        type="button"
        className="link-button"
        onClick={() =>
          void removeTestResult(r.id).then(() =>
            showToast('Result removed', () => restoreTestResult(r.id)),
          )
        }
        aria-label={`Remove the result of ${r.date}`}
      >
        Remove
      </button>
    </li>
  );
}

function SkillInput({ name, value, onChange }: { name: 'Listening' | 'Reading'; value: Entry; onChange: (e: Entry) => void }) {
  return (
    <fieldset className="progress-result-skill">
      <legend>{name}</legend>
      <label>
        <input type="radio" checked={value.mode === 'score'} onChange={() => onChange({ ...value, mode: 'score' })} /> Score
      </label>{' '}
      <label>
        <input type="radio" checked={value.mode === 'level'} onChange={() => onChange({ ...value, mode: 'level' })} /> Level
      </label>{' '}
      {value.mode === 'score' ? (
        <input
          type="number"
          min={0}
          max={100}
          inputMode="numeric"
          value={value.score}
          onChange={(e) => onChange({ ...value, score: e.target.value })}
          aria-label={`${name} score`}
          data-testid={`tocfl-${name.toLowerCase()}-score`}
        />
      ) : (
        <select value={value.level} onChange={(e) => onChange({ ...value, level: e.target.value as Level })} aria-label={`${name} level`}>
          {LEVEL_IDS.filter((l) => levelIndex(l) <= levelIndex('L3')).map((l) => (
            <option key={l} value={l}>
              {testLevel(l)}
            </option>
          ))}
        </select>
      )}
    </fieldset>
  );
}

function ResultForm({ today, onDone }: { today: string; onDone: () => void }) {
  const [date, setDate] = useState(today);
  const [kind, setKind] = useState<'mock' | 'official'>('mock');
  const [listening, setListening] = useState<Entry>(emptyEntry);
  const [reading, setReading] = useState<Entry>(emptyEntry);
  const l = toSkill(listening);
  const r = toSkill(reading);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(date) && (l || r);
  return (
    <form
      className="progress-result-form"
      data-testid="tocfl-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        void addTestResult({ date, kind, ...(l ? { listening: l } : {}), ...(r ? { reading: r } : {}) }).then((row) => {
          onDone();
          showToast('Result logged', () => removeTestResult(row.id));
        });
      }}
    >
      <label>
        Date: <input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="tocfl-date" />
      </label>{' '}
      <label>
        <select value={kind} onChange={(e) => setKind(e.target.value as 'mock' | 'official')} data-testid="tocfl-kind">
          <option value="mock">Mock test</option>
          <option value="official">Official test</option>
        </select>
      </label>
      <SkillInput name="Listening" value={listening} onChange={setListening} />
      <SkillInput name="Reading" value={reading} onChange={setReading} />
      <button type="submit" disabled={!ok} data-testid="tocfl-save">
        Save
      </button>{' '}
      <button type="button" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}
