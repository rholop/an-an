import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GlossAdjudicationRequest } from '@anan/core';
import {
  AdjudicationStore,
  ProxyHttpError,
  proxyCall,
  requestHash,
  runAdjudication,
  validateAdjudication,
} from './adjudicate.js';
import { parseCsv } from './csv.js';
import { heuristicSenses } from './heuristic.js';
import { buildInventory, type GlossSources } from './inventory.js';
import {
  condenseGloss,
  glossOverlap,
  parseGloss,
  pinyinKey,
  splitOutsideParens,
} from './normalize.js';
import { loadGlossOverrides } from './overrides.js';
import { buildAdjudicationRequest } from './request.js';
import { resolveGloss } from './resolve.js';
import {
  cedictSensesFor,
  loadTocflCedict,
  loadTop2011,
  loadUnihanDefinitions,
  isUsableWiktionarySense,
  loadWiktionary,
  parseCedictMeaning,
  tidyWiktionaryGloss,
} from './sources.js';
import { MoeDictionary } from '../moe.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gloss-'));

describe('csv + normalisation', () => {
  it('parses quoted fields with commas, quotes and newlines', () => {
    expect(parseCsv('A,B\n1,"x, ""y""\nz"\n2,w\n')).toEqual([
      { A: '1', B: 'x, "y"\nz' },
      { A: '2', B: 'w' },
    ]);
  });

  it('splits outside parentheses and keys pinyin', () => {
    expect(
      splitOutsideParens('to hold; to grasp/(used to put 把[ba3] + {noun}/verb)/handle', '/'),
    ).toEqual(['to hold; to grasp', '(used to put 把[ba3] + {noun}/verb)', 'handle']);
    expect(pinyinKey('Jī Chē')).toBe('jīchē');
    expect(pinyinKey("xī'ān")).toBe('xīān');
  });

  it('pulls tags out of glosses and flags non-meanings', () => {
    expect(parseGloss('(Tw) scooter; motorcycle')).toMatchObject({
      text: 'scooter; motorcycle',
      tags: ['taiwan'],
      junk: false,
    });
    expect(parseGloss('(Tw) (slang) hard to get along with; annoying').tags).toEqual([
      'taiwan',
      'informal',
      'slang',
    ]);
    expect(parseGloss('surname Huan').junk).toBe(true);
    expect(parseGloss('variant of 瞭|了[liao3]').junk).toBe(true);
    expect(parseGloss('(loanword) dozen').tags).toEqual(['loanword']);
    expect(parseGloss('[jie3 jie5]').junk).toBe(true);
    expect(parseGloss('a surname').junk).toBe(true);
    expect(parseGloss('nose/CL:個|个[ge4],隻|只[zhi1]'.split('/')[1]!).junk).toBe(true);
    expect(parseGloss('mouth (CL:張|张[zhang1])').text).toBe('mouth');
    expect(glossOverlap('to be', 'to be')).toBe(1);
    expect(glossOverlap('to be', 'to do')).toBe(0);
  });

  it('condenses to ≤ 6 words and never adds words', () => {
    expect(
      condenseGloss('a semantically light, transitive verb that is combined with various objects'),
    ).toBe('a semantically light');
    expect(condenseGloss('to hold; to grasp')).toBe('to hold; to grasp');
    expect(condenseGloss('hard to get along with; annoying')).toBe(
      'hard to get along with; annoying',
    );
    expect(condenseGloss('one two three; four five; six seven')).toBe('one two three; four five');
    expect(condenseGloss('classifier for things with handles (e.g. knives)')).toBe(
      'classifier for things with handles',
    );
    expect(condenseGloss('one two three four five six seven eight', 6).split(' ')).toHaveLength(6);
    expect(glossOverlap('to hit', 'to hit; to strike')).toBe(1);
    expect(glossOverlap('long', 'to grow')).toBe(0);
  });
});

