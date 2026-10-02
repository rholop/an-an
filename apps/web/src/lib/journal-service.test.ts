import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSession, Lexicon, type JournalReview, type Word } from '@anan/core';
import { exportBackup, importBackup } from '../db/backup.js';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { allJournalSentences } from '../db/queries.js';
import { AnanDB } from '../db/schema.js';
import { FakeTutorLLM } from './fake-tutor-llm.js';
import { journalFlagStats, JournalError, JournalService } from './journal-service.js';
import { LearnerService } from './learner-service.js';

let db: AnanDB;
let learnerService: LearnerService;
const now = new Date('2026-03-01T10:00:00Z');

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  learnerService = new LearnerService(new DexieLearnerRepo(db));
});
afterEach(async () => {
  await db.delete();
});

function word(partial: Partial<Word> & Pick<Word, 'id' | 'headword'>): Word {
  return {
    variants: [],
    pos: ['N'],
    level: 'N1',
    source: 'tocfl',
    pinyin: '',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn: '',
    chars: [...partial.headword],
    tags: [],
    ...partial,
  };
}

const WORDS = [
  word({ id: 'w-today', headword: '今天', glossEn: 'today' }),
  word({ id: 'w-i', headword: '我' }),
  word({ id: 'w-go', headword: '去', pos: ['V'] }),
  word({ id: 'w-le', headword: '了', tags: ['particle'] }),
  word({ id: 'w-like', headword: '喜歡', pos: ['V'] }),
  word({ id: 'w-coffee', headword: '咖啡', glossEn: 'coffee' }),
  word({ id: 'w-mrt', headword: '捷運' }),
  word({ id: 'w-gym', headword: '健身房', glossEn: 'gym; fitness center', level: 'L3' }),
  word({ id: 'w-buy', headword: '買', pos: ['V'] }),
  word({ id: 'w-phone', headword: '手機' }),
];
const lexicon = new Lexicon(WORDS);

function service(llm: FakeTutorLLM, lex: Lexicon = lexicon) {
  let n = 0;
  return new JournalService(db, lex, learnerService, llm, undefined, () => `entry-${++n}`);
}

const issue = (
  text: string,
  sub: string,
  correction: string,
  over: Record<string, unknown> = {},
) => ({
  span: [text.indexOf(sub), text.indexOf(sub) + sub.length] as [number, number],
  type: 'error' as const,
  correction,
  explanationEn: 'Because.',
  confidence: 'high' as const,
  ...over,
});
const review = (over: Partial<JournalReview>): JournalReview => ({
  issues: [],
  natural_rewrite: '',
  brackets: [],
  used_well: [],
  ...over,
});

