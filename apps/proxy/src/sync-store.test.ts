import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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

    it('keeps every version per profile (none is ever deleted), and keeps profiles apart', async () => {
      const { store } = make();
      for (let i = 0; i < 25; i++) await store.put('ron', blob(`v${i}`), i);
      await store.put('guanyu', blob('g'), 0);
      const versions = await store.versions('ron');
      expect(versions.map((v) => v.rev)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      expect((await store.getVersion('ron', 1))?.blob.toString()).toBe('v0');
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

describe('revisionsToKeep (Phase 28 Part C.3, not applied yet) and keeping every version', () => {
  const DAY = 86_400_000;
  const now = new Date('2026-10-09T15:00:00Z');
  it('keeps the newest of each day within 30 days, besides the last 10', () => {
    // 40 days, 5 saves a day: 200 revisions, oldest first
    const entries = Array.from({ length: 200 }, (_, i) => ({
      rev: i + 1,
      at: now.getTime() - (39 - Math.floor(i / 5)) * DAY + (i % 5) * 3_600_000,
    }));
    const keep = revisionsToKeep(entries, now);
    const daily = entries.filter((e) => e.rev % 5 === 0 && e.at >= now.getTime() - 30 * DAY);
    for (const e of daily) expect(keep.has(e.rev), `rev ${e.rev}`).toBe(true);
    for (let r = 191; r <= 200; r++) expect(keep.has(r)).toBe(true);
    expect(keep.size).toBe(new Set([...daily.map((e) => e.rev), ...Array.from({ length: 10 }, (_, i) => 191 + i)]).size);
    expect(keep.has(1)).toBe(false); // 39 days old
  });

  it('the file store never deletes or rewrites an existing file, even one older than 30 days', async () => {
    let t = new Date('2026-08-01T20:00:00Z');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sync-keep-'));
    const store = new FileSyncStore(dir, () => t);
    await store.put('ron', blob('old'), 0);
    const [first] = readdirSync(path.join(dir, 'ron'));
    const before = readFileSync(path.join(dir, 'ron', first!));
    t = new Date('2026-10-09T09:00:00Z');
    for (let i = 1; i <= 40; i++) await store.put('ron', blob(`today ${i}`), i);
    const files = readdirSync(path.join(dir, 'ron'));
    expect(files).toHaveLength(41);
    expect(files).toContain(first);
    expect(readFileSync(path.join(dir, 'ron', first!)).equals(before)).toBe(true);
    expect((await store.getVersion('ron', 1))?.blob.toString()).toBe('old');
  });
});
