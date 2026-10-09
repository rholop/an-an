import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LEARNER_CONFIG } from '@anan/core';
import { exportBackup } from '../db/backup.js';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { LearnerService } from './learner-service.js';
import { SyncManager, type SyncStatus } from './sync.js';

/** An in-memory stand-in for the proxy's /v1/sync routes (same rev/409 rules). */
class FakeServer {
  rev = 0;
  data: unknown = null;
  online = true;
  unauthorized = false;
  puts = 0;
  versions: unknown[] = [];
  /** Phase 28: answer every PUT with this status (413, 502…). */
  failWith = 0;
  gzipped: boolean[] = [];
  confirmed: boolean[] = [];

  fetch: typeof fetch = async (input, init) => {
    if (!this.online) throw new TypeError('Failed to fetch');
    if (this.unauthorized) return new Response('{}', { status: 401 });
    const url = String(input);
    expect(url).toMatch(/\/v1\/sync\/(ron|guanyu)(\/versions(\/\d+)?)?$/);
    const ver = /\/versions\/(\d+)$/.exec(url);
    if (ver) {
      const n = Number(ver[1]);
      return new Response(JSON.stringify({ rev: n, updatedAt: 'then', data: this.versions[n - 1] }), { status: 200 });
    }
    if (url.endsWith('/versions')) {
      const versions = this.versions.map((_, i) => ({ rev: i + 1, updatedAt: 'then', cards: 0, learned: 0, mastered: 0, evidence: 0, lastEvidenceAt: null, bytes: 1 }));
      return new Response(JSON.stringify({ versions: versions.reverse() }), { status: 200 });
    }
    if (!init?.method || init.method === 'GET') {
      return new Response(JSON.stringify({ rev: this.rev, updatedAt: null, data: this.data }), {
        status: 200,
      });
    }
    this.puts++;
    if (this.failWith) return new Response('{}', { status: this.failWith });
    const headers = (init.headers ?? {}) as Record<string, string>;
    this.gzipped.push(headers['content-encoding'] === 'gzip');
    const raw =
      headers['content-encoding'] === 'gzip'
        ? gunzipSync(Buffer.from(init.body as ArrayBuffer)).toString('utf8')
        : String(init.body);
    const body = JSON.parse(raw) as { baseRev: number; data: unknown; confirmReplace?: boolean };
    this.confirmed.push(body.confirmReplace === true);
    if (body.baseRev !== this.rev) {
      return new Response(JSON.stringify({ error: 'stale', rev: this.rev, data: this.data }), {
        status: 409,
      });
    }
    this.rev++;
    this.data = body.data;
    this.versions.push(body.data);
    return new Response(JSON.stringify({ rev: this.rev, updatedAt: 'now' }), { status: 200 });
  };
}

class MemStorage {
  private m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}

