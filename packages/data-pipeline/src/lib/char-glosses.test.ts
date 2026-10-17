import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { briefCharGlosses } from './char-glosses.js';

const BUILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../data/build');

describe('briefCharGlosses (Phase 44)', () => {
  const full = JSON.parse(readFileSync(path.join(BUILD, 'char-glosses.v1.json'), 'utf8')) as Record<string, string>;
  const brief = briefCharGlosses(full);
  it('乾 is short and has no trigram or hexagram', () => {
    expect(full['乾']).toMatch(/䷀/);
    expect(brief['乾']!.length).toBeLessThanOrEqual(30);
    expect(brief['乾']).not.toMatch(/[☰䷀]|trigram|hexagram/);
    expect(brief['乾']).toBe('dry');
  });
  it('every entry is at most 30 characters, with no trigram/hexagram signs', () => {
    for (const [ch, g] of Object.entries(brief)) {
      expect(g.length, ch).toBeLessThanOrEqual(30);
      expect(g, ch).not.toMatch(/[☰-☷䷀-䷿]/);
    }
  });
  it('the shipped file is the brief of the full one', () => {
    const shipped = JSON.parse(readFileSync(path.join(BUILD, 'char-glosses.brief.v1.json'), 'utf8')) as Record<string, string>;
    expect(shipped).toEqual(brief);
  });
});
