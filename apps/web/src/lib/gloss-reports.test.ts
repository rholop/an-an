import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LEARNER_CONFIG,
  Lexicon,
  type Scenario,
  type TurnResponse,
  type Word,
} from '@anan/core';
import { exportBackup, importBackup } from '../db/backup.js';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { ChatService } from './chat-service.js';
import { FakeTutorLLM } from './fake-tutor-llm.js';
import { annotate } from './annotate.js';
import {
  DefineError,
  defineUnlisted,
  exportReportsAsOverridesYaml,
  reportGloss,
} from './gloss-reports.js';
import { LearnerService } from './learner-service.js';

let db: AnanDB;
beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
});
afterEach(async () => {
  await db.delete();
});

const word = (id: string, headword: string, over: Partial<Word> = {}): Word => ({
  id,
  headword,
  variants: [],
  pos: ['N'],
  level: 'N2',
  source: 'tocfl',
  pinyin: 'jī chē',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: 'scooter',
  chars: [...headword],
  tags: [],
  ...over,
});

const jiche = word('w-jc', '機車', {
  senses: [
    { id: 'w-jc#1', glossEn: 'scooter', pos: 'N', basedOn: ['cedict'], taiwanOnly: true },
    {
      id: 'w-jc#2',
      glossEn: 'annoying',
      pos: 'Vs',
      register: 'slang',
      basedOn: ['cedict'],
      taiwanOnly: true,
    },
  ],
  primarySenseId: 'w-jc#1',
  moeDefZh: ['機器腳踏車的簡稱。'],
});
const lexicon = new Lexicon([
  jiche,
  word('w-i', '我', { pinyin: 'wǒ', glossEn: 'I' }),
  word('w-ride', '騎', { pinyin: 'qí', glossEn: 'to ride', pos: ['V'] }),
  word('w-very', '很', { pinyin: 'hěn', glossEn: 'very' }),
  word('w-he', '他', { pinyin: 'tā', glossEn: 'he' }),
]);

describe('sense shown for a token', () => {
  const gloss = (text: string, hints?: Map<string, string>) =>
    annotate(text, lexicon, hints).find((a) => a.token.text === '機車')!.gloss;

  it('is "scooter" getting around and "annoying" in 他很機車', () => {
    expect(gloss('我騎機車')).toBe('scooter');
    expect(gloss('他很機車')).toBe('annoying');
  });

  it("uses the model's sense_id when it is real, ignores one it invented", () => {
    expect(gloss('我騎機車', new Map([['機車', 'w-jc#2']]))).toBe('annoying');
    expect(gloss('他很機車', new Map([['機車', 'w-jc#99']]))).toBe('annoying'); // invented: rules decide
    expect(gloss('機車', new Map([['機車', 'bogus']]))).toBe('scooter'); // primary
  });

  it('carries the chosen sense, the other senses and the MOE definition to the popover', () => {
    const at = annotate('他很機車', lexicon).find((a) => a.token.text === '機車')!;
    expect(at.sense?.id).toBe('w-jc#2');
    expect(at.word?.senses).toHaveLength(2);
    expect(at.word?.moeDefZh).toEqual(['機器腳踏車的簡稱。']);
  });
});

describe('report this definition', () => {
  it('stores the report and exports an overrides-yaml list', async () => {
    await reportGloss(db, {
      word: jiche,
      sense: jiche.senses![0],
      shownGloss: 'scooter',
      contextSentence: '我騎機車',
      note: 'should say "scooter; motorbike"',
    });
    await reportGloss(db, {
      word: jiche,
      sense: jiche.senses![0],
      shownGloss: 'scooter',
      contextSentence: '機車很多',
    });
    const reports = await db.glossReports.toArray();
    expect(reports).toHaveLength(2);
    const yaml = exportReportsAsOverridesYaml(reports, [
      { key: 'k', word: '烏龍', pinyin: 'wū lóng', glossEn: 'oolong', at: new Date() },
    ]);
    expect(yaml).toContain('- id: "w-jc"');
    expect(yaml).toContain('word: "機車"');
    expect(yaml).toContain('glossEn: "scooter"');
    expect(yaml.match(/- id:/g)).toHaveLength(1); // grouped per word
    expect(yaml).toContain('reported in: 我騎機車');
    expect(yaml).toContain('# review (AI-generated, not in the lexicon): 烏龍');
  });

  it('survives export -> import', async () => {
    await reportGloss(db, { word: jiche, shownGloss: 'scooter', contextSentence: 'x' });
    await db.aiGlosses.put({ key: 'k', word: 'w', pinyin: 'p', glossEn: 'g', at: new Date() });
    const backup = JSON.parse(JSON.stringify(await exportBackup(db)));
    await importBackup(db, backup);
    expect(await db.glossReports.count()).toBe(1);
    expect(await db.aiGlosses.count()).toBe(1);
  });
});

