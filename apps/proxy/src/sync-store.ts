import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
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
 * nothing is stored yet), and each success creates rev + 1. Every revision is
 * kept, none is ever deleted (hotfix after Phase 28: a push from a restored old
 * browser must not rotate good copies out). A retention policy built on
 * `revisionsToKeep` comes back later as a separate, owner-run step.
 */
export interface SyncStore {
  get(profileId: string): Promise<SyncRecord | null>;
  put(profileId: string, blob: Buffer, baseRev: number): Promise<PutResult>;
  versions(profileId: string): Promise<SyncVersion[]>;
  getVersion(profileId: string, rev: number): Promise<SyncRecord | null>;
}

export const KEEP_VERSIONS = 10;
/** Phase 28: besides the last `KEEP_VERSIONS`, the newest copy of each of the last `KEEP_DAILY_DAYS`
 * days is kept, so a burst of saves can't push every good copy out. */
export const KEEP_DAILY_DAYS = 30;

/**
 * Which revisions a future retention policy would keep (Phase 28 Part C.3). Not used by `put`:
 * for now no version is ever deleted.  the last `keep` revisions, plus the newest revision of each
 * (UTC) day within the last `dailyDays` days. `entries` in any order; `at` is epoch ms.
 */
export function revisionsToKeep(
  entries: readonly { rev: number; at: number }[],
  now: Date,
  opts: { keep?: number; dailyDays?: number } = {},
): Set<number> {
  const keep = opts.keep ?? KEEP_VERSIONS;
  const days = opts.dailyDays ?? KEEP_DAILY_DAYS;
  const sorted = [...entries].sort((a, b) => a.rev - b.rev);
  const out = new Set(sorted.slice(-keep).map((e) => e.rev));
  const since = now.getTime() - days * 86_400_000;
  const newestOfDay = new Map<string, { rev: number; at: number }>();
  for (const e of sorted) {
    if (e.at < since) continue;
    const day = new Date(e.at).toISOString().slice(0, 10);
    const prev = newestOfDay.get(day);
    if (!prev || e.rev > prev.rev) newestOfDay.set(day, e);
  }
  for (const e of newestOfDay.values()) out.add(e.rev);
  return out;
}

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
      this.data.set(profileId, list); // every version is kept
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
      // Never deletes an older version: every saved copy stays on disk.
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
