import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSyncStore, KEEP_VERSIONS, MemorySyncStore, type SyncStore } from './sync-store.js';

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

    it('keeps only the last 10 versions per profile, and keeps profiles apart', async () => {
      const { store } = make();
      for (let i = 0; i < 13; i++) await store.put('ron', blob(`v${i}`), i);
      await store.put('guanyu', blob('g'), 0);
      const versions = await store.versions('ron');
      expect(versions).toHaveLength(KEEP_VERSIONS);
      expect(versions.map((v) => v.rev)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      expect(await store.getVersion('ron', 3)).toBeNull();
      expect((await store.getVersion('ron', 4))?.blob.toString()).toBe('v3');
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
