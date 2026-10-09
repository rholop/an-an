import { useEffect, useState } from 'react';
import {
  activeEvidence,
  buildLedger,
  ledgerEvidenceSince,
  PROGRESS_CONFIG,
  type Evidence,
  type Ledger,
  type LedgerStudyInputs,
  type SkillCard,
} from '@anan/core';
import { currentSession, db, onSessionChange } from '../db/instance.js';
import type { AnanDB } from '../db/schema.js';
import { peekCurrentLevel, useCurrentLevel } from './current-level.js';
import { setLedgerSource } from './learner-service.js';
import { getReviewSettings, useReviewSettings, type ReviewSettings } from './review-settings.js';
import { markStudyDirty, onStudyDirty, studyVersion } from './study-dirty.js';

/**
 * Phase 29 Part A.3: the ONE place the app gets progress numbers. Every screen and service asks
 * the ledger (core `buildLedger`) for due, new, Learned, Mastered, lesson and level shares, the
 * comprehensible words and days, so a number on one screen always matches every other. The
 * ledger is rebuilt after every evidence write and every sync merge (both mark the study state
 * dirty), after a settings change, and when a review session opens or ends.
 */

async function allCards(database: AnanDB): Promise<SkillCard[]> {
  const rows = await database.items.toArray();
  return rows.map(({ pk: _pk, ...c }) => c as SkillCard);
}

/** Every grammar answer (grammar dots count across days) and every row since the count window. */
async function ledgerEvidence(database: AnanDB, now: Date, settings: ReviewSettings): Promise<Evidence[]> {
  const since = ledgerEvidenceSince(now, settings);
  const [recent, grammar] = await Promise.all([
    database.evidence.where('at').between(since, now, true, true).toArray(),
    database.evidence
      .where('kind')
      .anyOf([...PROGRESS_CONFIG.grammarCorrectKinds, ...PROGRESS_CONFIG.grammarWrongKinds, 'evidence_undone'])
      .toArray(),
  ]);
  const seen = new Set<unknown>();
  const rows: Evidence[] = [];
  for (const r of [...recent, ...grammar]) {
    const key = (r as { id?: number }).id ?? r;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
  }
  return activeEvidence(rows);
}

/** Build a ledger from a database (the app's own, or a test's). */
export async function ledgerFrom(
  database: AnanDB,
  now: Date,
  opts: { settings?: ReviewSettings; study?: LedgerStudyInputs; knownItems?: readonly string[]; masteryShare?: number } = {},
): Promise<Ledger> {
  const settings = opts.settings ?? (await getReviewSettings());
  const [cards, evidence] = await Promise.all([allCards(database), ledgerEvidence(database, now, settings)]);
  return buildLedger({
    cards,
    evidence,
    knownItems: opts.knownItems ?? [],
    session: settings,
    masteryShare: opts.masteryShare ?? 0.8,
    now,
    ...(opts.study ? { study: opts.study } : {}),
  });
}

/** What the study module (lib/study.ts) gives the ledger; registered there so this module never
 * imports it (that would close an import cycle through the profile controller). */
export interface LedgerStudySource {
  load(): Promise<void>;
  /** The study context (absent until the lexicon has loaded). */
  inputs(): Omit<LedgerStudyInputs, 'level'> | undefined;
  knownItems(): readonly string[];
  masteryShare(): number;
}
let studySource: LedgerStudySource | undefined;
export function setLedgerStudySource(source: LedgerStudySource): void {
  studySource = source;
  cache = undefined;
}

function studyInputs(): LedgerStudyInputs | undefined {
  const inputs = studySource?.inputs();
  if (!inputs) return undefined;
  const level = peekCurrentLevel();
  return { ...inputs, ...(level.isExplicit ? { level: level.level } : {}) };
}

/** A ledger stays good for this long within one study version (learning steps are minutes). */
const FRESH_MS = 30_000;
let cache: { key: string; at: number; ledger: Promise<Ledger> } | undefined;

onSessionChange(() => {
  cache = undefined;
});

/**
 * Any write to the cards or the evidence log (the learner service, a sync merge, an import, a
 * restore, another module writing Dexie directly) makes the cached ledger stale: one dirty mark per
 * burst of writes, after they are queued.
 */
const watched = new WeakSet<object>();
let dirtyQueued = false;
function watchWrites(database: AnanDB): void {
  if (watched.has(database)) return;
  watched.add(database);
  const changed = () => {
    if (dirtyQueued) return;
    dirtyQueued = true;
    setTimeout(() => {
      dirtyQueued = false;
      markStudyDirty();
    }, 0);
  };
  for (const table of [database.items, database.evidence]) {
    table.hook('creating', changed);
    table.hook('updating', changed);
    table.hook('deleting', changed);
  }
}

/** The ledger for `now` (default: this moment), cached until anything it reads changes. */
export async function getLedgerNow(now: Date = new Date()): Promise<Ledger> {
  const session = currentSession();
  if (session) watchWrites(session.db);
  await studySource?.load();
  const settings = await getReviewSettings();
  const study = studyInputs();
  const key = [
    session?.profileId ?? '',
    studyVersion(),
    JSON.stringify(settings),
    study ? `${study.books.length}:${study.level ?? ''}:${study.settings.enabled}` : 'none',
  ].join('|');
  if (cache && cache.key === key && Math.abs(now.getTime() - cache.at) < FRESH_MS) return cache.ledger;
  const ledger = ledgerFrom(db, now, {
    settings,
    ...(study ? { study } : {}),
    knownItems: studySource?.knownItems() ?? [],
    masteryShare: studySource?.masteryShare() ?? 0.8,
  });
  cache = { key, at: now.getTime(), ledger };
  ledger.catch(() => {
    if (cache?.ledger === ledger) cache = undefined;
  });
  return ledger;
}

// The learner service's services (chat, reader, stories) read the same ledger.
setLedgerSource((now) => getLedgerNow(now));

/** React: the live ledger. Refreshes after any study change, a settings change, a level change
 * and when a review session opens or ends. Undefined until the first one is built. */
export function useLedger(): Ledger | undefined {
  const [ledger, setLedger] = useState<Ledger | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const settings = useReviewSettings();
  const { level } = useCurrentLevel();
  useEffect(() => onStudyDirty(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    if (!currentSession()) return;
    let cancelled = false;
    getLedgerNow()
      .then((l) => !cancelled && setLedger(l))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tick, settings, level]);
  const status = ledger?.status;
  const boundary = status
    ? Math.min(status.sessionEndsAt?.getTime() ?? Infinity, status.nextSession.opensAt.getTime())
    : undefined;
  useEffect(() => {
    if (boundary === undefined || !Number.isFinite(boundary)) return;
    // setTimeout's limit is ~24.8 days; the next session boundary is always within a day.
    const id = setTimeout(() => setTick((t) => t + 1), Math.max(1000, boundary - Date.now() + 500));
    return () => clearTimeout(id);
  }, [boundary]);
  return ledger;
}
