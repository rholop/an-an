/* eslint-disable import/no-nodejs-modules, no-restricted-imports --
   a test reads the shared fixture file at packages/core/test/fixtures (outside
   `src`, so it can't be imported); the library code stays free of node modules. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { journalLexicon } from '../test-fixtures/journal-llm.js';
import { dryEvalModels, renderEvalReport, runJournalClozeEval, type EvalFixtureFile } from './eval.js';

const file = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../test/fixtures/journal-cloze/sentences.v1.json', import.meta.url)),
    'utf8',
  ),
) as EvalFixtureFile;

describe('the journal cloze evaluation set', () => {
  it('has at least 40 sentences covering every required kind, including the owner\'s example', () => {
    expect(file.entries.length).toBeGreaterThanOrEqual(40);
    expect(file.entries.some((e) => e.original === '我的姓印名字印羅恩。')).toBe(true);
    const cats = new Set(file.entries.map((e) => e.category));
    for (const c of [
      'multiple-errors',
      'missing-是',
      'missing-的',
      'missing-了',
      'measure-word',
      'word-order',
      'mainland-word',
      'names',
      'numbers',
      'already-correct',
    ])
      expect(cats, c).toContain(c);
    expect(new Set(file.entries.map((e) => e.id)).size).toBe(file.entries.length);
  });

  it('runs end to end with offline models: no hard rule is ever broken, and the report is written', async () => {
    // the shared lexicon plus the words the evaluation sentences use
    const lexicon = journalLexicon(); // a small lexicon: sentences using other words are simply rejected
    const results = await runJournalClozeEval(file, {
      lexicon,
      now: new Date('2026-03-01T10:00:00Z'),
      ...dryEvalModels(file),
    });
    expect(results).toHaveLength(file.entries.length);
    expect(results.flatMap((r) => r.violations)).toEqual([]);
    // nothing that wasn't verified ever became an item
    for (const r of results) if (r.items.length > 0) expect(r.verified?.status).toBe('verified');
    // the owner's example is handled: no blank over 印 or 羅恩
    const example = results.find((r) => r.fixture.id === 'example-garbled')!;
    for (const it of example.items) {
      const ex = it.exercise!;
      if (ex.blankStart !== undefined) expect(it.corrected.slice(ex.blankStart, ex.blankEnd)).not.toMatch(/印|羅|恩/);
    }
    const report = renderEvalReport(results, { generatedAt: 'now', source: 'dry run', promptVersion: 'v1' });
    expect(report).toContain('hard-rule violations found by the harness: **0**');
    expect(report).toContain('## example-garbled');
    expect(report).toContain('Verdict: _pending_');
  });
});