describe('JournalService.submit', () => {
  it('stores a validated, capped review and starts self-correction', async () => {
    const text = '今天我去地鐵，我喜歡咖啡，我買手機。';
    const llm = new FakeTutorLLM(undefined, {
      review: () =>
        review({
          issues: [
            issue(text, '今天', '昨天', { type: 'unnatural' }),
            issue(text, '地鐵', '捷運', { type: 'mainland_style' }),
            issue(text, '喜歡', '愛', { type: 'unnatural', confidence: 'low' }),
            issue(text, '咖啡', '茶', { type: 'unnatural' }),
            issue(text, '手機', '软件'), // simplified -> rejected
            issue(text, '買', '賣'),
            issue(text, '去', '來'),
          ],
        }),
    });
    const { entry, review: row } = await service(llm).submit({ text, learnerLevel: 'L1' }, now);
    expect(row.issues).toHaveLength(3);
    expect(row.issues.filter((i) => i.type === 'error')).toHaveLength(2);
    expect(row.rejectedCount).toBeGreaterThanOrEqual(1);
    expect(entry.status).toBe('self_correcting');
    expect(await db.journalEntries.count()).toBe(1);
    expect(await db.errorItems.count()).toBe(0); // nothing enters the bank before the entry is finished
  });

  it("sends the learner's recent error patterns and the prompt words to the model", async () => {
    const seen: { recurringPatterns: string[]; promptWords: string[] }[] = [];
    const llm = new FakeTutorLLM(undefined, {
      review: (req) => {
        seen.push({ recurringPatterns: req.recurringPatterns, promptWords: req.promptWords });
        return review({});
      },
    });
    const svc = service(llm);
    await db.errorItems.bulkAdd(
      ['a', 'b'].map((id) => ({
        id,
        journalEntryId: id,
        original: '我去。',
        corrected: '我去了。',
        span: [1, 2] as [number, number],
        type: 'error' as const,
        pattern: '了-placement',
        card: {
          due: now,
          stability: 0,
          difficulty: 0,
          elapsed_days: 0,
          scheduled_days: 0,
          learning_steps: 0,
          reps: 0,
          lapses: 0,
          state: 0,
        },
        flagged: false,
        createdAt: new Date('2026-02-20'),
      })),
    );
    await svc.submit({ text: '我去咖啡。', learnerLevel: 'N2', promptWordIds: ['w-go'] }, now);
    expect(seen[0]).toEqual({ recurringPatterns: ['了-placement'], promptWords: ['去'] });
  });

  it('writes nothing if the LLM call fails', async () => {
    const llm = new FakeTutorLLM(undefined, {
      review: () => {
        throw new Error('proxy down');
      },
    });
    await expect(service(llm).submit({ text: '我去。', learnerLevel: 'N1' }, now)).rejects.toThrow(
      'proxy down',
    );
    expect(await db.journalEntries.count()).toBe(0);
  });

  it('rejects an empty entry and a malformed model response', async () => {
    await expect(
      service(new FakeTutorLLM()).submit({ text: '  ', learnerLevel: 'N1' }),
    ).rejects.toBeInstanceOf(JournalError);
    const bad = new FakeTutorLLM(undefined, {
      review: () => ({ issues: 'x' }) as unknown as JournalReview,
    });
    await expect(service(bad).submit({ text: '我去。', learnerLevel: 'N1' })).rejects.toThrow(
      /wrong shape/,
    );
  });

  it('skips self-correction when there is nothing to fix', async () => {
    const { entry } = await service(
      new FakeTutorLLM(undefined, { review: () => review({}) }),
    ).submit({ text: '我喜歡咖啡。', learnerLevel: 'N1' }, now);
    expect(entry.status).toBe('revealed');
  });
});

describe('bracket gaps', () => {
  it('translates from the lexicon first and queues a priority production item that the next session serves first', async () => {
    const llm = new FakeTutorLLM(undefined, {
      // the model disagrees with the lexicon: the lexicon must win
      review: () => review({ brackets: [{ en: 'gym', zh: '體育館' }] }),
    });
    const { review: row } = await service(llm).submit(
      { text: '今天我去 [gym]。', learnerLevel: 'L1' },
      now,
    );
    expect(row.brackets).toEqual([{ en: 'gym', zh: '健身房', wordId: 'w-gym', source: 'lexicon' }]);

    const card = await learnerService.getCard({ kind: 'word', id: 'w-gym' }, 'production');
    expect(card?.flags.priority).toBe(true);
    expect(card?.card.due.getTime()).toBeLessThanOrEqual(now.getTime());

    const dueCards = await learnerService.dueCards(new Date(now.getTime() + 1000), 100);
    const filler = ['w-i', 'w-go', 'w-buy', 'w-phone', 'w-mrt', 'w-coffee'].map((id) => ({
      ...card!,
      flags: {},
      item: { kind: 'word' as const, id },
    }));
    const session = buildSession([...filler, ...dueCards], {
      lexicon,
      knownIds: new Set(),
      learnerLevel: 'L3',
      config: { maxNewItems: 1 },
      rng: () => 0.9,
    });
    expect(session.map((s) => s.word.headword)).toEqual(['健身房']);
  });

  it('falls back to the model translation, creating a custom word when the lexicon lacks it', async () => {
    const llm = new FakeTutorLLM(undefined, {
      review: () => review({ brackets: [{ en: 'barbell', zh: '槓鈴' }] }),
    });
    const { review: row } = await service(llm).submit(
      { text: '我買 [barbell]。', learnerLevel: 'L1' },
      now,
    );
    expect(row.brackets[0]).toMatchObject({ en: 'barbell', zh: '槓鈴', source: 'llm' });
    const custom = await db.customWords.toArray();
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ headword: '槓鈴', source: 'custom', glossEn: 'barbell' });
    expect(
      (await learnerService.getCard({ kind: 'word', id: custom[0]!.id }, 'production'))?.flags
        .priority,
    ).toBe(true);
  });

  it('leaves a gap unresolved (and adds nothing) when neither lexicon nor model can translate it', async () => {
    const llm = new FakeTutorLLM(undefined, {
      review: () => review({ brackets: [{ en: 'barbell', zh: '软件' }] }),
    }); // simplified -> rejected
    const { review: row } = await service(llm).submit(
      { text: '我買 [barbell]。', learnerLevel: 'L1' },
      now,
    );
    expect(row.brackets[0]).toMatchObject({ en: 'barbell', source: 'unresolved' });
    expect(await db.customWords.count()).toBe(0);
  });
});

