import { useSyncExternalStore } from 'react';
import { DEFAULT_SESSION_SETTINGS, isValidTimeZone, sanitizeSessionSettings, type SessionSettings } from '@anan/core';
import { currentSession, db, onSessionChange } from '../db/instance.js';
import { setBulkCapSource } from './learner-service.js';

/** Phase 20: Settings → Review. Per profile (the `settings` table syncs with the profile).
 * Phase 23: the two review sessions (time zone, times) and the cap per session. */
export type ReviewSettings = SessionSettings;

const KEY = 'reviewSettings';
/** The time zone a profile starts with: America/New_York, unless this device names another. */
const DEVICE_ZONE_KEY = 'anan.sessions.defaultZone';
function defaults(): ReviewSettings {
  let zone: string | null = null;
  try {
    zone = localStorage.getItem(DEVICE_ZONE_KEY);
  } catch {
    zone = null;
  }
  return { ...DEFAULT_SESSION_SETTINGS, ...(zone && isValidTimeZone(zone) ? { timeZone: zone } : {}) };
}
const DEFAULTS: ReviewSettings = defaults();

let settings: ReviewSettings = { ...DEFAULTS };
let loaded = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function sanitizeReviewSettings(v: unknown): ReviewSettings {
  const o = (v ?? {}) as Partial<ReviewSettings> & { dailyCap?: unknown };
  // Phase 20 stored a daily cap: it becomes the cap per session.
  const capPerSession = o.capPerSession ?? (typeof o.dailyCap === 'number' ? o.dailyCap : undefined);
  return sanitizeSessionSettings({ ...DEFAULTS, ...o, ...(capPerSession !== undefined ? { capPerSession } : {}) });
}

async function load(): Promise<void> {
  if (loaded || !currentSession()) return;
  loaded = true;
  const forProfile = currentSession()!.profileId;
  const row = await db.settings.get(KEY).catch(() => undefined);
  if (currentSession()?.profileId !== forProfile) return;
  if (row?.value) settings = sanitizeReviewSettings(row.value);
  notify();
}

onSessionChange((s) => {
  settings = { ...DEFAULTS };
  loaded = false;
  notify();
  if (s) void load();
});

setBulkCapSource(() => settings.capPerSession);

/** After a sync merge replaced the database contents. */
export function reloadReviewSettings(): void {
  loaded = false;
  void load();
}

export async function getReviewSettings(): Promise<ReviewSettings> {
  await load();
  return settings;
}

export async function updateReviewSettings(patch: Partial<ReviewSettings>): Promise<void> {
  settings = sanitizeReviewSettings({ ...settings, ...patch });
  loaded = true;
  notify();
  await db.settings.put({ key: KEY, value: settings });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useReviewSettings(): ReviewSettings {
  if (!loaded && currentSession()) void load();
  return useSyncExternalStore(subscribe, () => settings);
}
