// Phase 49: TOCFL results sync and survive export/import like the other synced tables.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestResult } from '@anan/core';
import { exportBackup, importBackup } from './backup.js';
import { mergeBackups, sameContent } from './merge.js';
import { AnanDB } from './schema.js';

let a: AnanDB;
let b: AnanDB;
beforeEach(() => {
  a = new AnanDB(`anan-results-a-${Math.random()}`);
  b = new AnanDB(`anan-results-b-${Math.random()}`);
});
afterEach(async () => {
  await a.delete();
  await b.delete();
});

const result = (id: string, date: string, at: string, over: Partial<TestResult> = {}): TestResult => ({
  id,
  date,
  kind: 'mock',
  listening: { score: 21 },
  reading: { score: 19 },
  createdAt: new Date(at),
  updatedAt: new Date(at),
  ...over,
});

describe('Phase 49: testResults', () => {
  it('survives export → wipe → import', async () => {
    await a.testResults.bulkPut([result('r1', '2026-11-20', '2026-11-20T20:00:00Z'), result('r2', '2026-12-08', '2026-12-08T20:00:00Z', { kind: 'official', reading: { level: 'L1' } })]);
    const backup = JSON.parse(JSON.stringify(await exportBackup(a)));
    await a.testResults.clear();
    await importBackup(a, backup);
    const rows = await a.testResults.orderBy('date').toArray();
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(rows[1]).toMatchObject({ kind: 'official', reading: { level: 'L1' } });
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  it('syncs: both devices end with every result, the later edit (or removal) wins', async () => {
    await a.withoutHooks(() => a.testResults.bulkPut([result('r1', '2026-11-20', '2026-11-20T20:00:00Z'), result('r2', '2026-12-01', '2026-12-01T20:00:00Z')]));
    await b.withoutHooks(() =>
      b.testResults.bulkPut([
        result('r1', '2026-11-20', '2026-11-21T08:00:00Z', { reading: { score: 20 } }),
        result('r2', '2026-12-01', '2026-12-02T08:00:00Z', { deleted: true }),
        result('r3', '2026-12-08', '2026-12-08T20:00:00Z'),
      ]),
    );
    const [ea, eb] = await Promise.all([exportBackup(a), exportBackup(b)]);
    const ab = mergeBackups(ea, eb);
    const ba = mergeBackups(eb, ea);
    expect(sameContent(ab, ba)).toBe(true);
    const byId = new Map(ab.testResults.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual(['r1', 'r2', 'r3']);
    expect(byId.get('r1')!.reading).toEqual({ score: 20 });
    expect(byId.get('r2')!.deleted).toBe(true);
    expect(sameContent(ea, ab)).toBe(false);
  });
});
