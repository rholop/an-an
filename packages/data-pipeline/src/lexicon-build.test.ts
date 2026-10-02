import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEVEL_IDS, LEVELS, type Word } from '@anan/core';
import { isSupported, computeStats } from './lib/gloss/review.js';
import type { ResolvedGloss } from './lib/gloss/resolve.js';

const BUILD = path.resolve(__dirname, '../../../data/build');
const lexicon = JSON.parse(readFileSync(path.join(BUILD, 'lexicon.v2.json'), 'utf8')) as {
  meta: {
    version: string;
    levels: string[];
    missingLevels: string[];
    glossStats: { earlySupportedShare: number };
  };
  words: Word[];
};
const v1Ids = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/lexicon-v1-ids.json'), 'utf8'),
) as string[];
const migration = JSON.parse(
  readFileSync(path.join(BUILD, 'id-migration-map.json'), 'utf8'),
) as Record<string, string>;

describe('the built lexicon (phase 7)', () => {
  it('has exactly the levels in levels.config — the UI list can never drift from the data', () => {
    const present = LEVEL_IDS.filter((l) => lexicon.words.some((w) => w.level === l));
    expect(present).toEqual([...LEVEL_IDS]);
    expect(lexicon.meta.levels).toEqual([...LEVEL_IDS]);
    expect(lexicon.meta.missingLevels).toEqual([]);
    const unknown = new Set(
      lexicon.words.map((w) => w.level).filter((l) => l !== null && !LEVEL_IDS.includes(l)),
    );
    expect([...unknown]).toEqual([]);
    expect(LEVELS).toHaveLength(7);
  });

  it('is version v2 and keeps every v1 word id (saved progress survives the rebuild)', () => {
    expect(lexicon.meta.version).toBe('v2');
    const ids = new Set(lexicon.words.map((w) => w.id));
    const lost = v1Ids.filter((id) => !ids.has(id) && !migration[id]);
    expect(lost).toEqual([]);
  });

  it('gives every TOCFL word a primary gloss that cites a source', () => {
    for (const w of lexicon.words.filter((x) => x.source === 'tocfl' && x.senses)) {
      expect(w.glossEn).toBe(w.senses![0]!.glossEn);
      expect(w.primarySenseId).toBe(w.senses![0]!.id);
      expect(w.senses!.every((s) => s.id.startsWith(`${w.id}#`) && s.basedOn.length > 0)).toBe(
        true,
      );
      expect(w.senses!.every((s) => s.glossEn.split(/\s+/).length <= 7)).toBe(true);
    }
  });

  it('≥ 95% of N1–L2 words have a gloss supported by a cited source', () => {
    const early = lexicon.words.filter(
      (w) => w.level && ['N1', 'N2', 'L1', 'L2'].includes(w.level),
    );
    const supported = early.filter((w) => (w.glossSources?.length ?? 0) > 0 && w.senses?.length);
    expect(supported.length / early.length).toBeGreaterThanOrEqual(0.95);
    expect(lexicon.meta.glossStats.earlySupportedShare).toBeGreaterThanOrEqual(0.95);
  });

  it('keeps homographs apart and fixes the owner-reported words', () => {
    const find = (h: string, p: string) =>
      lexicon.words.filter((w) => w.headword === h && w.pinyin === p);
    const gloss = (h: string, p: string) =>
      find(h, p)
        .map((w) => w.glossEn)
        .join(' | ');
    expect(gloss('還', 'hái')).toMatch(/still/);
    expect(gloss('還', 'huán')).toMatch(/return|pay back/);
    expect(gloss('長', 'cháng')).toMatch(/long/);
    expect(gloss('長', 'zhǎng')).toMatch(/grow|chief|elder/);
    expect(gloss('打', 'dǎ')).toMatch(/beat|hit|strike/);
    for (const h of ['還', '長'])
      expect(gloss(h, h === '還' ? 'hái' : 'cháng')).not.toBe(
        gloss(h, h === '還' ? 'huán' : 'zhǎng'),
      );
    const noSurname = lexicon.words.filter((w) => /^surname\b/i.test(w.glossEn));
    expect(noSurname).toEqual([]);
  });

  it('機車 offers both the scooter and the "annoying" sense, scooter first', () => {
    const entries = lexicon.words.filter((w) => w.headword === '機車' && w.senses);
    expect(entries.length).toBeGreaterThan(0);
    const supp = entries.find((w) => w.source === 'supplement')!;
    expect(supp.senses![0]!.glossEn).toMatch(/scooter/);
    expect(supp.senses!.some((s) => /annoying/.test(s.glossEn) && s.pos === 'Vs')).toBe(true);
  });

  it('review stats helper agrees with the build', () => {
    const g = (over: Partial<ResolvedGloss>): ResolvedGloss => ({
      senses: [],
      primarySenseId: undefined,
      glossEn: '',
      glossSources: [],
      origin: 'heuristic',
      flags: [],
      ...over,
    });
    expect(isSupported(g({ glossSources: ['cedict'] }))).toBe(true);
    expect(isSupported(g({ origin: 'none' }))).toBe(false);
    expect(computeStats([]).earlySupportedShare).toBe(1);
  });
});
