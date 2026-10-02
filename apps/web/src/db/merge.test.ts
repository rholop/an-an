import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LEARNER_CONFIG } from '@anan/core';
import { LearnerService } from '../lib/learner-service.js';
import { applyMergedBackup, exportBackup } from './backup.js';
import { BackupSchema, type Backup } from './backup-schema.js';
import { DexieLearnerRepo } from './learner-repo.js';
import { mergeBackups, sameContent } from './merge.js';
import { AnanDB } from './schema.js';

let a: AnanDB;
let b: AnanDB;
const t0 = new Date('2026-03-01T10:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

beforeEach(() => {
  a = new AnanDB(`anan-a-${Math.random()}`);
  b = new AnanDB(`anan-b-${Math.random()}`);
});
afterEach(async () => {
  await a.delete();
  await b.delete();
});

const service = (db: AnanDB) =>
  new LearnerService(new DexieLearnerRepo(db), DEFAULT_LEARNER_CONFIG);
/** What the server would hand back: JSON on the wire, re-parsed on arrival. */
const wire = async (db: AnanDB): Promise<Backup> =>
  BackupSchema.parse(JSON.parse(JSON.stringify(await exportBackup(db))));
const review = (id: string, kind: 'review_good' | 'review_again', when: Date) =>
  ({ item: { kind: 'word', id }, skill: 'recognition', kind, at: when }) as const;

describe('mergeBackups', () => {
  it('offline edits to DIFFERENT records on two browsers both survive', async () => {
    await service(a).record(review('w-apple', 'review_good', at(1)), at(1));
    await service(b).record(review('w-banana', 'review_good', at(2)), at(2));
    const merged = mergeBackups(await wire(a), await wire(b));
    expect(merged.items.map((c) => c.item.id).sort()).toEqual(['w-apple', 'w-banana']);
    expect(merged.evidence).toHaveLength(2);
  });

  it('the same card edited on both: the later change wins (either direction)', async () => {
    await service(a).record(review('w-x', 'review_good', at(1)), at(1));
    await service(b).record(review('w-x', 'review_good', at(1)), at(1));
    await service(a).record(review('w-x', 'review_good', at(60)), at(60)); // A reviews again, later
    await service(b).record(review('w-x', 'review_again', at(30)), at(30)); // B lapses, earlier
    const ab = mergeBackups(await wire(a), await wire(b));
    const ba = mergeBackups(await wire(b), await wire(a));
    for (const m of [ab, ba]) {
      const card = m.items.find((c) => c.item.id === 'w-x')!;
      expect(card.updatedAt.getTime()).toBe(at(60).getTime());
      expect(card.card.reps).toBe((await wire(a)).items[0]!.card.reps);
      expect(m.evidence).toHaveLength(4); // nothing deleted: all four reviews are in the log
    }
  });

  it('settings: per key, later edit wins; keys only on one side are kept', async () => {
    await a.settings.put({ key: 'currentLevel', value: 'L1', updatedAt: at(10) });
    await b.settings.put({ key: 'currentLevel', value: 'L3', updatedAt: at(20) });
    await a.settings.put({ key: 'targetRetention', value: 0.85, updatedAt: at(50) });
    await b.settings.put({ key: 'targetRetention', value: 0.9, updatedAt: at(40) });
    await b.settings.put({ key: 'onlyB', value: 1, updatedAt: at(5) });
    const m = mergeBackups(await wire(a), await wire(b));
    expect(m.settings).toEqual({ currentLevel: 'L3', targetRetention: 0.85, onlyB: 1 });
    expect(m.settingsUpdatedAt.currentLevel!.getTime()).toBe(at(20).getTime());
  });

  it('is idempotent and symmetric in content: merging again changes nothing', async () => {
    await service(a).record(review('w1', 'review_good', at(1)), at(1));
    await service(b).record(review('w2', 'review_good', at(2)), at(2));
    const [wa, wb] = [await wire(a), await wire(b)];
    const once = mergeBackups(wa, wb);
    const twice = mergeBackups(once, wb);
    expect(sameContent(once, twice)).toBe(true);
    expect(sameContent(mergeBackups(wa, wb), mergeBackups(wb, wa))).toBe(true);
    expect(twice.evidence).toHaveLength(2);
  });

  it('unions append-only rows by uid and dedupes legacy rows with no uid by content', () => {
    const base = {
      item: { kind: 'word' as const, id: 'w' },
      skill: 'recognition' as const,
      kind: 'review_good' as const,
      at: at(1),
    };
    const empty = BackupSchema.parse({
      schemaVersion: 5,
      exportedAt: '',
      items: [],
      evidence: [],
      settings: {},
      meta: {},
    });
    const l = { ...empty, evidence: [base, { ...base, uid: 'u1' }] };
    const r = { ...empty, evidence: [base, { ...base, uid: 'u1' }, { ...base, uid: 'u2' }] };
    expect(
      mergeBackups(l, r)
        .evidence.map((e) => e.uid)
        .sort(),
    ).toEqual([expect.stringContaining('legacy:'), 'u1', 'u2'].sort());
  });

  it('in-place journal data: later copy wins, error items are unioned', async () => {
    const entry = (text: string, updatedAt: Date) => ({
      id: 'e1',
      text,
      promptWordIds: [],
      createdAt: at(0),
      status: 'revealed' as const,
      updatedAt,
    });
    await a.journalEntries.put(entry('A edit', at(5)));
    await b.journalEntries.put(entry('B edit', at(9)));
    const card = {
      due: at(0),
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 0,
      reps: 0,
      lapses: 0,
      state: 0,
    };
    const err = (id: string) => ({
      id,
      journalEntryId: 'e1',
      original: 'o',
      corrected: 'c',
      span: [0, 1] as [number, number],
      type: 'error' as const,
      card,
      flagged: false,
      createdAt: at(0),
    });
    await a.errorItems.put(err('e1:0'));
    await b.errorItems.put(err('e1:1'));
    const m = mergeBackups(await wire(a), await wire(b));
    expect(m.journalEntries.map((e) => e.text)).toEqual(['B edit']);
    expect(m.errorItems.map((e) => e.id).sort()).toEqual(['e1:0', 'e1:1']);
  });

  it('a flagged error item on one device (later edit) is not lost to a stale copy', async () => {
    const card = {
      due: at(0),
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 0,
      reps: 0,
      lapses: 0,
      state: 0,
    };
    const base = {
      id: 'e1:0',
      journalEntryId: 'e1',
      original: 'o',
      corrected: 'c',
      span: [0, 1] as [number, number],
      type: 'error' as const,
      card,
      createdAt: at(0),
    };
    await a.errorItems.put({ ...base, flagged: false, updatedAt: at(1) });
    await b.errorItems.put({ ...base, flagged: true, updatedAt: at(2) });
    expect(mergeBackups(await wire(a), await wire(b)).errorItems[0]!.flagged).toBe(true);
    expect(mergeBackups(await wire(b), await wire(a)).errorItems[0]!.flagged).toBe(true);
  });

  describe('conversations and turns (per-browser numeric ids)', () => {
    const conv = (scenarioId: string, uid: string, min: number) => ({
      scenarioId,
      npcId: 'n',
      startedAt: at(min),
      goalStepsDone: [],
      completed: false,
      stuckCount: 0,
      englishFallbackUsed: false,
      uid,
      updatedAt: at(min),
    });

    it("keeps both devices' conversations, re-numbers ids without collisions, and re-attaches turns", async () => {
      const ca = (await a.conversations.add(conv('tea', 'conv-a', 0))) as number;
      const cb = (await b.conversations.add(conv('tea', 'conv-b', 1))) as number;
      expect(ca).toBe(cb); // the same local number on both browsers: the collision the merge must resolve
      await a.turns.bulkAdd([
        { conversationId: ca, role: 'npc', zh: 'A1', at: at(0), uid: 'ta1' },
        { conversationId: ca, role: 'learner', zh: 'A2', at: at(2), uid: 'ta2' },
      ]);
      await b.turns.bulkAdd([
        { conversationId: cb, role: 'npc', zh: 'B1', at: at(1), uid: 'tb1' },
        { conversationId: cb, role: 'learner', zh: 'B2', at: at(3), uid: 'tb2' },
      ]);
      const m = mergeBackups(await wire(a), await wire(b));
      expect(m.conversations).toHaveLength(2);
      expect(new Set(m.conversations.map((c) => c.id)).size).toBe(2);
      const byUid = new Map(m.conversations.map((c) => [c.uid!, c.id!]));
      const zhOf = (convUid: string) =>
        m.turns.filter((t) => t.conversationId === byUid.get(convUid)).map((t) => t.zh);
      expect(zhOf('conv-a')).toEqual(['A1', 'A2']);
      expect(zhOf('conv-b')).toEqual(['B1', 'B2']);
      expect(m.turns.map((t) => t.id)).toEqual([1, 2, 3, 4]);
    });

    it('the same conversation continued on both devices interleaves by time, with no duplicates', async () => {
      const id = (await a.conversations.add(conv('tea', 'shared', 0))) as number;
      await a.turns.add({ conversationId: id, role: 'npc', zh: 'hello', at: at(0), uid: 't0' });
      const synced = await wire(a);
      await applyMergedBackup(b, synced); // B pulled the shared state
      const idB = (await b.conversations.toArray())[0]!.id!;
      await a.turns.add({
        conversationId: id,
        role: 'learner',
        zh: 'from A',
        at: at(2),
        uid: 't-a',
      });
      await b.turns.add({
        conversationId: idB,
        role: 'learner',
        zh: 'from B',
        at: at(1),
        uid: 't-b',
      });
      const m = mergeBackups(await wire(a), await wire(b));
      expect(m.conversations).toHaveLength(1);
      expect(m.turns.map((t) => t.zh)).toEqual(['hello', 'from B', 'from A']);
      expect(m.turns.every((t) => t.conversationId === m.conversations[0]!.id)).toBe(true);
    });
  });
});

describe('applyMergedBackup', () => {
  it('writes the merged copy exactly (uids and updatedAt preserved) without counting it as a local edit', async () => {
    await service(a).record(review('w1', 'review_good', at(1)), at(1));
    await a.settings.put({ key: 'currentLevel', value: 'L2', updatedAt: at(3) });
    await service(b).record(review('w2', 'review_good', at(2)), at(2));
    let localChanges = 0;
    a.onLocalChange = () => localChanges++;
    const merged = mergeBackups(await wire(a), await wire(b));
    await applyMergedBackup(a, merged);

    expect(localChanges).toBe(0);
    expect((await a.items.toArray()).map((r) => r.item.id).sort()).toEqual(['w1', 'w2']);
    const after = await wire(a);
    expect(after.evidence.map((e) => e.uid).sort()).toEqual(
      merged.evidence.map((e) => e.uid).sort(),
    );
    expect((await a.settings.get('currentLevel'))?.updatedAt?.getTime()).toBe(at(3).getTime());

    // a normal write afterwards IS a local change and is stamped
    await a.settings.put({ key: 'x', value: 1 });
    expect(localChanges).toBeGreaterThan(0);
    expect((await a.settings.get('x'))?.updatedAt).toBeInstanceOf(Date);
  });
});

describe('export -> import on another browser', () => {
  it('round-trips a profile identically (every table, with uids and updatedAt)', async () => {
    const { importBackup } = await import('./backup.js');
    await service(a).record(review('w1', 'review_good', at(1)), at(1));
    await a.settings.put({ key: 'currentLevel', value: 'L2' });
    const conv = (await a.conversations.add({
      scenarioId: 'tea',
      npcId: 'n',
      startedAt: at(0),
      goalStepsDone: [],
      completed: false,
      stuckCount: 0,
      englishFallbackUsed: false,
    })) as number;
    await a.turns.add({ conversationId: conv, role: 'npc', zh: 'hi', at: at(0) });
    const file = JSON.parse(JSON.stringify(await exportBackup(a)));
    await importBackup(b, file);
    const strip = (x: Backup) => ({ ...x, exportedAt: '' });
    expect(strip(await wire(b))).toEqual(strip(BackupSchema.parse(file)));
  });
});