describe('CEDICT readings (ivankra tocfl-cedict.csv shape)', () => {
  it("splits a row into per-reading sense lists, first line = the row's own reading", () => {
    const r = parseCedictMeaning('still/yet/also<br> [huán] to pay back/to return', 'hái');
    expect(r).toEqual([
      { pinyinKey: 'hái', senses: ['still', 'yet', 'also'] },
      { pinyinKey: 'huán', senses: ['to pay back', 'to return'] },
    ]);
  });

  it('keeps homographs apart: 長 cháng vs zhǎng', () => {
    const dir = tmp();
    const f = path.join(dir, 'c.csv');
    writeFileSync(
      f,
      'ID,Traditional,Simplified,Pinyin,POS,Variants,Meaning\nL0-2179,長,长,cháng,Vs,,length/long/forever<br> [zhǎng] chief/head/to grow\nL1-0143,長,长,zhǎng,Vs,,chief/head/elder/to grow<br> [cháng] length/long\n',
    );
    const idx = loadTocflCedict(f);
    expect(cedictSensesFor(idx.get('長'), 'cháng')).toEqual(
      ['length', 'long', 'forever', 'length', 'long'].filter((v, i, a) => a.indexOf(v) === i),
    );
    expect(cedictSensesFor(idx.get('長'), 'zhǎng')).toContain('to grow');
    expect(cedictSensesFor(idx.get('長'), 'zhǎng')).not.toContain('long');
  });
});

// ---- 機車 with the five CEDICT senses MOE lists for it ----
const moe = MoeDictionary.fromEntries([
  {
    title: '機車',
    translation: { English: ['locomotive; train engine car'] },
    heteronyms: [
      {
        pinyin: 'jī chē',
        definitions: [
          { def: '機器腳踏車的簡稱。參見「機器腳踏車」條。' },
          { def: '火車中配備動力發動機。' },
        ],
      },
    ],
  },
]);

function sourcesFor(cedictMeaning: string, topMeaning?: string): GlossSources {
  const dir = tmp();
  const c = path.join(dir, 'c.csv');
  writeFileSync(
    c,
    `ID,Traditional,Simplified,Pinyin,POS,Variants,Meaning\nL1-0001,機車,机车,jī chē,N,,"${cedictMeaning}"\n`,
  );
  const t = path.join(dir, 't.csv');
  writeFileSync(
    t,
    `ID,Traditional,Simplified,Pinyin,POS,Meaning,Variants\nL1-0001,機車,机车,jī chē,N,"${topMeaning ?? ''}",\n`,
  );
  return { cedict: loadTocflCedict(c), top2011: topMeaning ? loadTop2011(t) : new Map(), moe };
}

const jiche = { headword: '機車', variants: [], pinyin: 'jī chē', pos: ['N'] };