describe('self-correction and reveal', () => {
  const text = '今天我去地鐵。';
  const setup = async () => {
    const llm = new FakeTutorLLM(undefined, {
      review: () =>
        review({
          issues: [
            issue(text, '地鐵', '捷運', { type: 'mainland_style', pattern: 'mainland-vocab' }),
          ],
        }),
    });
    const svc = service(llm);
    const { entry } = await svc.submit({ text, learnerLevel: 'L1' }, now);
    return { svc, llm, id: entry.id };
  };

  it('credits an exact self-fix locally, without an LLM call', async () => {
    const { svc, llm, id } = await setup();
    expect(await svc.recheckSpan(id, 0, '捷運')).toEqual({ attempt: '捷運', fixed: true });
    expect(llm.journalCalls.check).toBe(0);
  });

  it('treats an unchanged span as not self-fixed', async () => {
    const { svc, id } = await setup();
    expect((await svc.recheckSpan(id, 0, '地鐵')).fixed).toBe(false);
  });

  it('asks the LLM once about a differing alternative and caches the answer per attempt', async () => {
    const llm = new FakeTutorLLM(undefined, {
      review: () => review({ issues: [issue(text, '地鐵', '捷運', { type: 'mainland_style' })] }),
      check: () => ({ acceptable: true, noteEn: 'Also fine.' }),
    });
    const svc = service(llm);
    const { entry } = await svc.submit({ text, learnerLevel: 'L1' }, now);
    const first = await svc.recheckSpan(entry.id, 0, '地下鐵');
    expect(first).toMatchObject({ fixed: true, alternative: true, note: 'Also fine.' });
    await svc.recheckSpan(entry.id, 0, '地下鐵');
    expect(llm.journalCalls.check).toBe(1);
  });

  it('never accepts a simplified or mainland alternative, and never asks the LLM about it', async () => {
    const { svc, llm, id } = await setup();
    expect((await svc.recheckSpan(id, 0, '地铁')).fixed).toBe(false);
    expect(llm.journalCalls.check).toBe(0);
  });

  it('survives a failing alternatives check', async () => {
    const llm = new FakeTutorLLM(undefined, {
      review: () => review({ issues: [issue(text, '地鐵', '捷運')] }),
      check: () => {
        throw new Error('down');
      },
    });
    const svc = service(llm);
    const { entry } = await svc.submit({ text, learnerLevel: 'L1' }, now);
    expect(await svc.recheckSpan(entry.id, 0, '地下鐵')).toMatchObject({ fixed: false });
  });

  it('reveals only on request, and explain-more is cached and filtered', async () => {
    const llm = new FakeTutorLLM(undefined, {
      review: () => review({ issues: [issue(text, '地鐵', '捷運')] }),
      explain: () => ({
        explanationEn: 'More.',
        examples: [
          { zh: '我搭捷運。', en: 'I take the MRT.' },
          { zh: '我坐地铁。', en: 'bad' },
        ],
      }),
    });
    const svc = service(llm);
    const { entry } = await svc.submit({ text, learnerLevel: 'L1' }, now);
    expect((await svc.getEntry(entry.id))!.status).toBe('self_correcting');
    await svc.reveal(entry.id);
    expect((await svc.getEntry(entry.id))!.status).toBe('revealed');
    const more = await svc.explainMore(entry.id, 0);
    expect(more.examples).toHaveLength(1);
    await svc.explainMore(entry.id, 0);
    expect(llm.journalCalls.explain).toBe(1);
  });
});

