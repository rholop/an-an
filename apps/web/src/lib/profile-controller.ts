import type { AnanDB } from '../db/schema.js';
import { closeSession, currentSession, openSession, type Session } from '../db/instance.js';
import type { ProfileId } from '../profiles.js';
import { authHeaders, handleUnauthorized, proxyBase } from './api.js';
import { reloadCurrentLevel } from './current-level.js';
import { reloadMyClass } from './my-class.js';
import { SyncManager, type SyncStatus } from './sync.js';

export const PROFILE_KEY = 'anan.profile';

export function rememberedProfile(isValid: (v: unknown) => v is ProfileId): ProfileId | null {
  try {
    const v = localStorage.getItem(PROFILE_KEY);
    return isValid(v) ? v : null;
  } catch {
    return null;
  }
}

const beforeSwitch = new Set<() => Promise<void> | void>();

/** Things that hold unsaved in-progress state (a journal draft, a setting being
 * typed) register here; switching profile awaits them all first, so nothing
 * is lost and nothing leaks into the next profile. Returns an unregister fn. */
export function registerBeforeSwitch(fn: () => Promise<void> | void): () => void {
  beforeSwitch.add(fn);
  return () => beforeSwitch.delete(fn);
}

export interface ControllerEvents {
  /** Local data was replaced by a sync merge: the UI must re-read. */
  onDataChanged: () => void;
  onSyncStatus: (s: SyncStatus) => void;
  onUnauthorized: () => void;
}

/** Opens a profile (database + sync) and switches between them. UI-agnostic. */
/** How long opening a profile waits for the first server pull (milliseconds). */
export const FIRST_PULL_DEADLINE_MS = 1500;

/** Resolves when `promise` settles or after `ms`, whichever is first; never rejects. */
export function withDeadline(promise: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

/** Has this browser already used this profile? (It saved a level, or has any progress.) */
export async function isReturningDevice(db: AnanDB): Promise<boolean> {
  if (await db.settings.get('currentLevel')) return true;
  return (await db.items.count()) > 0;
}

export class ProfileController {
  private sync: SyncManager | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  constructor(private readonly events: ControllerEvents) {}

  get syncManager(): SyncManager | null {
    return this.sync;
  }

  /**
   * Make `profileId` current: open its database, pull the server copy (merged
   * in BEFORE anything is shown, so a new computer is complete at once), and
   * start watching for changes. Offline is fine — it just skips the pull.
   */
  async activate(profileId: ProfileId): Promise<Session> {
    this.teardown();
    const session = openSession(profileId);
    localStorage.setItem(PROFILE_KEY, profileId);
    const sync = new SyncManager({
      db: session.db,
      profileId,
      baseUrl: proxyBase(),
      headers: () => authHeaders(profileId),
      onUnauthorized: () => {
        handleUnauthorized();
        this.events.onUnauthorized();
      },
      onDataChanged: () => {
        reloadCurrentLevel();
        reloadMyClass();
        this.events.onDataChanged();
      },
    });
    this.sync = sync;
    this.unsubscribeStatus = sync.onStatus(this.events.onSyncStatus);
    if (import.meta.env.DEV) window.__ananSync = sync;
    // `anan.sync.disabled` = '1' keeps this browser purely local (used by the
    // e2e suite so unrelated specs don't share one server copy).
    if (localStorage.getItem('anan.sync.disabled') === '1') return session;
    sync.start();
    // Pull if the server moved on, then push anything pending.
    //  - A device that already has this profile's data waits only briefly: on a slow
    //    or stalled connection the app opens on the local copy, and when the pull
    //    lands the data-changed hook (above) refreshes whatever is on screen.
    //  - A NEW device (nothing saved here yet) waits for the pull, however long it
    //    takes. Opening on an empty database would let first-run defaults (the
    //    starting level, ...) be written with a newer timestamp than the real
    //    values on the server, and then win the merge and overwrite them.
    if (await isReturningDevice(session.db))
      await withDeadline(sync.flush(), FIRST_PULL_DEADLINE_MS);
    else await sync.flush().catch(() => undefined);
    this.events.onSyncStatus(sync.status);
    return session;
  }

  /** Switch to another profile: save drafts, push this profile's changes
   * (briefly — never blocks if the server is slow), then open the other one. */
  async switchTo(profileId: ProfileId): Promise<void> {
    if (currentSession()?.profileId === profileId) return;
    await Promise.all([...beforeSwitch].map((fn) => Promise.resolve(fn()).catch(() => undefined)));
    const old = this.sync;
    if (old) {
      await Promise.race([old.flush(), new Promise<void>((r) => setTimeout(r, 3000))]).catch(
        () => undefined,
      );
    }
    await this.activate(profileId);
  }

  teardown(): void {
    this.unsubscribeStatus?.();
    this.sync?.dispose();
    this.sync = null;
  }

  close(): void {
    this.teardown();
    closeSession();
  }
}
