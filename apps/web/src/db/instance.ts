import { DEFAULT_LEARNER_CONFIG } from '@anan/core';
import { setActiveProfileForApi } from '../lib/api.js';
import { GameService } from '../lib/game-service.js';
import { LearnerService } from '../lib/learner-service.js';
import type { ProfileId } from '../profiles.js';
import { DexieLearnerRepo } from './learner-repo.js';
import { AnanDB } from './schema.js';

/**
 * Phase 8: one Dexie database per profile (`anan-${profileId}`), holding every
 * learner table unchanged — so no query anywhere needs a profileId filter.
 *
 * The rest of the app keeps importing `db`, `learnerService`, `gameService`
 * from here exactly as before; they are now thin forwarders to the CURRENT
 * session, so switching profile just swaps what they point at (the UI then
 * remounts and re-reads). Nothing may touch them before a profile is opened —
 * the profile gate guarantees that.
 */
export interface Session {
  profileId: ProfileId;
  db: AnanDB;
  learnerRepo: DexieLearnerRepo;
  gameService: GameService;
  learnerService: LearnerService;
}

export const profileDbName = (profileId: ProfileId): string => `anan-${profileId}`;

let session: Session | null = null;
const listeners = new Set<(s: Session | null) => void>();

export function createSession(
  profileId: ProfileId,
  dbName: string = profileDbName(profileId),
): Session {
  const db = new AnanDB(dbName);
  const learnerRepo = new DexieLearnerRepo(db);
  const gameService = new GameService(db);
  const learnerService = new LearnerService(
    learnerRepo,
    DEFAULT_LEARNER_CONFIG,
    (evidence, prior) => gameService.onEvidence(evidence, prior),
  );
  return { profileId, db, learnerRepo, gameService, learnerService };
}

/** Opens `profileId`'s database and makes it current (closing the previous one). */
export function openSession(profileId: ProfileId): Session {
  if (session?.profileId === profileId) return session;
  const previous = session;
  session = createSession(profileId);
  setActiveProfileForApi(profileId);
  previous?.db.close();
  listeners.forEach((l) => l(session));
  return session;
}

export function closeSession(): void {
  session?.db.close();
  session = null;
  setActiveProfileForApi(null);
  listeners.forEach((l) => l(null));
}

export const currentSession = (): Session | null => session;

export function requireSession(): Session {
  if (!session) throw new Error('No profile is open yet — the profile gate must run first.');
  return session;
}

export function onSessionChange(listener: (s: Session | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A forwarder that always reaches the current session's object, binding
 * methods to it (Dexie tables and services use `this`). */
function forward<T extends object>(pick: () => T): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      const target = pick() as Record<PropertyKey, unknown>;
      const value = target[prop];
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
    set(_t, prop, value) {
      (pick() as Record<PropertyKey, unknown>)[prop] = value;
      return true;
    },
  });
}

export const db: AnanDB = forward(() => requireSession().db);
export const learnerRepo: DexieLearnerRepo = forward(() => requireSession().learnerRepo);
export const gameService: GameService = forward(() => requireSession().gameService);
export const learnerService: LearnerService = forward(() => requireSession().learnerService);

// Dev/e2e-only hook: lets Playwright seed/inspect the DB directly without a
// dedicated test API. Never included in a production build. Getters, so it
// always reflects the profile that is open right now.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  Object.defineProperty(window, '__anan', {
    configurable: true,
    get: () =>
      session
        ? {
            db,
            learnerRepo,
            learnerService,
            gameService,
            profileId: session.profileId,
            sync: window.__ananSync,
          }
        : undefined,
  });
}

declare global {
  interface Window {
    __ananSync?: unknown;
  }
}