describe('finish: error bank and evidence', () => {
  const text = '今天我去地鐵，我喜歡咖啡，我買了手機。';
  const llm = () =>
    new FakeTutorLLM(undefined, {
      review: () =>
        review({
          issues: [
            issue(text, '地鐵', '捷運', {
              type: 'mainland_style',
              pattern: 'mainland-vocab',
              itemRef: { kind: 'word', id: 'w-mrt' },
            }),
            issue(text, '買了', '買', {
              pattern: '了-placement',
              itemRef: { kind: 'word', id: 'w-buy' },
            }),
          ],
          used_well: [
            {
              itemRef: { kind: 'word', id: 'w-like' },
              span: [text.indexOf('喜歡'), text.indexOf('喜歡') + 2],
            },
          ],
        }),
    });

  it('flagged corrections never enter the error bank or evidence, and are counted', async () => {
    const svc = service(llm());
    const { entry } = await svc.submit({ text, learnerLevel: 'L1' }, now);
    expect(await svc.toggleFlag(entry.id, 1)).toBe(true);
    const { errorItemCount, evidence } = await svc.finish(entry.id, now);
    expect(errorItemCount).toBe(1);
    const items = await db.errorItems.toArray();
    expect(items.map((i) => i.pattern)).toEqual(['mainland-vocab']);
    expect(evidence.some((e) => e.item.id === 'w-buy')).toBe(false);
    expect(await journalFlagStats(db)).toEqual({ flagged: 1, shown: 2 });
  });

  it('un-flagging restores the correction before the entry is finished', async () => {
    const svc = service(llm());
    const { entry } = await svc.submit({ text, learnerLevel: 'L1' }, now);
    await svc.toggleFlag(entry.id, 1);
    expect(await svc.toggleFlag(entry.id, 1)).toBe(false);
    expect((await svc.finish(entry.id, now)).errorItemCount).toBe(2);
  });

  it('records production evidence: misuse (milder when self-fixed), used_well, and correct prompt words', async () => {
    const svc = service(llm());
    const { entry } = await svc.submit(
      { text, learnerLevel: 'L1', promptWordIds: ['w-coffee', 'w-phone', 'w-buy'] },
      now,
    );
    await svc.recheckSpan(entry.id, 0, '捷運'); // self-fixed
    await svc.reveal(entry.id);
    await svc.finish(entry.id, now);

    const evidence = await db.evidence.toArray();
    const by = (id: string) => evidence.find((e) => e.item.id === id);
    expect(by('w-mrt')).toMatchObject({
      kind: 'journal_misuse',
      skill: 'production',
      context: { source: 'journal', selfFixed: true },
    });
    expect(by('w-buy')).toMatchObject({ kind: 'journal_misuse', context: { selfFixed: false } });
    expect(by('w-like')?.kind).toBe('journal_correct_use');
    expect(by('w-coffee')?.kind).toBe('journal_correct_use'); // prompt word used correctly
    expect(by('w-phone')?.kind).toBe('journal_correct_use');

    // self-fixed misuse: introduced but not rated; unaided misuse: rated Hard
    expect(
      (await learnerService.getCard({ kind: 'word', id: 'w-mrt' }, 'production'))?.card.reps,
    ).toBe(0);
    expect(
      (await learnerService.getCard({ kind: 'word', id: 'w-buy' }, 'production'))?.card.reps,
    ).toBe(1);
  });

  it('builds cloze-ready error items scoped to the sentence, and finishing twice is harmless', async () => {
    const svc = service(llm());
    const { entry } = await svc.submit({ text, learnerLevel: 'L1' }, now);
    await svc.finish(entry.id, now);
    await svc.finish(entry.id, now);
    const items = await db.errorItems.toArray();
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.pattern === 'mainland-vocab')).toMatchObject({
      original: '今天我去地鐵，我喜歡咖啡，我買了手機。',
      corrected: expect.stringContaining('捷運'),
      journalEntryId: entry.id,
    });
    expect(await db.evidence.count()).toBe(3); // 2 misuse + 1 used_well, once
    await expect(svc.toggleFlag(entry.id, 0)).rejects.toBeInstanceOf(JournalError);
  });

  it('only finished entries feed cloze, minus sentences with issues', async () => {
    const t = '我喜歡咖啡。今天我去地鐵。';
    const svc = service(
      new FakeTutorLLM(undefined, {
        review: () => review({ issues: [issue(t, '地鐵', '捷運', { type: 'mainland_style' })] }),
      }),
    );
    const { entry } = await svc.submit({ text: t, learnerLevel: 'L1' }, now);
    expect(await allJournalSentences(db)).toEqual([]);
    await svc.finish(entry.id, now);
    expect((await allJournalSentences(db)).map((s) => s.zh)).toEqual(['我喜歡咖啡。']);
  });
});