describe('sense inventory + heuristic baseline', () => {
  const cedict =
    'locomotive/(coll.) motorcycle/(Tw) scooter; motorcycle/(Tw) (slang) hard to get along with; annoying/(Tw) damn!; crap!';

  it('collects candidates from every source, tagged, plus MOE Chinese definitions verbatim', () => {
    const inv = buildInventory(jiche, sourcesFor(cedict, 'motorcycle'));
    expect(inv.candidates.map((c) => c.source)).toEqual([
      'cedict',
      'cedict',
      'cedict',
      'cedict',
      'cedict',
      'top2011',
      'moe-zh',
      'moe-zh',
    ]);
    expect(inv.candidates.find((c) => c.glossEn === 'scooter; motorcycle')?.tags).toEqual([
      'taiwan',
    ]);
    expect(inv.moeDefsZh).toEqual([
      '機器腳踏車的簡稱。參見「機器腳踏車」條。',
      '火車中配備動力發動機。',
    ]);
    expect(new Set(inv.candidates.map((c) => c.id)).size).toBe(inv.candidates.length);
  });

  it('picks a scooter sense, not "locomotive", and keeps the slang sense as an alternative', () => {
    const inv = buildInventory(jiche, sourcesFor(cedict, 'motorcycle'));
    const { senses } = heuristicSenses(inv, ['N']);
    expect(senses[0]!.glossEn).toMatch(/scooter|motorcycle/);
    expect(senses[0]!.taiwanOnly || senses[0]!.basedOn.includes('top2011')).toBeTruthy();
    expect(senses.map((s) => s.glossEn).join('|')).toContain('annoying');
    expect(senses.every((s) => s.glossEn.split(' ').length <= 6)).toBe(true);
    expect(senses.find((s) => /annoying/.test(s.glossEn))?.pos).toBe('Vs');
    expect(senses.every((s) => s.basedOn.length > 0)).toBe(true);
  });

  it('never picks a surname or "variant of" as the primary', () => {
    const src = sourcesFor('surname Huan/still/yet');
    const inv = buildInventory({ ...jiche, headword: '機車' }, src);
    expect(heuristicSenses(inv, ['Adv']).senses[0]!.glossEn).toMatch(/^still/);
  });

  it('drops mainland-only Wiktionary senses when a Taiwan alternative exists, keeps them labelled otherwise', () => {
    const wik = new Map([
      [
        '機車',
        [
          { pos: 'noun', glosses: ['locomotive'], tags: ['Mainland-China'], pinyinKeys: ['jīchē'] },
          { pos: 'noun', glosses: ['scooter'], tags: ['Taiwan'], pinyinKeys: ['jīchē'] },
        ],
      ],
    ]);
    const inv = buildInventory(jiche, { ...sourcesFor(''), wiktionary: wik });
    expect(inv.candidates.filter((c) => c.source === 'wiktionary').map((c) => c.glossEn)).toEqual([
      'scooter',
    ]);

    const onlyMainland = buildInventory(jiche, {
      ...sourcesFor(''),
      moe: MoeDictionary.fromEntries([]),
      wiktionary: new Map([
        [
          '機車',
          [{ pos: 'noun', glosses: ['locomotive'], tags: ['Mainland-China'], pinyinKeys: [] }],
        ],
      ]),
    });
    expect(onlyMainland.candidates.find((c) => c.source === 'wiktionary')?.tags).toContain(
      'mainland',
    );
  });

  it("keeps this reading's CEDICT sense primary over Wiktionary, without repeating clauses", () => {
    const wik = new Map([
      [
        '機車',
        [
          { pos: 'noun', glosses: ['to see again'], tags: [], pinyinKeys: ['jīchē'] },
          { pos: 'noun', glosses: ['scooter; motorbike'], tags: [], pinyinKeys: ['jīchē'] },
        ],
      ],
    ]);
    const inv = buildInventory(jiche, {
      ...sourcesFor('scooter/motorcycle'),
      moe: MoeDictionary.fromEntries([]),
      wiktionary: wik,
    });
    const { senses } = heuristicSenses(inv, ['V']);
    expect(senses[0]!.glossEn).toMatch(/^scooter/);
    const shown = senses.flatMap((s) => s.glossEn.split('; '));
    expect(shown.filter((g) => g === 'scooter')).toHaveLength(1);
  });

  it('teaches slang only when it is Taiwan usage', () => {
    const inv = buildInventory(
      jiche,
      sourcesFor('airport/(slang) flat chest/(Tw) (slang) hard to get along with'),
    );
    const shown = heuristicSenses(inv, ['N'])
      .senses.map((s) => s.glossEn)
      .join('; ');
    expect(shown).toContain('hard to get along with');
    expect(shown).not.toContain('flat chest');
  });

  it('ignores Wiktionary entries spanning several readings when CEDICT has this one', () => {
    const wik = new Map([
      ['機車', [{ pos: 'noun', glosses: ['where'], tags: [], pinyinKeys: ['jīchē', 'jìchē'] }]],
    ]);
    const inv = buildInventory(jiche, { ...sourcesFor('scooter'), wiktionary: wik });
    expect(inv.candidates.some((c) => c.source === 'wiktionary')).toBe(false);
  });

  it("gives erhua forms the base word's senses for the same reading", () => {
    const dir = tmp();
    const c = path.join(dir, 'c.csv');
    writeFileSync(
      c,
      'ID,Traditional,Simplified,Pinyin,POS,Variants,Meaning\n' +
        'L2-0259,一塊/一塊兒,一块/一块儿,yīkuài/yīkuàir,Adv,,"一塊 [yīkuài] together/in the same place<br> 一塊兒 [yīkuàir] erhua variant of 一塊|一块[yi1 kuai4]"\n',
    );
    const inv = buildInventory(
      { headword: '一塊兒', variants: [], pinyin: 'yī kuàir', pos: ['Adv'] },
      { cedict: loadTocflCedict(c), top2011: new Map(), moe: MoeDictionary.fromEntries([]) },
    );
    expect(heuristicSenses(inv, ['Adv']).senses[0]!.glossEn).toBe('together');
  });

  it('flags a word with no source at all', () => {
    const empty: GlossSources = {
      cedict: new Map(),
      top2011: new Map(),
      moe: MoeDictionary.fromEntries([]),
    };
    const inv = buildInventory(
      { headword: '陳雅婷', variants: [], pinyin: 'chén yǎ tíng', pos: ['Nb'] },
      empty,
    );
    expect(heuristicSenses(inv, ['Nb'])).toEqual({ senses: [], flags: ['no-source'] });
  });
});