describe('AI definitions for unlisted words only', () => {
  it('caches per word+context (one call), validates, and queues the result', async () => {
    const llm = new FakeTutorLLM();
    const first = await defineUnlisted(db, llm, '烏龍', '喝烏龍茶');
    expect(first).toMatchObject({ aiGenerated: true, cached: false });
    const second = await defineUnlisted(db, llm, '烏龍', '喝烏龍茶');
    expect(second.cached).toBe(true);
    expect(await db.aiGlosses.count()).toBe(1);
  });

  it('rejects unusable or non-Taiwan answers', async () => {
    const bad = (glossEn: string) => ({ defineWord: async () => ({ pinyin: 'x', glossEn }) });
    await expect(
      defineUnlisted(db, bad('one two three four five six seven eight nine ten'), 'x'),
    ).rejects.toBeInstanceOf(DefineError);
    await expect(defineUnlisted(db, bad('软件'), 'y')).rejects.toBeInstanceOf(DefineError);
    expect(await db.aiGlosses.count()).toBe(0);
  });
});

describe('chat offers sense options and validates the sense ids it gets back', () => {
  const scenario: Scenario = {
    id: 'ride',
    title: 'Getting around',
    levelRange: { min: 'N1', max: 'L2' },
    npc: { id: 'n', name: '路人', personality: 'p', speechStyle: 's', particles: [] },
    setting: 's',
    goalSteps: [{ id: 'g', description: 'd', keywordHints: [] }],
    vocabExtras: ['機車'],
    opener: { zh: '你好！', en: 'Hi' },
    successLine: { zh: '再見！', en: 'Bye' },
  };

  it('sends options only for multi-sense words and drops invented ids', async () => {
    const seen: (string[] | undefined)[] = [];
    const reply: TurnResponse = {
      reply_zh: '他很機車。',
      reply_en: 'He is annoying.',
      tokens: [{ text: '他' }, { text: '很' }, { text: '機車', sense_id: 'w-jc#2' }],
      targets_used: [],
      suggested_replies: [],
      goal_progress: [],
    };
    let response = reply;
    const llm = new FakeTutorLLM((req) => {
      seen.push(
        req.vocab.senseOptions?.map((o) => `${o.word}:${o.senses.map((s) => s.id).join(',')}`),
      );
      return response;
    });
    const svc = new ChatService(
      db,
      lexicon,
      new LearnerService(new DexieLearnerRepo(db), DEFAULT_LEARNER_CONFIG),
      llm,
    );
    const id = await svc.startConversation(scenario);
    await svc.sendLearnerTurn(id, scenario, '你好', {
      learnerLevel: 'L1',
      scaffolding: 'high',
      englishFallback: false,
    });
    expect(seen[0]).toEqual(['機車:w-jc#1,w-jc#2']); // 我/騎/很/他 have one sense (or none): not offered
    expect((await svc.getTurns(id)).at(-1)!.tokens!.find((t) => t.text === '機車')!.sense_id).toBe(
      'w-jc#2',
    );

    response = { ...reply, tokens: [{ text: '機車', sense_id: 'made-up' }] };
    await svc.sendLearnerTurn(id, scenario, '再來', {
      learnerLevel: 'L1',
      scaffolding: 'high',
      englishFallback: false,
    });
    expect((await svc.getTurns(id)).at(-1)!.tokens![0]!.sense_id).toBeUndefined();
  });
});
