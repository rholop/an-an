import { describe, expect, it } from 'vitest';
import type { Sense } from '../types.js';
import { pickSenseByContext, resolveSense } from './context.js';

const sense = (id: string, glossEn: string, pos: string, extra: Partial<Sense> = {}): Sense => ({
  id,
  glossEn,
  pos,
  basedOn: ['cedict'],
  ...extra,
});

// 機車 as the pipeline produces it: scooter first (primary), slang adjective
// second, and the mainland locomotive reading last.
const jiche = {
  primarySenseId: 'w#1',
  senses: [
    sense('w#1', 'scooter; motorcycle', 'N', { taiwanOnly: true }),
    sense('w#2', 'annoying; hard to get along with', 'Vs', { register: 'slang', taiwanOnly: true }),
    sense('w#3', 'locomotive', 'N'),
  ],
};

describe('pickSenseByContext (機車 fixtures)', () => {
  it('is "scooter" in getting-around contexts', () => {
    expect(pickSenseByContext(jiche, { prev: '騎' })?.glossEn).toBe('scooter; motorcycle'); // 我騎機車
    expect(pickSenseByContext(jiche, { prev: '一台' })?.glossEn).toBe('scooter; motorcycle'); // 一台機車
    expect(pickSenseByContext(jiche, { next: '的' })?.glossEn).toBe('scooter; motorcycle'); // 機車的聲音
    expect(pickSenseByContext(jiche, {})?.glossEn).toBe('scooter; motorcycle'); // no cue: primary
  });

  it('is the "annoying" sense in 他很機車', () => {
    expect(pickSenseByContext(jiche, { prev: '很' })?.glossEn).toBe(
      'annoying; hard to get along with',
    );
    expect(pickSenseByContext(jiche, { prev: '太' })?.id).toBe('w#2'); // 你太機車了
    expect(pickSenseByContext(jiche, { prev: '真' })?.id).toBe('w#2');
  });

  it('falls back to the primary sense when a cue has nothing to point to', () => {
    const plain = {
      primarySenseId: 'a',
      senses: [sense('a', 'to eat', 'V'), sense('b', 'to dine', 'V')],
    };
    expect(pickSenseByContext(plain, { prev: '很' })?.id).toBe('a');
    expect(pickSenseByContext({ senses: [] }, { prev: '很' })).toBeUndefined();
    expect(pickSenseByContext({}, {})).toBeUndefined();
  });
});

describe('resolveSense', () => {
  it('trusts a valid model-chosen sense id', () => {
    expect(resolveSense(jiche, 'w#2', {})?.id).toBe('w#2');
    expect(resolveSense(jiche, 'w#2', { prev: '騎' })?.id).toBe('w#2'); // the model's pick outranks the rules
  });
  it('ignores an invented id and uses context / primary instead', () => {
    expect(resolveSense(jiche, 'w#99', { prev: '很' })?.id).toBe('w#2');
    expect(resolveSense(jiche, 'w#99', {})?.id).toBe('w#1');
    expect(resolveSense(jiche, undefined, {})?.id).toBe('w#1');
  });
});

import { senseSourceLabel } from './context.js';

describe('senseSourceLabel', () => {
  it('names sources and marks Taiwan-only senses', () => {
    expect(senseSourceLabel({ basedOn: ['cedict', 'top2011'], taiwanOnly: true })).toBe(
      'CC-CEDICT + TOCFL 2011 list · Taiwan',
    );
    expect(senseSourceLabel({ basedOn: ['wiktionary'] })).toBe('Wiktionary');
    expect(senseSourceLabel({ basedOn: ['ai'] })).toBe('AI-generated');
    expect(senseSourceLabel({ basedOn: ['override'] })).toBe("An'an (edited)");
  });
});