describe('real data: the sources fix the glosses the old build got wrong', () => {
  const dir = path.resolve(__dirname, '../../../../../data/raw');
  const cedict = loadTocflCedict(path.join(dir, 'ivankra-tocfl-cedict.csv'));
  const top = loadTop2011(path.join(dir, 'ivankra-top-20111208.csv'));
  const src: GlossSources = { cedict, top2011: top, moe: MoeDictionary.fromEntries([]) };
  const primary = (headword: string, pinyin: string, pos: string[]) =>
    heuristicSenses(buildInventory({ headword, variants: [], pinyin, pos }, src), pos).senses[0]
      ?.glossEn;

  it('機車 -> motorcycle/scooter (was "locomotive; train engine car")', () => {
    expect(primary('機車', 'jī chē', ['N'])).toMatch(/scooter|motorcycle/);
  });
  it('還 hái -> still; 還 huán -> return/pay back (both were "surname Huan")', () => {
    expect(primary('還', 'hái', ['Adv'])).toMatch(/still|yet|also/);
    expect(primary('還', 'huán', ['V'])).toMatch(/pay back|return/);
  });
  it('長 cháng -> long; 長 zhǎng -> grow/chief (both were "long")', () => {
    expect(primary('長', 'cháng', ['Vs'])).toMatch(/long|length/);
    expect(primary('長', 'zhǎng', ['Vs'])).toMatch(/grow|chief|elder/);
  });
  it('打 dǎ (V) -> hit/beat (was "(loanword) dozen")', () => {
    expect(primary('打', 'dǎ', ['V'])).toMatch(/beat|hit|strike/);
  });
});