describe('persistence', () => {
  it('journal tables survive an export -> import round trip', async () => {
    const text = '今天我去地鐵。';
    const svc = service(
      new FakeTutorLLM(undefined, {
        review: () =>
          review({
            issues: [issue(text, '地鐵', '捷運', { type: 'mainland_style', pattern: 'p' })],
          }),
      }),
    );
    const { entry } = await svc.submit({ text, learnerLevel: 'L1' }, now);
    await svc.finish(entry.id, now);
    const before = {
      e: await db.journalEntries.toArray(),
      r: await db.journalReviews.toArray(),
      i: await db.errorItems.toArray(),
    };

    const backup = JSON.parse(JSON.stringify(await exportBackup(db)));
    await Promise.all([
      db.journalEntries.clear(),
      db.journalReviews.clear(),
      db.errorItems.clear(),
    ]);
    await importBackup(db, backup);
    expect({
      e: await db.journalEntries.toArray(),
      r: await db.journalReviews.toArray(),
      i: await db.errorItems.toArray(),
    }).toEqual(before);
  });

  it('imports a pre-Phase-5 (v1) backup with empty journal tables', async () => {
    const backup = JSON.parse(JSON.stringify(await exportBackup(db)));
    delete backup.journalEntries;
    delete backup.journalReviews;
    delete backup.errorItems;
    backup.schemaVersion = 1;
    await expect(importBackup(db, backup)).resolves.toBeDefined();
    expect(await db.errorItems.count()).toBe(0);
  });

  it('upgrades a v1 database to v2 without losing data', async () => {
    const name = `anan-upgrade-${Math.random()}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({
      items: 'pk, state, [item.id+skill], card.due, card.lapses, leech',
      evidence: '++id, at, [item.id], kind',
      settings: 'key',
      meta: 'key',
      customWords: 'id, headword',
      conversations: '++id, scenarioId, startedAt',
      turns: '++id, conversationId, at',
    });
    await v1.open();
    await v1.table('settings').put({ key: 'targetRetention', value: 0.9 });
    v1.close();

    const upgraded = new AnanDB(name);
    expect(await upgraded.settings.get('targetRetention')).toMatchObject({
      key: 'targetRetention',
      value: 0.9,
    });
    expect(await upgraded.errorItems.count()).toBe(0);
    expect((await upgraded.meta.get('journalEnabledAt'))?.key).toBe('journalEnabledAt');
    await upgraded.delete();
  });
});
