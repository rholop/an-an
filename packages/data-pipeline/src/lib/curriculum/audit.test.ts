import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Lexicon, type Word } from '@anan/core';
import { runCurriculumAudit, type AuditInputs } from './audit.js';
import { loadAuditInputs } from './audit-inputs.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** Phase 25 D: the curriculum audit over the real built data. */
describe('pnpm audit:curriculum', { timeout: 120_000 }, () => {
  const inputs = loadAuditInputs(REPO);
  const base = runCurriculumAudit(inputs);

  it('passes on the shipped curriculum, with no stale accepted findings', () => {
    expect(base.findings).toEqual([]);
    expect(base.staleAllows).toEqual([]);
    expect(base.stats.lessons).toBe(40);
  });

  const withWord = (patch: (w: Word) => Word, id: string): AuditInputs => {
    const words = inputs.lexicon.allWords().map((w) => (w.id === id ? patch(w) : w));
    return { ...inputs, lexicon: new Lexicon(words, []) };
  };
  const nanqu = inputs.lexicon.lookup('南區')[0]!;

  it('fails a reading that drops a final -n (南區 ná qū) and a headword with a space', () => {
    const r = runCurriculumAudit(withWord((w) => ({ ...w, pinyin: 'ná qū' }), nanqu.id));
    expect(r.findings.find((f) => f.check === 'lexicon-book-reading' && f.where.endsWith(nanqu.id))?.detail).toBe(
      '南區: book "nánqū", lexicon "ná qū"',
    );
    const sp = runCurriculumAudit(withWord((w) => ({ ...w, headword: '南 區' }), nanqu.id));
    expect(sp.findings.map((f) => f.check)).toContain('lexicon-headword');
  });

  it('fails a mainland term, a word from a later lesson and a later grammar point', () => {
    const s = inputs.sentences.find((x) => x.id === 'tb-b2-L08-005')!;
    const bad = [
      { ...s, id: 'x-mainland', zh: '我騎自行車去公司。' },
      { ...s, id: 'x-later-word', zh: '我下班以後回家。' },
      { ...s, id: 'x-later-grammar', zh: '我把書給他。' },
    ];
    const r = runCurriculumAudit({ ...inputs, sentences: [...inputs.sentences, ...bad] });
    const of = (id: string) => r.findings.filter((f) => f.where === id).map((f) => f.check);
    expect(of('x-mainland')).toContain('sentence-taiwan');
    expect(of('x-later-word')).toContain('sentence-later-word');
    expect(of('x-later-grammar')).toContain('sentence-later-grammar');
  });

  it('fails a grammar tag its pattern does not confirm, and a duplicate sentence', () => {
    const s = inputs.sentences.find((x) => x.id === 'tb-b2-L05-001')!;
    const r = runCurriculumAudit({
      ...inputs,
      sentences: [...inputs.sentences, { ...s, id: 'x-tag', zh: '這雙鞋太小。', grammarIds: ['gram-le-new-situation'] }, { ...s, id: 'x-dup' }],
    });
    expect(r.findings).toContainEqual(expect.objectContaining({ check: 'sentence-tag', where: 'x-tag' }));
    expect(r.findings).toContainEqual(expect.objectContaining({ check: 'sentence-duplicate', where: 'x-dup' }));
  });
});