describe('adjudication validation', () => {
  const req: GlossAdjudicationRequest = {
    word: { id: 'w', headword: '機車', pinyin: 'jī chē', pos: ['N'], level: 'L2' },
    moeDefsZh: [],
    candidates: [
      { id: 'c1', source: 'cedict', glossEn: 'locomotive', tags: [] },
      { id: 'c2', source: 'cedict', glossEn: 'scooter; motorcycle', tags: ['taiwan'] },
      {
        id: 'c3',
        source: 'cedict',
        glossEn: 'hard to get along with; annoying',
        tags: ['taiwan', 'informal'],
      },
    ],
    examples: [],
  };
  const good = {
    senses: [
      { id: 's1', glossEn: 'scooter', basedOn: ['c2'], taiwanOnly: true },
      { id: 's2', glossEn: 'annoying', basedOn: ['c3'], register: 'slang' },
    ],
    primarySenseId: 's1',
    confidence: 'high',
  };

  it('accepts a condensation of cited candidates', () => {
    const v = validateAdjudication(good, req);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.senses.map((s) => s.glossEn)).toEqual(['scooter', 'annoying']);
      expect(v.value.senses[0]!.basedOn).toEqual(['cedict']);
      expect(v.value.primaryIndex).toBe(0);
    }
  });

  it('rejects invented glosses, unknown citations, long glosses, simplified text, bad primary', () => {
    const invented = validateAdjudication(
      { ...good, senses: [{ id: 's1', glossEn: 'a fast two wheeled bike', basedOn: ['c2'] }] },
      req,
    );
    expect(invented.ok).toBe(false);
    expect(
      validateAdjudication(
        { ...good, senses: [{ id: 's1', glossEn: 'scooter', basedOn: ['c99'] }] },
        req,
      ).ok,
    ).toBe(false);
    expect(
      validateAdjudication(
        {
          ...good,
          senses: [
            {
              id: 's1',
              glossEn: 'scooter motorcycle hard to get along with really',
              basedOn: ['c2', 'c3'],
            },
          ],
        },
        req,
      ).ok,
    ).toBe(false);
    expect(
      validateAdjudication(
        {
          ...good,
          senses: [{ id: 's1', glossEn: 'scooter', noteEn: '软件 style', basedOn: ['c2'] }],
        },
        req,
      ).ok,
    ).toBe(false);
    expect(validateAdjudication({ ...good, primarySenseId: 'zzz' }, req).ok).toBe(false);
    expect(validateAdjudication({ nope: 1 }, req).ok).toBe(false);
  });

  it('keeps the valid senses when one is rejected, and flags low confidence', () => {
    const v = validateAdjudication(
      {
        ...good,
        senses: [...good.senses, { id: 's3', glossEn: 'quantum thing', basedOn: ['c1'] }],
        confidence: 'low',
      },
      req,
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.flags).toEqual(['low-confidence', 'partly-rejected']);
  });
});

describe('resolveGloss precedence', () => {
  const inv = buildInventory(
    jiche,
    sourcesFor('locomotive/(Tw) scooter; motorcycle', 'motorcycle'),
  );
  const word = {
    id: 'w1',
    headword: '機車',
    pinyin: 'jī chē',
    pos: ['N'],
    glossEn: 'old gloss',
    source: 'tocfl' as const,
  };
  const req = buildAdjudicationRequest({ ...word, level: 'L2' }, inv);
  const aiResponse = {
    senses: [{ id: 's1', glossEn: 'locomotive', basedOn: ['c1'] }],
    primarySenseId: 's1',
    confidence: 'high',
  };
  const rec = { wordId: 'w1', hash: requestHash(req), response: aiResponse };
  const override = {
    word: '機車',
    pinyin: 'jī chē',
    senses: [{ glossEn: 'scooter; motorbike', taiwanOnly: true }],
  };

  it('an override always wins — over the AI answer and the heuristic', () => {
    const r = resolveGloss({
      word,
      inventory: inv,
      adjudication: rec,
      request: req,
      overrides: [override],
    });
    expect(r).toMatchObject({
      origin: 'override',
      glossEn: 'scooter; motorbike',
      glossSources: ['override'],
      primarySenseId: 'w1#1',
    });
    expect(resolveGloss({ word, inventory: inv, overrides: [override] }).origin).toBe('override');
  });

  it('an override matches by id too, and a different reading is not overridden', () => {
    expect(
      resolveGloss({ word, inventory: inv, overrides: [{ id: 'w1', senses: [{ glossEn: 'x' }] }] })
        .glossEn,
    ).toBe('x');
    expect(
      resolveGloss({ word, inventory: inv, overrides: [{ ...override, pinyin: 'jī chǎ' }] }).origin,
    ).toBe('heuristic');
  });

  it('a valid AI answer beats the heuristic; an invalid one falls back and is flagged', () => {
    expect(
      resolveGloss({ word, inventory: inv, adjudication: rec, request: req, overrides: [] }),
    ).toMatchObject({ origin: 'ai', glossEn: 'locomotive' });
    const bad = {
      ...rec,
      response: {
        senses: [{ id: 's1', glossEn: 'bicycle', basedOn: ['c1'] }],
        primarySenseId: 's1',
        confidence: 'high',
      },
    };
    const r = resolveGloss({
      word,
      inventory: inv,
      adjudication: bad,
      request: req,
      overrides: [],
    });
    expect(r.origin).toBe('heuristic');
    expect(r.flags).toContain('ai-rejected');
  });

  it('falls back to an authored gloss, then to nothing', () => {
    const empty = buildInventory(jiche, {
      cedict: new Map(),
      top2011: new Map(),
      moe: MoeDictionary.fromEntries([]),
    });
    expect(
      resolveGloss({ word: { ...word, source: 'supplement' }, inventory: empty, overrides: [] }),
    ).toMatchObject({ origin: 'authored', glossEn: 'old gloss', flags: [] });
    expect(
      resolveGloss({ word: { ...word, glossEn: '' }, inventory: empty, overrides: [] }),
    ).toMatchObject({ origin: 'none', flags: ['no-source'] });
  });

  it('loads the overrides yaml and validates it', () => {
    const f = path.join(tmp(), 'o.yaml');
    writeFileSync(f, '- word: 機車\n  senses:\n    - glossEn: scooter\n');
    expect(loadGlossOverrides(f)).toHaveLength(1);
    writeFileSync(f, '- senses:\n    - glossEn: x\n');
    expect(() => loadGlossOverrides(f)).toThrow();
    expect(loadGlossOverrides(path.join(tmp(), 'missing.yaml'))).toEqual([]);
  });
});

