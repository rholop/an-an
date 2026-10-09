// Phase 23 Part A: two review sessions a day instead of exact due times. Card due times stay exact
// (FSRS is unchanged); this only groups them. The morning session holds every card due before the
// evening opens, the evening session every card due before the next morning ends, so each session
// covers everything up to the next one and nothing is ever "due at 3:40 pm". All times are in the
// profile's time zone. Pure; time is always injected.

import { isValidTimeZone, zonedDate, zonedParts, zonedStartOfDay } from './time.js';

export * from './time.js';

export type SessionName = 'morning' | 'evening';

/** Per profile (Settings → Review). Times are "HH:MM" in `timeZone`. */
export interface SessionSettings {
  timeZone: string;
  morningOpens: string;
  morningEnds: string;
  eveningOpens: string;
  /** The evening ends at this time the next day when it is not after `eveningOpens`. */
  eveningEnds: string;
  capPerSession: number;
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  timeZone: 'America/New_York',
  morningOpens: '04:00',
  morningEnds: '10:00',
  eveningOpens: '16:00',
  eveningEnds: '04:00',
  capPerSession: 80,
};

/** One session on one local day. */
export interface SessionWindow {
  name: SessionName;
  /** The local day it opens on, "YYYY-MM-DD". */
  day: string;
  opensAt: Date;
  endsAt: Date;
  /** It holds every card due before this. */
  cutoff: Date;
}

// ---------------------------------------------------------------------------------------------
// Settings

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (t: string): number => {
  const m = HHMM.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
const fromMinutes = (n: number): string =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/**
 * Settings that always make sense: valid times and zone, the morning before the evening on the
 * same day, the evening over before the next morning opens, a cap of 10–500. Anything else falls
 * back to the default for that field.
 */
export function sanitizeSessionSettings(v: unknown): SessionSettings {
  const o = (v ?? {}) as Partial<Record<keyof SessionSettings, unknown>>;
  const d = DEFAULT_SESSION_SETTINGS;
  const time = (x: unknown, def: string) => (typeof x === 'string' && HHMM.test(x.trim()) ? fromMinutes(toMinutes(x)) : def);
  const timeZone = typeof o.timeZone === 'string' && isValidTimeZone(o.timeZone) ? o.timeZone : d.timeZone;
  let mo = toMinutes(time(o.morningOpens, d.morningOpens));
  let me = toMinutes(time(o.morningEnds, d.morningEnds));
  let eo = toMinutes(time(o.eveningOpens, d.eveningOpens));
  let ee = toMinutes(time(o.eveningEnds, d.eveningEnds));
  if (!(mo < me && me <= eo)) {
    mo = toMinutes(d.morningOpens);
    me = toMinutes(d.morningEnds);
    eo = toMinutes(d.eveningOpens);
  }
  // The evening ends the same day (after it opens) or the next day no later than the morning opens.
  if (!(ee > eo || ee <= mo)) ee = mo;
  const cap =
    typeof o.capPerSession === 'number' && Number.isFinite(o.capPerSession) ? Math.round(o.capPerSession) : d.capPerSession;
  return {
    timeZone,
    morningOpens: fromMinutes(mo),
    morningEnds: fromMinutes(me),
    eveningOpens: fromMinutes(eo),
    eveningEnds: fromMinutes(ee),
    capPerSession: Math.min(500, Math.max(10, cap)),
  };
}

// ---------------------------------------------------------------------------------------------
// Windows

function windowsOfDay(year: number, month: number, day: number, s: SessionSettings): SessionWindow[] {
  const tz = s.timeZone;
  const at = (dayOffset: number, hhmm: string) => {
    const m = toMinutes(hhmm);
    return zonedDate(year, month, day + dayOffset, Math.floor(m / 60), m % 60, tz);
  };
  const name = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  const eveningEndsNextDay = toMinutes(s.eveningEnds) <= toMinutes(s.eveningOpens);
  return [
    { name: 'morning', day: name, opensAt: at(0, s.morningOpens), endsAt: at(0, s.morningEnds), cutoff: at(0, s.eveningOpens) },
    {
      name: 'evening',
      day: name,
      opensAt: at(0, s.eveningOpens),
      endsAt: at(eveningEndsNextDay ? 1 : 0, s.eveningEnds),
      cutoff: at(1, s.morningEnds),
    },
  ];
}

/** Every session from the day before `now` to `days` days after it, in order. */
export function sessionWindows(now: Date, s: SessionSettings, days = 8): SessionWindow[] {
  const p = zonedParts(now, s.timeZone);
  const out: SessionWindow[] = [];
  for (let k = -1; k <= days; k++) out.push(...windowsOfDay(p.year, p.month, p.day + k, s));
  return out;
}

export interface SessionPosition {
  /** The session open now (absent between sessions). */
  current?: SessionWindow;
  /** The last session that has ended. */
  previous: SessionWindow;
  /** The next session to open. */
  next: SessionWindow;
}

/** Where `now` falls: in a session, or between two. */
export function sessionAt(now: Date, s: SessionSettings): SessionPosition {
  const all = sessionWindows(now, s, 2);
  const t = now.getTime();
  const current = all.find((w) => w.opensAt.getTime() <= t && t < w.endsAt.getTime());
  const previous = [...all].reverse().find((w) => w.endsAt.getTime() <= t)!;
  const next = all.find((w) => w.opensAt.getTime() > t)!;
  return { ...(current ? { current } : {}), previous, next };
}

/**
 * The session a card due at `due` will be in: the first session not yet over whose cutoff is after
 * the due time. A session nobody did rolls into the next one, so an overdue card is always in the
 * current or next session. `windows` must be in order (`sessionWindows`).
 */
export function sessionForDue(due: Date, now: Date, windows: readonly SessionWindow[]): SessionWindow | undefined {
  const t = due.getTime();
  const n = now.getTime();
  return windows.find((w) => w.endsAt.getTime() > n && t < w.cutoff.getTime());
}

/** When the count window of the current position starts: the current session's opening, or (between
 * sessions) the end of the previous one, so "Review early" answers count once. */
export function countWindowStart(pos: SessionPosition): Date {
  return pos.current ? pos.current.opensAt : pos.previous.endsAt;
}

/** The earliest evidence time a status needs (the count window and the local day). */
export function statusEvidenceSince(now: Date, s: SessionSettings): Date {
  const start = countWindowStart(sessionAt(now, s));
  const day = zonedStartOfDay(now, s.timeZone);
  return start < day ? start : day;
}
