// Phase 43 (owner, 2026-10-16: "having 100 cards to review is just so discouraging"): the web side of
// calm review sessions. A session is fixed at its first answer (Part C.1: the `reviewSessions/<key>`
// settings rows, synced with the profile), and once per profile the old backlog is calmed (Part B.4 /
// Part F): every answered card gets its Good run from its history, so a Meaning rated Good once under
// Phase 42 no longer lets Pick in; the old 80-card cap becomes the 40-card ceiling; and a one-time
// note says the backlog was spread out. Due dates and answers are never touched.
import {
  activeEvidence,
  goodRunsFromHistory,
  OLD_DEFAULT_CAP,
  type Evidence,
  type FixedSession,
  type Ledger,
  type RunAnswer,
  type SessionSettings,
} from '@anan/core';
import type { AnanDB } from '../db/schema.js';

export const FIXED_SESSION_PREFIX = 'reviewSessions/';
/** The settings row that says the one-time migration ran for this profile. */
export const FACE_HOLD_MIGRATED_KEY = 'faceHoldMigratedAt';
/** The settings row that holds the one-time "We spread out your backlog" note until it is shown. */
export const BACKLOG_NOTICE_KEY = 'backlogNoticePending';
const REVIEW_SETTINGS_KEY = 'reviewSettings';
/** Fixed sessions older than this are dropped. */
const KEEP_DAYS = 3;

/** The fixed sessions stored for this profile. */
export async function loadFixedSessions(database: AnanDB): Promise<FixedSession[]> {
  const rows = await database.settings.where('key').startsWith(FIXED_SESSION_PREFIX).toArray().catch(() => []);
  return rows.flatMap((r) => {
    const v = r.value as Partial<FixedSession> | undefined;
    if (!v || typeof v.key !== 'string' || !Array.isArray(v.cardKeys)) return [];
    return [{ key: v.key, at: new Date(v.at ?? 0), cardKeys: v.cardKeys, newKeys: Array.isArray(v.newKeys) ? v.newKeys : [] }];
  });
}

/**
 * Part C.1: called just before the first answer of a session. Saves the session as it stands (its
 * cards and its new cards); from then on nothing new joins it. Returns true when it saved one.
 */
export async function fixSession(database: AnanDB, ledger: Ledger, opts: { early?: boolean } = {}): Promise<boolean> {
  const fixed = ledger.sessionToFix(opts);
  if (!fixed) return false;
  const rowKey = FIXED_SESSION_PREFIX + fixed.key;
  if (await database.settings.get(rowKey)) return false;
  await database.settings.put({ key: rowKey, value: { ...fixed, at: fixed.at.toISOString() } });
  // drop old ones
  const old = (await loadFixedSessions(database)).filter((f) => ledger.now.getTime() - f.at.getTime() > KEEP_DAYS * 86_400_000);
  if (old.length > 0) await database.settings.bulkDelete(old.map((f) => FIXED_SESSION_PREFIX + f.key));
  return true;
}

// ts-fsrs ratings (Again 1, Hard 2, Good 3, Easy 4)
type Grade = RunAnswer['grade'];
const [AGAIN, HARD, GOOD, EASY] = [1, 2, 3, 4] as Grade[];
const GRADE: Partial<Record<Evidence['kind'], Grade>> = {
  review_again: AGAIN,
  review_hard: HARD,
  review_good: GOOD,
  review_easy: EASY,
  face_rating_good: GOOD,
  face_rating_easy: GOOD,
  face_rating_not_yet: AGAIN,
};

/** Part B.4: each card's Good run from its whole answer history. */
export function runAnswersOf(evidence: readonly Evidence[]): RunAnswer[] {
  return evidence.flatMap((e) => {
    const grade = GRADE[e.kind];
    if (grade === undefined) return [];
    return [
      {
        key: `${e.item.kind}:${e.item.id}:${e.skill}`,
        at: new Date(e.at),
        grade,
        ...(e.kind === 'face_rating_not_yet' ? { rating: 'not_yet' as const } : {}),
      },
    ];
  });
}

const migrated = new WeakSet<AnanDB>();

/**
 * Part B.4 / Part F, once per profile: the Good run on every answered card, the 80-card cap moved to
 * the 40-card ceiling, and the backlog note queued. Waits until there is history (a fresh browser
 * before its restore never marks it done). Never changes a due date, an answer or a card's existence.
 */
export async function ensureCalmMigration(database: AnanDB, settings: SessionSettings, now: Date = new Date()): Promise<boolean> {
  if (migrated.has(database)) return false;
  if (await database.settings.get(FACE_HOLD_MIGRATED_KEY)) {
    migrated.add(database);
    return false;
  }
  if ((await database.evidence.count()) === 0) return false;
  migrated.add(database);
  const evidence = activeEvidence(await database.evidence.toArray());
  const runs = goodRunsFromHistory(runAnswersOf(evidence), settings);
  await database.transaction('rw', [database.items, database.settings], async () => {
    const rows = await database.items.toArray();
    const changed = rows.flatMap((row) => {
      const run = runs.get(row.pk);
      if (!run) return [];
      const { goodRun: _g, goodRunSession: _s, faceReleasedAt: _f, ...flags } = row.flags;
      return [{ ...row, flags: { ...flags, ...run } }];
    });
    if (changed.length > 0) await database.items.bulkPut(changed);
    const review = await database.settings.get(REVIEW_SETTINGS_KEY);
    const value = review?.value as { capPerSession?: unknown } | undefined;
    if (value && value.capPerSession === OLD_DEFAULT_CAP)
      await database.settings.put({ key: REVIEW_SETTINGS_KEY, value: { ...value, capPerSession: settings.capPerSession === OLD_DEFAULT_CAP ? 40 : settings.capPerSession } });
    await database.settings.put({ key: BACKLOG_NOTICE_KEY, value: true });
    await database.settings.put({ key: FACE_HOLD_MIGRATED_KEY, value: now.toISOString() });
  });
  return true;
}

/** Part F.4: the one-time note, if it is still to be shown ("We spread out your backlog: …"). Taking
 * it clears it. */
export async function takeBacklogNotice(database: AnanDB): Promise<boolean> {
  const row = await database.settings.get(BACKLOG_NOTICE_KEY).catch(() => undefined);
  if (!row?.value) return false;
  await database.settings.put({ key: BACKLOG_NOTICE_KEY, value: false });
  return true;
}