describe('resumable, rate-limit-aware adjudication run', () => {
  const mk = (n: number): GlossAdjudicationRequest => ({
    word: { id: `w${n}`, headword: `詞${n}`, pinyin: 'cí', pos: ['N'], level: 'N1' },
    moeDefsZh: [],
    candidates: [{ id: 'c1', source: 'cedict', glossEn: 'word', tags: [] }],
    examples: [],
  });
  const ok = {
    response: {
      senses: [{ id: 's1', glossEn: 'word', basedOn: ['c1'] }],
      primarySenseId: 's1',
      confidence: 'high',
    },
    tokens: 10,
  };

  it('backs off on 429 (honouring retry-after), then succeeds', async () => {
    const store = new AdjudicationStore(path.join(tmp(), 'a.jsonl'));
    let calls = 0;
    const waits: number[] = [];
    const summary = await runAdjudication({
      store,
      requests: [mk(1)],
      call: async () => {
        if (++calls < 3)
          throw new ProxyHttpError('rate limited', 429, calls === 1 ? 5000 : undefined);
        return ok;
      },
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([5000, 4000]); // retry-after, then 2s*2^1
    expect(summary).toMatchObject({ calls: 1, tokens: 10, failed: 0, rateLimitedStop: false });
  });

  it('stops cleanly when the limit persists and resumes without redoing finished words', async () => {
    const file = path.join(tmp(), 'a.jsonl');
    const requests = [mk(1), mk(2), mk(3)];
    let blockFrom = 2; // word 2 onwards is rate limited in the first run
    const call = async (r: GlossAdjudicationRequest) => {
      if (Number(r.word.id.slice(1)) >= blockFrom) throw new ProxyHttpError('rate limited', 429);
      return ok;
    };
    const first = await runAdjudication({
      store: new AdjudicationStore(file),
      requests,
      call,
      maxRetries: 1,
      sleep: async () => undefined,
    });
    expect(first).toMatchObject({ calls: 1, rateLimitedStop: true });

    blockFrom = 99;
    let secondCalls = 0;
    const second = await runAdjudication({
      store: new AdjudicationStore(file), // a fresh process reading the same file
      requests,
      call: async (r) => (secondCalls++, call(r)),
      sleep: async () => undefined,
    });
    expect(second).toMatchObject({ calls: 2, cached: 1, rateLimitedStop: false });
    expect(secondCalls).toBe(2);
  });

  it('re-asks a word when its candidates changed, honours the limit, and records failures', async () => {
    const file = path.join(tmp(), 'a.jsonl');
    await runAdjudication({
      store: new AdjudicationStore(file),
      requests: [mk(1)],
      call: async () => ok,
    });
    const changed = {
      ...mk(1),
      candidates: [{ id: 'c1', source: 'cedict' as const, glossEn: 'other', tags: [] }],
    };
    let asked = 0;
    await runAdjudication({
      store: new AdjudicationStore(file),
      requests: [changed],
      call: async () => (asked++, ok),
    });
    expect(asked).toBe(1);

    const limited = await runAdjudication({
      store: new AdjudicationStore(path.join(tmp(), 'b.jsonl')),
      requests: [mk(1), mk(2), mk(3)],
      call: async () => ok,
      limit: 2,
    });
    expect(limited.calls).toBe(2);
    const failing = await runAdjudication({
      store: new AdjudicationStore(path.join(tmp(), 'c.jsonl')),
      requests: [mk(1)],
      call: async () => {
        throw new Error('boom');
      },
    });
    expect(failing.failed).toBe(1);
  });

  it('proxyCall posts to /v1/gloss and surfaces 429 + token usage', async () => {
    const fake = (async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).word.id).toBe('w1');
      return new Response(JSON.stringify(ok.response), {
        status: 200,
        headers: { 'x-total-tokens': '42' },
      });
    }) as unknown as typeof fetch;
    expect((await proxyCall('http://p', fake)(mk(1))).tokens).toBe(42);
    const limited = (async () =>
      new Response(JSON.stringify({ error: 'rate limited', retryAfterMs: 1234 }), {
        status: 429,
      })) as unknown as typeof fetch;
    await expect(proxyCall('http://p', limited)(mk(1))).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 1234,
    });
  });
});

