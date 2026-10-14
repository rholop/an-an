// Phase 42 (owner, 2026-10-14): a word is Mastered once every one of its mastery cards (Meaning and
// production) has been rated Easy three times; about two weeks later each such card comes back once
// to be re-checked: Easy keeps it, anything else un-masters it. Pure; time is passed in.

import { Rating } from 'ts-fsrs';
import type { SkillCard } from '../learner/types.js';
import { PROGRESS_CONFIG, type ProgressConfig } from './progress.config.js';

type EasyFlags = Pick<SkillCard['flags'], 'easyCount' | 'easyAt' | 'rechecked'>;
type EasyCard = Pick<SkillCard, 'skill' | 'card' | 'flags'>;
type Cfg = Pick<ProgressConfig, 'mastered'>;

const DAY_MS = 86_400_000;

/** A card from before Phase 42 that already met the old stability rule counts as fully rated Easy
 * (so words Mastered before keep their status and are never sent back for a re-check). */
function grandfathered(c: Pick<SkillCard, 'skill' | 'card'>, cfg: Cfg): boolean {
  if (c.skill === 'recognition') return c.card.stability >= cfg.mastered.recognitionStabilityDays;
  if (c.skill === 'production') return c.card.stability >= cfg.mastered.productionStabilityDays;
  return false;
}

/** Easy ratings this card has, toward `easyRatings`. */
export function easyCount(c: EasyCard, cfg: Cfg = PROGRESS_CONFIG): number {
  return c.flags.easyCount ?? (grandfathered(c, cfg) ? cfg.mastered.easyRatings : 0);
}

/** The card has the Easy ratings Mastered needs. */
export const easyEnough = (c: EasyCard, cfg: Cfg = PROGRESS_CONFIG): boolean => easyCount(c, cfg) >= cfg.mastered.easyRatings;

/** This card is due its one re-check: it earned its Easy ratings `recheckDays` ago or more and has
 * not been re-checked. (Grandfathered cards have no `easyAt` and never come back.) */
export function recheckDue(c: EasyCard, now: Date, cfg: Cfg = PROGRESS_CONFIG): boolean {
  const { easyAt, rechecked } = c.flags;
  if (!easyAt || rechecked || c.flags.easyCount === undefined || c.flags.easyCount < cfg.mastered.easyRatings) return false;
  return now.getTime() >= new Date(easyAt).getTime() + cfg.mastered.recheckDays * DAY_MS;
}

/**
 * The Easy-rating flags after `grade` on `c` at `now`. Easy adds one (the third stamps `easyAt`);
 * Again resets the count; Hard and Good leave it. A card due its re-check keeps its ratings only on
 * Easy (`rechecked`); any other grade un-masters it (count back to 0).
 */
export function nextEasyFlags(c: EasyCard | undefined, grade: Rating, now: Date, cfg: Cfg = PROGRESS_CONFIG): EasyFlags {
  const need = cfg.mastered.easyRatings;
  const prior = c ? easyCount(c, cfg) : 0;
  const keep: EasyFlags = c
    ? {
        ...(c.flags.easyCount !== undefined || prior > 0 ? { easyCount: prior } : {}),
        ...(c.flags.easyAt ? { easyAt: c.flags.easyAt } : {}),
        ...(c.flags.rechecked ? { rechecked: true } : {}),
      }
    : {};
  if (c && recheckDue(c, now, cfg)) return grade === Rating.Easy ? { ...keep, rechecked: true } : { easyCount: 0 };
  if (grade === Rating.Again) return { easyCount: 0 };
  if (grade !== Rating.Easy) return keep;
  const count = prior + 1;
  return {
    easyCount: count,
    ...(count >= need && prior < need ? { easyAt: now } : keep.easyAt ? { easyAt: keep.easyAt } : {}),
    ...(keep.rechecked ? { rechecked: true } : {}),
  };
}
