import { summarizeSavedCopy, type SavedCopySummary } from '@anan/core';
import { applyMergedBackup, exportBackup, importBackup } from '../db/backup.js';
import { BackupSchema, type Backup } from '../db/backup-schema.js';
import { mergeBackups, sameContent } from '../db/merge.js';
import { DB_SCHEMA_VERSION, type AnanDB } from '../db/schema.js';
import type { ProfileId } from '../profiles.js';

/** 'synced': nothing waiting. 'pending': local changes not yet pushed. 'saving': a push is in flight.
 * 'offline': the server can't be reached or answered 5xx (retrying with backoff).
 * 'too_large': the server (nginx) refused the save as too big (413): retrying won't help.
 * 'outdated': the server copy is from a newer app version. */
export type SyncStatus = 'synced' | 'pending' | 'saving' | 'offline' | 'too_large' | 'outdated';

/** Phase 28: why the last save failed (shown in the header and Settings, never only a dot). */
export interface SyncFailure {
  kind: 'too_large' | 'network' | 'server';
  status?: number;
  at: Date;
}

/** Phase 28: what the server holds, as of the last successful save or pull. */
export interface SavedInfo extends SavedCopySummary {
  /** When the server copy was saved (ISO). */
  savedAt: string;
  rev: number;
}

/** Phase 28: one saved version on the server (Settings → Your progress → Saved versions). */
export interface SavedVersion extends SavedCopySummary {
  rev: number;
  updatedAt: string;
  bytes: number;
}

/** What a pull found (the restore screen describes it). */
export interface PullResult {
  merged: boolean;
  reachable: boolean;
  /** The server had a copy (rev > 0). */
  found?: boolean;
  summary?: SavedInfo;
}

export interface SyncDeps {
  db: AnanDB;
  profileId: ProfileId;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Headers for every request (household code + installId:profileId). */
  headers: () => Record<string, string>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** The server said 401: the code is wrong or changed. */
  onUnauthorized?: () => void;
  /** A merge replaced local data: reload anything that cached it. */
  onDataChanged?: () => void;
  /** Debounce before a push after a local change. Phase 28: 5 seconds. */
  debounceMs?: number;
  /** Phase 28: waits before each retry after a failed save (the last one repeats). */
  retryDelaysMs?: readonly number[];
  /** Gzip the push body (Phase 28; default on wherever the browser can). */
  compress?: boolean;
  lexiconVersion?: string;
  now?: () => Date;
}

export const DEFAULT_PUSH_DEBOUNCE_MS = 5_000;
/** Phase 28: retry after 30 s, 2 min, 10 min, then every 10 min while changes are unsaved. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];
/** fetch(keepalive) bodies are capped at 64 KiB by browsers. */
const KEEPALIVE_LIMIT_BYTES = 60_000;

/** Gzip text in the browser (CompressionStream); null where it isn't available. */
export async function gzipText(text: string): Promise<ArrayBuffer | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

interface ServerCopy {
  rev: number;
  updatedAt: string | null;
  data: unknown;
}

/**
 * Phase 8 sync for ONE profile. The app stays local-first: IndexedDB is what is
 * read and written; the server keeps a copy so another browser can pick it
 * up. State kept in localStorage per profile+browser: the last server `rev`
 * we merged/pushed, and a `dirty` flag that survives closing the tab.
 */
export class SyncManager {
  status: SyncStatus = 'synced';
  private readonly listeners = new Set<(s: SyncStatus) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private changeCounter = 0;
  private busy: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  private readonly fetchImpl: typeof fetch;
  private readonly revKey: string;
  private readonly dirtyKey: string;
  private readonly unsavedKey: string;
  private readonly savedKey: string;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  /** Phase 28: why the last save failed, until one succeeds. */
  lastFailure: SyncFailure | null = null;
  /** Watching for changes (false when this browser keeps the profile purely local). */
  started = false;
  private readonly onOnline = () => void this.flush();
  // Phase 28: on hide, push straight away (keepalive when the gzipped body is small enough, a normal
  // fetch otherwise, which usually still completes while the page is being hidden).
  private readonly onHidden = () => {
    if (document.visibilityState === 'hidden') void this.push({ keepalive: true });
  };