describe('optional heavy sources', () => {
  it('streams a wiktextract JSONL keeping only wanted headwords', async () => {
    const f = path.join(tmp(), 'k.jsonl');
    const line = (o: unknown) => JSON.stringify(o);
    writeFileSync(
      f,
      [
        line({
          word: '機車',
          pos: 'noun',
          sounds: [{ 'zh-pron': 'jī​chē' }],
          senses: [{ glosses: ['scooter'], tags: ['Taiwan'] }],
        }),
        line({ word: '別的', pos: 'noun', senses: [{ glosses: ['x'] }] }),
        'not json',
      ].join('\n'),
    );
    const map = await loadWiktionary(f, new Set(['機車']));
    expect([...map.keys()]).toEqual(['機車']);
    expect(map.get('機車')![0]).toMatchObject({
      pos: 'noun',
      glosses: ['scooter'],
      tags: ['Taiwan'],
    });
    expect((await loadWiktionary(path.join(tmp(), 'absent'), new Set(['機車']))).size).toBe(0);
  });

  it('reads current wiktextract sounds (zh_pron) and keeps only standard-Mandarin pinyin', async () => {
    const f = path.join(tmp(), 'k.jsonl');
    writeFileSync(
      f,
      JSON.stringify({
        word: '炸',
        pos: 'character',
        sounds: [
          { zh_pron: 'zhà (zha⁴)', tags: ['Mandarin', 'Pinyin'] },
          { zh_pron: 'zhà', tags: ['Mandarin', 'Standard-Chinese', 'Pinyin'] },
          { zh_pron: 'za⁴', tags: ['Mandarin', 'Chengdu', 'Sichuanese', 'Pinyin'] },
          { zh_pron: 'ㄓㄚˋ', tags: ['Mandarin', 'Bopomofo'] },
        ],
        senses: [{ glosses: ['to explode'] }],
      }),
    );
    const map = await loadWiktionary(f, new Set(['炸']));
    expect(map.get('炸')![0]!.pinyinKeys).toEqual(['zhà']);
    // …so the zhà sense never reaches 炸 zhá ("to deep fry").
    const inv = buildInventory(
      { headword: '炸', variants: [], pinyin: 'zhá', pos: ['V'] },
      { ...sourcesFor(''), moe: MoeDictionary.fromEntries([]), wiktionary: map },
    );
    expect(inv.candidates.filter((c) => c.source === 'wiktionary')).toEqual([]);
  });

  it('follows soft redirects from Taiwan spellings to the entry with senses', async () => {
    const f = path.join(tmp(), 'k.jsonl');
    const line = (o: unknown) => JSON.stringify(o);
    writeFileSync(
      f,
      [
        line({
          word: '汙染',
          pos: 'soft-redirect',
          redirects: ['污染'],
          senses: [{ tags: ['no-gloss'] }],
        }),
        line({
          word: '污染',
          pos: 'verb',
          senses: [
            { glosses: ['to pollute; to contaminate'], tags: ['figuratively', 'literally'] },
          ],
        }),
      ].join('\n'),
    );
    const map = await loadWiktionary(f, new Set(['汙染']));
    expect(map.get('汙染')?.map((s) => s.glosses[0])).toEqual(['to pollute; to contaminate']);
  });

  it.each([
    ['衣服 "ecstasy" (Taiwan slang)', 'noun', 'ecstasy; MDMA', ['Taiwan', 'slang'], false],
    ['唱歌 "to urinate" (Wu)', 'verb', 'to urinate', ['Wu', 'humorous'], false],
    ['再見 literal reading', 'verb', 'to see (a person) again', ['literally'], false],
    ['污染 literal and figurative', 'verb', 'to pollute', ['figuratively', 'literally'], true],
    ['衣服 Classical verb', 'verb', 'to put on clothes', ['Classical'], false],
    ['年 surname', 'character', 'a surname', [], false],
    ['星星 place name', 'name', 'Xingxing (a community in Chengzhong, Hubei, China)', [], false],
    ['機車 Taiwan sense', 'noun', 'scooter', ['Taiwan'], true],
  ])('Wiktionary sense filter: %s', (_label, _pos, gloss, tags, ok) => {
    expect(isUsableWiktionarySense(gloss, tags)).toBe(ok);
  });

  it('tidies Wiktionary glosses to CEDICT shape', () => {
    expect(tidyWiktionaryGloss('Classifier for years.')).toBe('classifier for years');
    expect(tidyWiktionaryGloss('clothing; clothes (Classifier: 件 m)')).toBe('clothing; clothes');
    expect(tidyWiktionaryGloss('Spanish')).toBe('Spanish');
    expect(tidyWiktionaryGloss('Africa')).toBe('Africa');
  });

  it('reads Unihan kDefinition lines', () => {
    const f = path.join(tmp(), 'u.txt');
    writeFileSync(
      f,
      '# comment\nU+6A5F\tkDefinition\tmachine, engine; opportunity\nU+8ECA\tkMandarin\tchē\nU+8ECA\tkDefinition\tvehicle, cart\n',
    );
    expect(loadUnihanDefinitions(f)).toEqual(
      new Map([
        ['機', 'machine, engine; opportunity'],
        ['車', 'vehicle, cart'],
      ]),
    );
    expect(readFileSync(f, 'utf8')).toContain('kDefinition');
  });
});

