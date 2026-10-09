// Phase 29 Part B.12: the ONE place that turns instants into days. Every "today", "this week",
// streak and session boundary is a day in the profile's time zone (Settings → Review), never the
// device's local day. The lint rule (eslint-rules/progress-rule) forbids getDay / getDate /
// getHours / setHours / toDateString-style arithmetic anywhere else. Intl only, no library. Pure.

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Is this an IANA time zone the runtime knows? */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock time of `at` in `timeZone`. */
export function zonedParts(at: Date, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(at))
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** Minutes `timeZone` is ahead of UTC at `at`. */
function offsetMinutes(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant a wall-clock time happens in `timeZone`. A time skipped by a DST change moves
 * forward by the gap. Days and months may overflow (day 32 is the 1st of the next month). */
export function zonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  const second = guess - offsetMinutes(new Date(first), timeZone) * 60_000;
  const wall = (t: number) => {
    const p = zonedParts(new Date(t), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === guess;
  };
  const valid = [first, second].filter(wall);
  // Neither shows this wall time only inside a spring-forward gap: the later one is the time after it.
  return new Date(valid.length > 0 ? Math.min(...valid) : Math.max(first, second));
}

/** "YYYY-MM-DD" of `at` in `timeZone`. */
export function zonedDay(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Start of the local day of `at` in `timeZone` (midnight, or the first instant after a DST gap). */
export function zonedStartOfDay(at: Date, timeZone: string): Date {
  const p = zonedParts(at, timeZone);
  return zonedDate(p.year, p.month, p.day, 0, 0, timeZone);
}

/** The profile-zone day of `at`, "YYYY-MM-DD" (the key every day count uses). */
export const dayKey = (at: Date, timeZone: string): string => zonedDay(at, timeZone);

/** A day key `n` days after `key` (calendar arithmetic, no time zone involved). */
export function addDaysToKey(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** Whole days from day key `a` to day key `b` (b − a). */
export function daysBetweenKeys(a: string, b: string): number {
  const toUtc = (k: string) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** Monday 0 … Sunday 6 of a day key. */
export function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
}

/** The instant a day key starts in `timeZone`. */
export function startOfDayKey(key: string, timeZone: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return zonedDate(y!, m!, d!, 0, 0, timeZone);
}

export interface WeekRange {
  /** Monday 00:00 of this week in the zone. */
  from: Date;
  /** Next Monday 00:00 (exclusive). */
  to: Date;
  /** Monday … Sunday day keys. */
  days: string[];
}

/** "This week": Monday to Sunday in the profile's zone (Phase 29: Monday-start everywhere). */
export function weekRange(now: Date, timeZone: string): WeekRange {
  const today = zonedDay(now, timeZone);
  const monday = addDaysToKey(today, -weekdayOfKey(today));
  const days = Array.from({ length: 7 }, (_, i) => addDaysToKey(monday, i));
  return { from: startOfDayKey(monday, timeZone), to: startOfDayKey(addDaysToKey(monday, 7), timeZone), days };
}

/** The instant the next day starts in `timeZone` (the end of "today"). */
export function zonedEndOfDay(at: Date, timeZone: string): Date {
  return startOfDayKey(addDaysToKey(zonedDay(at, timeZone), 1), timeZone);
}
