import { describe, expect, it } from 'vitest';
import { extractBrackets, renderBracketsInline } from './bracket.js';
import { prepareSentences } from './pipeline.js';
import { countWrittenChars } from './summary.js';

// Phase 31 Part F: every bracket a Chinese keyboard produces marks a gap.
describe('gap brackets (Phase 31 Part F)', () => {
  const ens = (t: string) => extractBrackets(t).map((g) => g.en);

  it.each([
    ['今天我去[gym]', 'gym'],
    ['今天我去［gym］', 'gym'],
    ['今天我去【gym】', 'gym'],
    ['今天我去〖gym〗', 'gym'],
    ['今天我去〔gym〕', 'gym'],
  ])('%s is a gap', (t, en) => {
    expect(ens(t)).toEqual([en]);
    const [g] = extractBrackets(t);
    expect(t.slice(g!.start, g!.end)).toMatch(/gym/);
    expect(g!.end).toBe(t.length);
  });

  it('accepts mixed pairs, like the owner typed them', () => {
    expect(ens('我的老師很[nice］。')).toEqual(['nice']);
    expect(ens('今天我去【gym]')).toEqual(['gym']);
    expect(ens('我想喝［bubble tea】和〔juice]')).toEqual(['bubble tea', 'juice']);
  });

  it('Chinese inside 【】 is never a gap', () => {
    expect(ens('【第一課】我叫羅恩。')).toEqual([]);
    expect(ens('我看了【海角七號】，很好看。')).toEqual([]);
    // a gap needs a Latin letter, but may hold other things too
    expect(ens('我買了【iPhone 15】')).toEqual(['iPhone 15']);
  });

  it('leaves nested and unclosed brackets as text', () => {
    expect(ens('我去[a [gym] b]')).toEqual([]);
    expect(ens('我去【gym')).toEqual([]);
    expect(ens('我去gym】')).toEqual([]);
    // an unclosed bracket earlier doesn't swallow a later, complete gap
    expect(ens('我去[ 然後【gym】')).toEqual(['gym']);
    expect(ens('[]【 】')).toEqual([]);
  });

  it('renders every style inline and keeps a Chinese 【title】', () => {
    const map = new Map([
      ['gym', '健身房'],
      ['nice', '人很好'],
    ]);
    expect(renderBracketsInline('【第一課】今天我去【gym】，老師很[nice］', map)).toBe(
      '【第一課】今天我去健身房，老師很人很好',
    );
  });

  it('a sentence with a 【gap】 is not reviewed as a sentence; a 【title】 one is', () => {
    expect(prepareSentences('今天我去【gym】。我很累。').map((s) => s.original)).toEqual(['我很累。']);
    expect(prepareSentences('【第一課】我叫羅恩。').map((s) => s.original)).toHaveLength(1);
  });

  it('gaps are not counted as written characters', () => {
    expect(countWrittenChars('我去【gym】')).toBe(2);
    expect(countWrittenChars('【第一課】')).toBe(5);
  });
});
