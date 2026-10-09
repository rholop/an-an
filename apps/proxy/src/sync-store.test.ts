import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSyncStore, MemorySyncStore, revisionsToKeep, type SyncStore } from './sync-store.js';

const blob = (s: string) => Buffer.from(s);

function contract(name: string, make: () => { store: SyncStore; dir?: string }) {
  describe(`${name} (SyncStore contract)`, () => {
    it('starts empty, then stores and returns revisions in order', async () => {
      const { store } = make();
      expect(await store.get('ron')).toBeNull();
      const r1 = await store.put('ron', blob('a'), 0);
      expect(r1).toMatchObject({ ok: true, rev: 1 });
      const r2 = await store.put('ron', blob('b'), 1);
      expect(r2).toMatchObject({ ok: true, rev: 2 });
      const got = await store.get('ron');
      expect(got?.rev).toBe(2);
      expect(got?.blob.toString()).toBe('b');
      expect(Number.isNaN(Date.parse(got!.updatedAt))).toBe(false);
    });

    it('rejects a stale baseRev and hands back the current copy', async () => {
      const { store } = make();
      await store.put('ron', blob('a'), 0);
      await store.put('ron', blob('b'), 1);
      const stale = await store.put('ron', blob('c'), 1);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.current.blob.toString()).toBe('b');
      expect((await store.put('ron', blob('x'), 0)).ok).toBe(false); // can't "start over" on top of data
    });

    it('serialises concurrent pushes: exactly one wins', async () => {
      const { store } = make();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => store.put('ron', blob(`v${i}`), 0)),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await store.get('ron'))?.rev).toBe(1);
    });

    it('keeps the newest 10 versions per profile (Phase 31), and keeps profiles apart', async () => {
      const { store } = make();
      for (let i = 0; i < 25; i++) await store.put('ron', blob(`v${i}`), i);
      await store.put('guanyu', blob('g'), 0);
      const versions = await store.versions('ron');
      expect(versions.map((v) => v.rev)).toEqual(Array.from({ length: 10 }, (_, i) => i + 16));
      expect(await store.getVersion('ron', 1)).toBeNull();
      expect((await store.getVersion('ron', 25))?.blob.toString()).toBe('v24');
      expect((await store.get('guanyu'))?.blob.toString()).toBe('g');
      expect(await store.versions('guanyu')).toHaveLength(1);
    });
  });
}

contract('MemorySyncStore', () => ({ store: new MemorySyncStore() }));
contract('FileSyncStore', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sync-'));
  return { store: new FileSyncStore(dir), dir };
});

describe('FileSyncStore on disk', () => {
  it('survives a restart (a new instance sees the data), leaves no temp files, and refuses odd profile ids', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sync-'));
    await new FileSyncStore(dir).put('ron', blob('persisted'), 0);
    const reopened = new FileSyncStore(dir);
    expect((await reopened.get('ron'))?.blob.toString()).toBe('persisted');
    expect(readdirSync(path.join(dir, 'ron')).every((f) => /^\d+\.\d+\.json\.gz$/.test(f))).toBe(
      true,
    );
    await expect(reopened.get('../etc')).rejects.toThrow(/bad profile id/);
  });
});

describe('revisionsToKeep and pruning (Phase 31 Part G: keep only the last 10)', () => {
  const DAY = 86_400_000;
  const now = new Date('2026-10-09T15:00:00Z');
  it('keeps exactly the last 10 revisions (no daily history by default)', () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      rev: i + 1,
      at: now.getTime() - (39 - Math.floor(i / 5)) * DAY + (i % 5) * 3_600_000,
    }));
    const keep = revisionsToKeep(entries, now);
    expect([...keep].sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => 191 + i));
  });

  it('can still keep the newest of each day when asked (dailyDays > 0)', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ rev: i + 1, at: now.getTime() - (19 - i) * DAY }));
    // the last 2, plus the newest of each of the days within the last 5 days (the window's edges included)
    expect(revisionsToKeep(entries, now, { keep: 2, dailyDays: 5 }).size).toBe(6);
  });

  it('after 15 saves the file store holds exactly the newest 10 files', async () => {
    let t = new Date('2026-10-01T20:00:00Z');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sync-keep-'));
    const store = new FileSyncStore(dir, () => t);
    for (let i = 0; i < 15; i++) {
      t = new Date(t.getTime() + 3_600_000);
      await store.put('ron', blob(`save ${i + 1}`), i);
    }
    const files = readdirSync(path.join(dir, 'ron'));
    expect(files).toHaveLength(10);
    expect(files.map((f) => Number(f.split('.')[0])).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 6),
    );
    expect((await store.getVersion('ron', 5))).toBeNull();
    expect((await store.getVersion('ron', 15))?.blob.toString()).toBe('save 15');
    expect((await store.versions('ron')).map((v) => v.rev)).toEqual(Array.from({ length: 10 }, (_, i) => i + 6));
  });

  it('the memory store keeps the newest 10 too', async () => {
    const store = new MemorySyncStore();
    for (let i = 0; i < 15; i++) await store.put('ron', blob(`m${i}`), i);
    expect((await store.versions('ron')).map((v) => v.rev)).toEqual(Array.from({ length: 10 }, (_, i) => i + 6));
  });
});