  constructor(private readonly deps: SyncDeps) {
    this.storage = deps.storage ?? localStorage;
    this.fetchImpl = deps.fetchImpl ?? ((...a) => fetch(...a));
    this.revKey = `anan.sync.${deps.profileId}.rev`;
    this.dirtyKey = `anan.sync.${deps.profileId}.dirty`;
    this.unsavedKey = `anan.sync.${deps.profileId}.unsavedSince`;
    this.savedKey = `anan.sync.${deps.profileId}.saved`;
    if (this.isDirty()) this.status = 'pending';
  }

  // ---- lifecycle ---------------------------------------------------------

  /** Start watching local changes + the browser's online/hidden events. */
  start(): void {
    this.started = true;
    this.deps.db.onLocalChange = () => this.noteLocalChange();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      document.addEventListener('visibilitychange', this.onHidden);
      window.addEventListener('pagehide', this.onHidden);
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.deps.db.onLocalChange = undefined;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      document.removeEventListener('visibilitychange', this.onHidden);
      window.removeEventListener('pagehide', this.onHidden);
    }
  }

  onStatus(listener: (s: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(s: SyncStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.listeners.forEach((l) => l(s));
  }

  /** Tell listeners something besides the status changed (saved info, a failure). */
  private notify(): void {
    this.listeners.forEach((l) => l(this.status));
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ---- persisted bookkeeping --------------------------------------------

  get lastRev(): number {
    return Number(this.storage.getItem(this.revKey) ?? 0);
  }
  private set lastRev(rev: number) {
    this.storage.setItem(this.revKey, String(rev));
  }
  isDirty(): boolean {
    return this.storage.getItem(this.dirtyKey) === '1';
  }
  private setDirty(dirty: boolean): void {
    if (dirty) {
      this.storage.setItem(this.dirtyKey, '1');
      if (!this.storage.getItem(this.unsavedKey)) this.storage.setItem(this.unsavedKey, this.now().toISOString());
    } else {
      this.storage.removeItem(this.dirtyKey);
      this.storage.removeItem(this.unsavedKey);
    }
  }

  /** Phase 28: since when this browser has had changes the server doesn't have (null: none). */
  unsavedSince(): Date | null {
    const v = this.storage.getItem(this.unsavedKey);
    if (v) return new Date(v);
    return this.isDirty() ? this.now() : null;
  }

  /** Phase 28: what the server held after the last successful save or pull (persisted per browser). */
  get savedInfo(): SavedInfo | null {
    try {
      const v = this.storage.getItem(this.savedKey);
      return v ? (JSON.parse(v) as SavedInfo) : null;
    } catch {
      return null;
    }
  }
  private setSaved(info: SavedInfo): void {
    try {
      this.storage.setItem(this.savedKey, JSON.stringify(info));
    } catch {
      /* storage full or private mode: the header still shows the status */
    }
    this.notify();
  }

  /** Marks everything as needing a push (e.g. right after migrating legacy data). */
  markDirty(): void {
    this.setDirty(true);
    if (this.status === 'synced') this.setStatus('pending');
  }

  private noteLocalChange(): void {
    if (this.disposed) return;
    this.changeCounter++;
    this.setDirty(true);
    if (this.status === 'synced') this.setStatus('pending');
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.flush(),
      this.deps.debounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS,
    );
  }

  // ---- network -----------------------------------------------------------

  private url(): string {
    return `${this.deps.baseUrl}/v1/sync/${this.deps.profileId}`;
  }

  /** Serialise pulls/pushes so two never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** GET the server copy and merge it in if it is newer than what we last saw. `onFound` hears what the
   * server holds before the merge starts (the restore screen shows it). */
  pull(onFound?: (summary: SavedInfo) => void): Promise<PullResult> {
    return this.exclusive(() => this.pullInner(onFound));
  }

  private async pullInner(onFound?: (summary: SavedInfo) => void): Promise<PullResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(), { headers: this.deps.headers() });
    } catch {
      this.fail({ kind: 'network', at: this.now() });
      return { merged: false, reachable: false };
    }
    if (res.status === 401) {
      this.deps.onUnauthorized?.();
      return { merged: false, reachable: true };
    }
    if (!res.ok) {
      this.fail({ kind: 'server', status: res.status, at: this.now() });
      return { merged: false, reachable: false };
    }
    const server = (await res.json()) as ServerCopy;
    const found = server.rev > 0 && server.data != null;
    const summary = found
      ? { ...summarizeSavedCopy(server.data), savedAt: server.updatedAt ?? this.now().toISOString(), rev: server.rev }
      : undefined;
    if (summary) onFound?.(summary);
    // Only a copy NEWER than the one we last merged/pushed needs merging.
    const merged = server.rev > this.lastRev ? await this.mergeServerCopy(server) : false;
    if (summary && this.status !== 'outdated') this.setSaved(summary);
    if (this.status === 'offline') this.setStatus(this.isDirty() ? 'pending' : 'synced');
    return { merged, reachable: true, found, ...(summary ? { summary } : {}) };
  }

  /** Merge `server` into the local database; returns whether local data changed. */
  private async mergeServerCopy(server: ServerCopy): Promise<boolean> {
    if (server.rev === 0 || server.data == null) return false;
    const remote = BackupSchema.parse(server.data);
    if (remote.schemaVersion > DB_SCHEMA_VERSION) {
      this.setStatus('outdated');
      return false;
    }
    const local = await exportBackup(this.deps.db, this.deps.lexiconVersion);
    const merged = mergeBackups(local, remote);
    const changedLocal = !sameContent(merged, local);
    if (changedLocal) {
      await applyMergedBackup(this.deps.db, merged);
      this.deps.onDataChanged?.();
    }
    this.lastRev = server.rev;
    // If the merged result holds anything the server lacks, it needs pushing.
    if (!sameContent(merged, remote)) this.setDirty(true);
    return changedLocal;
  }

  /** Pull if the server moved on, then push anything pending. */
  flush(): Promise<void> {
    return this.exclusive(async () => {
      clearTimeout(this.timer);
      const pulled = await this.pullInner();
      if (!pulled.reachable) return;
      if (this.isDirty()) await this.pushInner(false);
      else if (this.status !== 'outdated') this.setStatus('synced');
    });
  }

  /** Phase 28 "Save now" (and the end of every session): push straight away. */
  saveNow(): Promise<void> {
    this.failures = 0;
    clearTimeout(this.retryTimer);
    return this.flush();
  }

  /** PUT our copy. `keepalive` lets the request survive the tab closing (when small enough). */
  push(opts: { keepalive?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      if (!this.isDirty()) return;
      await this.pushInner(opts.keepalive ?? false);
    });
  }

  /** Phase 28: a failed save is never silent: its own status, the reason kept, and a retry scheduled
   * with backoff while there are unsaved changes (a 413 is not retried: it needs the server fixed). */
  private fail(f: SyncFailure): void {
    this.lastFailure = f;
    this.setStatus(f.kind === 'too_large' ? 'too_large' : 'offline');
    this.notify();
    if (f.kind === 'too_large' || this.disposed) return;
    const delays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const wait = delays[Math.min(this.failures, delays.length - 1)]!;
    this.failures++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.disposed && this.isDirty()) void this.flush();
    }, wait);
  }

  /** Phase 28: the server's saved versions, newest first. Throws when the server can't be reached. */
  async versions(): Promise<SavedVersion[]> {
    const res = await this.fetchImpl(`${this.url()}/versions`, { headers: this.deps.headers() });
    if (res.status === 401) this.deps.onUnauthorized?.();
    if (!res.ok) throw new Error(`versions: HTTP ${res.status}`);
    return ((await res.json()) as { versions: SavedVersion[] }).versions;
  }

  /**
   * Phase 28: bring back a saved version. 'merge' (Restore) merges it into this browser's data with
   * the sync merge rules, so nothing newer is lost. 'replace' makes it the data here AND on the
   * server (a confirmed choice for a truly broken state). Either way the result is pushed.
   */
  restoreVersion(rev: number, mode: 'merge' | 'replace'): Promise<void> {
    return this.exclusive(async () => {
      const res = await this.fetchImpl(`${this.url()}/versions/${rev}`, { headers: this.deps.headers() });
      if (res.status === 401) this.deps.onUnauthorized?.();
      if (!res.ok) throw new Error(`version ${rev}: HTTP ${res.status}`);
      const copy = (await res.json()) as ServerCopy;
      const remote = BackupSchema.parse(copy.data);
      if (remote.schemaVersion > DB_SCHEMA_VERSION) throw new Error('That version is from a newer app. Reload first.');
      if (mode === 'replace') {
        await importBackup(this.deps.db, remote);
      } else {
        const local = await exportBackup(this.deps.db, this.deps.lexiconVersion);
        const merged = mergeBackups(local, remote);
        if (!sameContent(merged, local)) await applyMergedBackup(this.deps.db, merged);
      }
      this.deps.onDataChanged?.();
      if (mode === 'replace') {
        // On top of the server's newest rev without merging it back in (that is the point of Replace).
        const head = await this.fetchImpl(this.url(), { headers: this.deps.headers() });
        if (head.ok) this.lastRev = ((await head.json()) as ServerCopy).rev;
      } else {
        // Push on top of the newest server copy (merged in as usual).
        await this.pullInner();
      }
      this.setDirty(true);
      await this.pushInner(false, 0, mode === 'replace');
    });
  }

  private async body(text: string): Promise<{ body: BodyInit; gzip: boolean; size: number }> {
    if (this.deps.compress !== false) {
      const gz = await gzipText(text).catch(() => null);
      if (gz) return { body: gz, gzip: true, size: gz.byteLength };
    }
    return { body: text, gzip: false, size: text.length };
  }

  private async pushInner(keepalive: boolean, attempt = 0, confirmReplace = false): Promise<void> {
    const sentAtChange = this.changeCounter;
    const data = await exportBackup(this.deps.db, this.deps.lexiconVersion);
    const payload = { baseRev: this.lastRev, data, ...(confirmReplace ? { confirmReplace: true } : {}) };
    const { body, gzip, size } = await this.body(JSON.stringify(payload));
    if (!keepalive) this.setStatus('saving');
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(), {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(gzip ? { 'content-encoding': 'gzip' } : {}),
          ...this.deps.headers(),
        },
        body,
        keepalive: keepalive && size < KEEPALIVE_LIMIT_BYTES,
      });
    } catch {
      this.fail({ kind: 'network', at: this.now() }); // dirty stays set: retried with backoff
      return;
    }
    if (res.status === 401) {
      this.setStatus('pending');
      this.deps.onUnauthorized?.();
      return;
    }
    if (res.status === 413) {
      this.fail({ kind: 'too_large', status: 413, at: this.now() });
      return;
    }
    if (res.status === 409) {
      // Stale baseRev, or (Phase 28) a copy that would shrink a lot: merge the server's copy, then
      // push the union on top of it.
      if (attempt >= 3) {
        this.fail({ kind: 'server', status: 409, at: this.now() });
        return;
      }
      const server = (await res.json()) as ServerCopy;
      await this.mergeServerCopy(server);
      this.lastRev = server.rev;
      this.setDirty(true);
      return this.pushInner(keepalive, attempt + 1, confirmReplace);
    }
    if (!res.ok) {
      this.fail({ kind: 'server', status: res.status, at: this.now() });
      return;
    }
    const saved = (await res.json()) as { rev: number; updatedAt?: string };
    this.lastRev = saved.rev;
    this.failures = 0;
    this.lastFailure = null;
    clearTimeout(this.retryTimer);
    this.setSaved({ ...summarizeSavedCopy(data), savedAt: saved.updatedAt ?? this.now().toISOString(), rev: saved.rev });
    if (this.changeCounter === sentAtChange) {
      this.setDirty(false);
      this.setStatus('synced');
    } else {
      // edited while the request was in flight: keep pending, a later push follows
      this.setStatus('pending');
      clearTimeout(this.timer);
      this.timer = setTimeout(
        () => void this.flush(),
        this.deps.debounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS,
      );
    }
  }
}

export type { Backup };

/** Phase 21: a write into ANOTHER profile's database (e.g. a shared cloze report) must reach the
 * server the next time that profile syncs, so its "needs a push" flag is set too. */
export function markProfileDirty(profileId: string, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(`anan.sync.${profileId}.dirty`, '1');
  } catch {
    /* private mode: picked up on the next local change */
  }
}
