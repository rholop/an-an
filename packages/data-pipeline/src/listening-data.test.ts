import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LISTENING_CONFIG, buildToneCheck, generateTonePairs, wordTones, type Word } from '@anan/core';

// Phase 15 checks against the real built lexicon (kept here: core tests may not touch Node builtins).
describe('listening on the real lexicon', () => {
  const lexPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/build/lexicon.v2.json');
  it.skipIf(!existsSync(lexPath))('on the real lexicon: no tone-check exercise for any 一/不 word or 3+3 word', () => {
    const real = JSON.parse(readFileSync(lexPath, 'utf8')).words as Word[];
    let built = 0;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (const word of real.filter((x) => x.source === 'tocfl' && x.pinyinNumeric)) {
      const ex = buildToneCheck(word, rnd);
      if (!ex) continue;
      built++;
      expect(/[一不]/.test(word.headword), word.headword).toBe(false);
      const t = wordTones(word);
      for (let i = 0; i + 1 < t.length; i++) expect(t[i] === 3 && t[i + 1] === 3, word.headword).toBe(false);
      expect(ex.options).toContain(ex.answer);
    }
    expect(built).toBeGreaterThan(1000);
  });
  it.skipIf(!existsSync(lexPath))('ships at least 30 minimal pairs at N1–L1', () => {
    const real = JSON.parse(readFileSync(lexPath, 'utf8')).words as Word[];
    const pairs = generateTonePairs(real, { levels: ['N1', 'N2', 'L1'] });
    expect(pairs.length).toBeGreaterThanOrEqual(LISTENING_CONFIG.minTonePairs);
    for (const p of pairs.slice(0, 200)) expect(p.a.pinyinNumeric).not.toBe(p.b.pinyinNumeric);
  });
});