describe('authored supplement glosses', () => {
  it('beat the heuristic and split into senses with POS/register markers', async () => {
    const { sensesFromAuthored, resolveGloss: resolve } = await import('./resolve.js');
    expect(
      sensesFromAuthored('scooter/motorbike; (slang, Vs) annoying, difficult to deal with', 'N'),
    ).toEqual([
      { glossEn: 'scooter/motorbike', pos: 'N', register: undefined, basedOn: ['supplement'] },
      {
        glossEn: 'annoying, difficult to deal with',
        pos: 'Vs',
        register: 'slang',
        basedOn: ['supplement'],
      },
    ]);
    const inv = buildInventory(jiche, sourcesFor('locomotive/(Tw) scooter', 'motorcycle'));
    const r = resolve({
      word: {
        id: 'supp1',
        headword: '機車',
        pinyin: 'jī chē',
        pos: ['N', 'Vs'],
        glossEn: 'scooter/motorbike; (slang, Vs) annoying',
        source: 'supplement',
      },
      inventory: inv,
      overrides: [],
    });
    expect(r).toMatchObject({
      origin: 'authored',
      glossSources: ['supplement'],
      glossEn: 'scooter/motorbike',
    });
    expect(r.senses[1]).toMatchObject({ glossEn: 'annoying', pos: 'Vs', register: 'slang' });
  });
});