let server: FakeServer;
let dbA: AnanDB;
let dbB: AnanDB;
const t0 = new Date('2026-03-01T10:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

beforeEach(() => {
  server = new FakeServer();
  dbA = new AnanDB(`anan-a-${Math.random()}`);
  dbB = new AnanDB(`anan-b-${Math.random()}`);
});
afterEach(async () => {
  await dbA.delete();
  await dbB.delete();
});

function manager(db: AnanDB, over: Partial<ConstructorParameters<typeof SyncManager>[0]> = {}) {
  const changed: number[] = [];
  const m = new SyncManager({
    db,
    profileId: 'ron',
    baseUrl: 'http://proxy',
    fetchImpl: server.fetch,
    headers: () => ({ 'x-site-code': 'tofu', 'x-install-id': 'i:ron' }),
    storage: new MemStorage(),
    onDataChanged: () => changed.push(1),
    debounceMs: 20,
    ...over,
  });
  m.start();
  return { m, changed };
}
const learn = (db: AnanDB, id: string, when: Date) =>
  new LearnerService(new DexieLearnerRepo(db), DEFAULT_LEARNER_CONFIG).record(
    { item: { kind: 'word', id }, skill: 'recognition', kind: 'review_good', at: when },
    when,
  );
const ids = async (db: AnanDB) => (await db.items.toArray()).map((r) => r.item.id).sort();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SyncManager', () => {
  it('a new computer picks up the same progress: A reviews and pushes, B pulls', async () => {
    const a = manager(dbA);
    await learn(dbA, 'w-apple', at(1));
    await learn(dbA, 'w-banana', at(2));
    await a.m.flush();
    expect(server.rev).toBe(1);
    expect(a.m.status).toBe('synced');

    const b = manager(dbB);
    expect(await ids(dbB)).toEqual([]);
    const res = await b.m.pull();
    expect(res).toMatchObject({ merged: true, reachable: true });
    expect(await ids(dbB)).toEqual(['w-apple', 'w-banana']);
    expect(b.changed).toHaveLength(1); // the UI is told to reload
    expect(await dbB.evidence.count()).toBe(2);
    expect(b.m.lastRev).toBe(1);
    expect(b.m.isDirty()).toBe(false); // pulling must not cause a pointless push
    await b.m.flush();
    expect(server.puts).toBe(1);
  });

  it('debounces: a burst of changes becomes one push after the quiet period', async () => {
    const a = manager(dbA, { debounceMs: 40 });
    await learn(dbA, 'w1', at(1));
    await learn(dbA, 'w2', at(2));
    await learn(dbA, 'w3', at(3));
    expect(server.puts).toBe(0);
    expect(a.m.status).toBe('pending');
    await sleep(150);
    expect(server.puts).toBe(1);
    expect(a.m.status).toBe('synced');
  });

  it('offline edits on two browsers to different records both survive after both sync', async () => {
    const a = manager(dbA);
    const b = manager(dbB);
    server.online = false;
    await learn(dbA, 'w-a', at(1));
    await learn(dbB, 'w-b', at(2));
    await a.m.flush();
    await b.m.flush();
    expect(a.m.status).toBe('offline');
    expect(b.m.status).toBe('offline');
    expect(a.m.isDirty()).toBe(true);

    server.online = true;
    await a.m.flush(); // A first: server rev 1 = {w-a}
    await b.m.flush(); // B pulls A's copy, merges, pushes the union
    await a.m.flush(); // A picks up B's change
    expect(await ids(dbA)).toEqual(['w-a', 'w-b']);
    expect(await ids(dbB)).toEqual(['w-a', 'w-b']);
    expect(await dbA.evidence.count()).toBe(2);
    expect(a.m.status).toBe('synced');
    expect(b.m.status).toBe('synced');
  });

  it('a stale push gets a 409, merges the server copy and recovers without losing data', async () => {
    const a = manager(dbA);
    const b = manager(dbB);
    await learn(dbA, 'w-a', at(1));
    await a.m.flush(); // server rev 1
    // B never pulled (lastRev 0): its push is stale
    await learn(dbB, 'w-b', at(2));
    await b.m.push();
    expect(server.rev).toBe(2);
    const serverIds = (server.data as { items: { item: { id: string } }[] }).items
      .map((i) => i.item.id)
      .sort();
    expect(serverIds).toEqual(['w-a', 'w-b']);
    expect(await ids(dbB)).toEqual(['w-a', 'w-b']);
    expect(b.m.lastRev).toBe(2);
    expect(b.m.isDirty()).toBe(false);
  });

  it('a same-card conflict keeps the later change', async () => {
    const a = manager(dbA);
    const b = manager(dbB);
    await learn(dbA, 'w-x', at(1));
    await a.m.flush();
    await b.m.pull();
    await learn(dbA, 'w-x', at(100)); // later
    await learn(dbB, 'w-x', at(50)); // earlier
    await b.m.flush(); // B pushes first
    await a.m.flush(); // A: stale → merge → its later change wins
    const card = (await dbA.items.toArray())[0]!;
    expect(card.updatedAt.getTime()).toBe(at(100).getTime());
    await b.m.flush();
    expect((await dbB.items.toArray())[0]!.updatedAt.getTime()).toBe(at(100).getTime());
  });

  it('works offline without throwing; the status dot clears after reconnecting; online event retries', async () => {
    const a = manager(dbA);
    const seen: SyncStatus[] = [];
    a.m.onStatus((s) => seen.push(s));
    server.online = false;
    await learn(dbA, 'w1', at(1)); // local write is never blocked
    await a.m.flush();
    expect(a.m.status).toBe('offline');
    expect(await ids(dbA)).toEqual(['w1']);
    server.online = true;
    await learn(dbA, 'w2', at(2)); // the next change retries (after the debounce)
    await sleep(120);
    expect(a.m.status).toBe('synced');
    expect(seen).toContain('offline');
    expect(seen.at(-1)).toBe('synced');
    expect(server.rev).toBe(1);
  });

  it('a pending push survives a restart: a new manager on the same storage still pushes', async () => {
    const storage = new MemStorage();
    const first = manager(dbA, { storage, debounceMs: 60_000 });
    await learn(dbA, 'w1', at(1));
    first.m.dispose(); // tab closed before the debounce fired
    expect(server.puts).toBe(0);
    const second = manager(dbA, { storage });
    expect(second.m.isDirty()).toBe(true);
    expect(second.m.status).toBe('pending');
    await second.m.flush();
    expect(server.rev).toBe(1);
  });

  it('reports 401 so the app can ask for the code again, and never loses local data', async () => {
    let rejected = 0;
    const a = manager(dbA, { onUnauthorized: () => rejected++ });
    await learn(dbA, 'w1', at(1));
    server.unauthorized = true;
    await a.m.flush();
    expect(rejected).toBeGreaterThan(0);
    expect(await ids(dbA)).toEqual(['w1']);
    expect(a.m.isDirty()).toBe(true);
  });

  it('applying a pulled copy does not count as a local edit (no push storm)', async () => {
    const a = manager(dbA);
    await learn(dbA, 'w1', at(1));
    await a.m.flush();
    const b = manager(dbB);
    await b.m.flush(); // pull + (nothing to push)
    await sleep(80);
    expect(server.puts).toBe(1);
    expect((await exportBackup(dbB)).items).toHaveLength(1);
  });

  it('refuses a server copy from a newer app version instead of corrupting local data', async () => {
    server.rev = 5;
    server.data = {
      schemaVersion: 999,
      exportedAt: '',
      items: [],
      evidence: [],
      settings: {},
      meta: {},
    };
    const a = manager(dbA);
    await learn(dbA, 'w1', at(1));
    await a.m.pull();
    expect(a.m.status).toBe('outdated');
    expect(await ids(dbA)).toEqual(['w1']);
  });

  describe('Phase 28: no silent failures', () => {
    it('pushes a gzipped body and remembers what the server now holds', async () => {
      const a = manager(dbA);
      await learn(dbA, 'w1', at(1));
      await a.m.flush();
      expect(server.gzipped).toEqual([true]);
      expect(a.m.savedInfo).toMatchObject({ rev: 1, cards: 1, evidence: 1 });
      expect(a.m.unsavedSince()).toBeNull();
    });

    it('a 413 is its own status with the reason kept, and is not retried blindly', async () => {
      const a = manager(dbA, { retryDelaysMs: [10] });
      await learn(dbA, 'w1', at(1));
      server.failWith = 413;
      await a.m.flush();
      expect(a.m.status).toBe('too_large');
      expect(a.m.lastFailure).toMatchObject({ kind: 'too_large', status: 413 });
      const puts = server.puts;
      await sleep(60);
      expect(server.puts).toBe(puts);
      expect(a.m.isDirty()).toBe(true);
    });

    it('a 5xx or network failure retries with backoff until it saves, without a new change', async () => {
      const a = manager(dbA, { retryDelaysMs: [15, 30] });
      await learn(dbA, 'w1', at(1));
      server.failWith = 502;
      await a.m.flush();
      expect(a.m.status).toBe('offline');
      expect(a.m.lastFailure).toMatchObject({ kind: 'server', status: 502 });
      await sleep(40); // first retry: still failing
      expect(server.puts).toBeGreaterThanOrEqual(2);
      server.failWith = 0;
      await vi.waitFor(() => expect(a.m.status).toBe('synced'), { timeout: 500, interval: 10 });
      expect(a.m.lastFailure).toBeNull();
      expect(server.rev).toBe(1);

      server.online = false;
      await learn(dbA, 'w2', at(2));
      await a.m.saveNow();
      expect(a.m.lastFailure).toMatchObject({ kind: 'network' });
      server.online = true;
      await vi.waitFor(() => expect(a.m.status).toBe('synced'), { timeout: 500, interval: 10 });
    });

    it('remembers since when changes are unsaved (the header warning), across a restart', async () => {
      const storage = new MemStorage();
      const clock = { t: at(0) };
      const first = manager(dbA, { storage, debounceMs: 60_000, now: () => clock.t });
      await learn(dbA, 'w1', at(1));
      expect(first.m.unsavedSince()?.getTime()).toBe(at(0).getTime());
      first.m.dispose();
      clock.t = at(30);
      const second = manager(dbA, { storage, now: () => clock.t });
      expect(second.m.unsavedSince()?.getTime()).toBe(at(0).getTime());
      await second.m.flush();
      expect(second.m.unsavedSince()).toBeNull();
    });

    it('a pull says whether the server has a copy, and what it holds, before merging', async () => {
      const a = manager(dbA);
      expect(await a.m.pull()).toMatchObject({ reachable: true, found: false });
      await learn(dbA, 'w1', at(1));
      await a.m.flush();
      const b = manager(dbB);
      const found: unknown[] = [];
      const res = await b.m.pull((s) => found.push(s));
      expect(res).toMatchObject({ reachable: true, found: true, summary: { cards: 1, rev: 1 } });
      expect(found).toHaveLength(1);
      server.online = false;
      expect(await manager(dbB).m.pull()).toMatchObject({ reachable: false });
    });

    it('Restore merges a saved version in (nothing newer is lost); Replace makes it the copy everywhere', async () => {
      const a = manager(dbA);
      await learn(dbA, 'w-old', at(1));
      await a.m.flush(); // rev 1 = {w-old}
      await dbA.items.clear(); // a bug wiped this browser's cards
      await learn(dbA, 'w-new', at(2));
      await a.m.flush(); // rev 2: merging kept w-old anyway (the union)
      expect((await a.m.versions()).map((v) => v.rev)).toEqual([2, 1]);

      const b = manager(dbB);
      await learn(dbB, 'w-b', at(3));
      await b.m.restoreVersion(1, 'merge');
      expect(await ids(dbB)).toEqual(['w-b', 'w-new', 'w-old']); // the version, plus the newest copy, plus this browser
      expect(b.changed.length).toBeGreaterThan(0);
      const pushed = (server.data as { items: { item: { id: string } }[] }).items.map((i) => i.item.id).sort();
      expect(pushed).toEqual(['w-b', 'w-new', 'w-old']);

      await b.m.restoreVersion(1, 'replace');
      expect(await ids(dbB)).toEqual(['w-old']);
      expect((server.data as { items: unknown[] }).items).toHaveLength(1);
      expect(server.confirmed.at(-1)).toBe(true);
    });
  });
});