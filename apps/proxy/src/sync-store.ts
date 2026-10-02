import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** One saved copy of a profile's data: the per-profile export JSON, gzipped. */
export interface SyncRecord {
  rev: number;
  updatedAt: string;
  blob: Buffer;
}

export type PutResult =
  | { ok: true; rev: number; updatedAt: string }
  /** `baseRev` was stale: the caller must merge `current` and retry. */
  | { ok: false; current: SyncRecord };

export interface SyncVersion {
  rev: number;
  updatedAt: string;
}

/**
 * Where the per-profile copies live (phase 8). Deliberately tiny so the host's
 * storage can change without touching the routes: `FileSyncStore` below is the
 * real one (a directory on the proxy's own disk — the proxy runs as a PM2
 * process on a small server), `MemorySyncStore` is for tests.
 *
 * Contract: `put` only succeeds when `baseRev` equals the stored rev (0 when
 * nothing is stored yet), and each success creates rev + 1. The last
 * `KEEP_VERSIONS` revs per profile are kept so a bad save can be rolled back.
 */
export interface SyncStore {
  get(profileId: string): Promise<SyncRecord | null>;
  put(profileId: string, blob: Buffer, baseRev: number): Promise<PutResult>;
  versions(profileId: string): Promise<SyncVersion[]>;
  getVersion(profileId: string, rev: number): Promise<SyncRecord | null>;
}

export const KEEP_VERSIONS = 10;

/** Serialises operations per profile so two simultaneous PUTs can't both pass
 * the baseRev check. */
class Mutex {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

export class MemorySyncStore implements SyncStore {
  private readonly data = new Map<string, SyncRecord[]>();
  private readonly mutex = new Mutex();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async get(profileId: string) {
    return this.data.get(profileId)?.at(-1) ?? null;
  }

  put(profileId: string, blob: Buffer, baseRev: number): Promise<PutResult> {
    return this.mutex.run(profileId, async () => {
      const list = this.data.get(profileId) ?? [];
      const current = list.at(-1);
      if ((current?.rev ?? 0) !== baseRev) return { ok: false as const, current: current! };
      const rec: SyncRecord = { rev: baseRev + 1, updatedAt: this.now().toISOString(), blob };
      list.push(rec);
      this.data.set(profileId, list.slice(-KEEP_VERSIONS));
      return { ok: true as const, rev: rec.rev, updatedAt: rec.updatedAt };
    });
  }

  async versions(profileId: string) {
    return (this.data.get(profileId) ?? []).map(({ rev, updatedAt }) => ({ rev, updatedAt }));
  }

  async getVersion(profileId: string, rev: number) {
    return this.data.get(profileId)?.find((r) => r.rev === rev) ?? null;
  }
}

/** `<dir>/<profileId>/<rev>.<epochMs>.json.gz`. Writes go to a temp file and are
 * renamed into place, so a crash never leaves a half-written revision. */
export class FileSyncStore implements SyncStore {
  private readonly mutex = new Mutex();

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private profileDir(profileId: string): string {
    // profile ids are validated against PROFILES by the routes; this is a second line of defence
    if (!/^[a-z0-9_-]+$/i.test(profileId)) throw new Error(`bad profile id "${profileId}"`);
    return path.join(this.dir, profileId);
  }

  private async list(profileId: string): Promise<{ rev: number; at: number; file: string }[]> {
    const dir = this.profileDir(profileId); // throws on a bad id — must not be swallowed below
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    return names
      .map((file) => {
        const m = /^(\d+)\.(\d+)\.json\.gz$/.exec(file);
        return m ? { rev: Number(m[1]), at: Number(m[2]), file } : null;
      })
      .filter((x): x is { rev: number; at: number; file: string } => x !== null)
      .sort((a, b) => a.rev - b.rev);
  }

  private async read(
    profileId: string,
    entry: { rev: number; at: number; file: string },
  ): Promise<SyncRecord> {
    return {
      rev: entry.rev,
      updatedAt: new Date(entry.at).toISOString(),
      blob: await readFile(path.join(this.profileDir(profileId), entry.file)),
    };
  }

  async get(profileId: string) {
    const last = (await this.list(profileId)).at(-1);
    return last ? this.read(profileId, last) : null;
  }

  put(profileId: string, blob: Buffer, baseRev: number): Promise<PutResult> {
    return this.mutex.run(profileId, async () => {
      const entries = await this.list(profileId);
      const last = entries.at(-1);
      if ((last?.rev ?? 0) !== baseRev)
        return { ok: false as const, current: await this.read(profileId, last!) };

      const dir = this.profileDir(profileId);
      await mkdir(dir, { recursive: true });
      const rev = baseRev + 1;
      const at = this.now().getTime();
      const final = path.join(dir, `${rev}.${at}.json.gz`);
      const tmp = `${final}.tmp`;
      await writeFile(tmp, blob);
      await rename(tmp, final);
      for (const old of entries.slice(0, Math.max(0, entries.length + 1 - KEEP_VERSIONS))) {
        await rm(path.join(dir, old.file), { force: true });
      }
      return { ok: true as const, rev, updatedAt: new Date(at).toISOString() };
    });
  }

  async versions(profileId: string) {
    return (await this.list(profileId)).map((e) => ({
      rev: e.rev,
      updatedAt: new Date(e.at).toISOString(),
    }));
  }

  async getVersion(profileId: string, rev: number) {
    const entry = (await this.list(profileId)).find((e) => e.rev === rev);
    return entry ? this.read(profileId, entry) : null;
  }
}
