import { applyMergedBackup, exportBackup } from '../db/backup.js';
import { BackupSchema, type Backup } from '../db/backup-schema.js';
import { mergeBackups, sameContent } from '../db/merge.js';
import { DB_SCHEMA_VERSION, type AnanDB } from '../db/schema.js';
import type { ProfileId } from '../profiles.js';

/** 'synced': nothing waiting. 'pending': local changes not yet pushed.
 * 'offline': the server can't be reached (the small "not synced" dot).
 * 'outdated': the server copy is from a newer app version. */
export type SyncStatus = 'synced' | 'pending' | 'offline' | 'outdated';

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
  /** Debounce before a push after a local change. Spec: about 30 seconds. */
  debounceMs?: number;
  lexiconVersion?: string;
}

export const DEFAULT_PUSH_DEBOUNCE_MS = 30_000;
/** fetch(keepalive) bodies are capped at 64 KiB by browsers. */
const KEEPALIVE_LIMIT_BYTES = 60_000;

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
  private readonly onOnline = () => void this.flush();
  private readonly onHidden = () => {
    if (document.visibilityState === 'hidden') void this.push({ keepalive: true });
  };

  constructor(private readonly deps: SyncDeps) {
    this.storage = deps.storage ?? localStorage;
    this.fetchImpl = deps.fetchImpl ?? ((...a) => fetch(...a));
    this.revKey = `anan.sync.${deps.profileId}.rev`;
    this.dirtyKey = `anan.sync.${deps.profileId}.dirty`;
    if (this.isDirty()) this.status = 'pending';
  }

  // ---- lifecycle ---------------------------------------------------------

  /** Start watching local changes + the browser's online/hidden events. */
  start(): void {
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
    if (dirty) this.storage.setItem(this.dirtyKey, '1');
    else this.storage.removeItem(this.dirtyKey);
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

  /** GET the server copy and merge it in if it is newer than what we last saw. */
  pull(): Promise<{ merged: boolean; reachable: boolean }> {
    return this.exclusive(() => this.pullInner());
  }

  private async pullInner(): Promise<{ merged: boolean; reachable: boolean }> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(), { headers: this.deps.headers() });
    } catch {
      this.setStatus('offline');
      return { merged: false, reachable: false };
    }
    if (res.status === 401) {
      this.deps.onUnauthorized?.();
      return { merged: false, reachable: true };
    }
    if (!res.ok) {
      this.setStatus('offline');
      return { merged: false, reachable: false };
    }
    const server = (await res.json()) as ServerCopy;
    // Only a copy NEWER than the one we last merged/pushed needs merging.
    const merged = server.rev > this.lastRev ? await this.mergeServerCopy(server) : false;
    if (this.status === 'offline') this.setStatus(this.isDirty() ? 'pending' : 'synced');
    return { merged, reachable: true };
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

  /** PUT our copy. `keepalive` lets the request survive the tab closing (when small enough). */
  push(opts: { keepalive?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      if (!this.isDirty()) return;
      await this.pushInner(opts.keepalive ?? false);
    });
  }

  private async pushInner(keepalive: boolean, attempt = 0): Promise<void> {
    const sentAtChange = this.changeCounter;
    const data = await exportBackup(this.deps.db, this.deps.lexiconVersion);
    const body = JSON.stringify({ baseRev: this.lastRev, data });
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...this.deps.headers() },
        body,
        keepalive: keepalive && body.length < KEEPALIVE_LIMIT_BYTES,
      });
    } catch {
      this.setStatus('offline'); // dirty stays set: retried on the next change or when we're back online
      return;
    }
    if (res.status === 401) {
      this.deps.onUnauthorized?.();
      return;
    }
    if (res.status === 409) {
      // Stale baseRev: merge the server's copy, then retry once on top of it.
      if (attempt >= 3) {
        this.setStatus('pending');
        return;
      }
      const server = (await res.json()) as ServerCopy;
      await this.mergeServerCopy(server);
      this.lastRev = server.rev;
      this.setDirty(true);
      return this.pushInner(keepalive, attempt + 1);
    }
    if (!res.ok) {
      this.setStatus('offline');
      return;
    }
    const saved = (await res.json()) as { rev: number };
    this.lastRev = saved.rev;
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
