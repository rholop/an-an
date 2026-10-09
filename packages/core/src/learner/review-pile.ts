// Phase 20: keeping the review pile a sensible size, and saying "nope" to a card.
// Pure functions; time is always injected.
import { hashText } from '../hash.js';
import { LEVEL_IDS as LEVEL_ORDER, levelIndex, type Level } from '../levels.config.js';
import type { Evidence, ItemRef, Word } from '../types.js';
import { REVIEW_PILE_CONFIG, type ReviewPileConfig } from './review-pile.config.js';
import type { CardSource, SkillCard } from './types.js';
import { dueDayOf, forgetRiskOf, inAppAnswers, isActiveCard, isSeeded } from '../progress/terms.js';

const DAY = 86_400_000;

/** How a card created by this evidence came to exist. */
export function cardSourceFor(e: Pick<Evidence, 'kind' | 'context'>): CardSource {
  switch (e.kind) {
    case 'anki_import_seen':
      return 'anki';
    case 'placement_known':
    case 'placement_unknown':
      return 'placement';
    case 'textbook_lesson_covered':
      return 'textbook';
    case 'journal_correct_use':
    case 'journal_misuse':
      return 'journal';
    case 'cloze_correct_nohint':
    case 'cloze_correct_hint':
    case 'cloze_wrong':
      return 'cloze';
    case 'listening_correct':
    case 'listening_correct_replayed':
    case 'listening_wrong':
      return 'listening';
    case 'review_again':
    case 'review_hard':
    case 'review_good':
    case 'review_easy':
      return 'study_order';
    case 'review_restore':
      return 'added';
    case 'known_check_passed':
    case 'production_unlocked':
      return 'study_order';
    case 'listening_unlocked':
      return 'listening';
    case 'reading_correct':
    case 'reading_tone_wrong':
    case 'reading_wrong':
      return 'pinyin';
    case 'reading_unlocked':
      return 'study_order';
    case 'journal_priority':
      return 'journal';
    case 'chat_lookup_gloss':
      if (e.context?.source === 'reader') return 'reader_lookup';
      if (e.context?.source === 'journal') return 'journal';
      if (e.context?.refId === CHAT_LEAK_REF) return 'chat_leak';
      return 'chat_lookup';
    default:
      return 'other';
  }
}

/** `context.refId` on the lookups a chat reply forces in (words the validator let through). */
export const CHAT_LEAK_REF = 'validator-leak';

export const SOURCE_LABELS: Record<CardSource, string> = {
  anki: 'Anki import',
  placement: 'placement test',
  chat_lookup: 'chat lookups',
  reader_lookup: 'reader lookups',
  chat_leak: 'words a chat reply brought in',
  journal: 'journal',
  textbook: 'textbook lessons',
  study_order: 'new words from the study order',
  cloze: 'cloze',
  listening: 'listening',
  pinyin: 'pinyin practice',
  added: 'added by you',
  other: 'other',
};

/** In review at all: not "Never show", not "Not now". */
export { isActiveCard } from '../progress/terms.js';

/**
 * Part C.1: at most `remaining` of the due cards, most important first: lower `rank` (study
 * order) first, then the cards most likely forgotten. The rest stay due; nothing is changed.
 */
export function capDueCards<T extends SkillCard>(
  due: readonly T[],
  opts: { remaining: number; now: Date; rank?: (c: T) => number },
): T[] {
  const n = Math.max(0, Math.floor(opts.remaining));
  if (due.length <= n) return [...due];
  const rank = opts.rank ?? (() => 0);
  return due
    .map((c, i) => ({ c, i, r: rank(c), f: forgetRiskOf(c, opts.now) }))
    .sort((a, b) => a.r - b.r || b.f - a.f || a.i - b.i)
    .slice(0, n)
    .map((x) => x.c);
}

/**
 * Part C.3: give bulk-created cards (Anki import, placement) spread-out first due dates so they
 * never all fall due together. Each card gets a day in [min, min + span), span at least the
 * 2–4 week fuzz and wide enough that no day gets more than `bulkShareOfCap × cap` of them.
 * Deterministic: the day comes from a hash of the item, balanced round-robin.
 */
export function spreadBulkDue(
  cards: readonly SkillCard[],
  now: Date,
  opts: { cap?: number; startDays?: number } = {},
  cfg: ReviewPileConfig = REVIEW_PILE_CONFIG,
): SkillCard[] {
  if (cards.length === 0) return [];
  const cap = opts.cap ?? cfg.dailyCap;
  const perDay = Math.max(1, Math.floor(cap * cfg.bulkShareOfCap));
  const fuzz = cfg.bulkSpreadMinDays + (cards.length % (cfg.bulkSpreadMaxDays - cfg.bulkSpreadMinDays + 1));
  const span = Math.max(fuzz, Math.ceil(cards.length / perDay));
  const start = opts.startDays ?? 1;
  const order = cards
    .map((c, i) => ({ c, i, h: hashText(`${c.item.kind}:${c.item.id}|${c.skill}`) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.i - b.i));
  const out = new Array<SkillCard>(cards.length);
  order.forEach(({ c, i }, k) => {
    const day = start + (k % span);
    const due = new Date(now.getTime() + day * DAY);
    out[i] = { ...c, card: { ...c.card, due, scheduled_days: Math.max(c.card.scheduled_days, day) } };
  });
  return out;
}

/** Cards a migration may re-spread: created in bulk and never answered in the app since
 * (Phase 29 Part B.9: the shared in-app answer count, not a raw `reps`). */
export function isUnreviewedBulkCard(c: SkillCard): boolean {
  return isSeeded(c) && inAppAnswers(c) === 0 && isActiveCard(c);
}

/** A word is a name (never a review target on its own). */
export const isName = (w: Pick<Word, 'tags'>): boolean =>
  w.tags.includes('name') || w.tags.includes('proper-noun');

const isTextbookWord = (w: Pick<Word, 'tags' | 'source'>) =>
  w.source === 'textbook' || w.tags.some((t) => t.startsWith('textbook:'));

/** Part C.5: words new-item picks may come from: TOCFL, textbook lessons, the learner's own. */
export function newItemInBounds(w: Pick<Word, 'tags' | 'source' | 'level'>): boolean {
  if (isName(w)) return false;
  if (w.source === 'custom') return true;
  if (isTextbookWord(w)) return true;
  return w.source === 'tocfl' && w.level !== null;
}

/**
 * Part C.4: may a lookup of this word create a card on its own? Only for TOCFL words up to the
 * picked level + 1, and textbook lesson words; never names or words in no list.
 */
export function lookupMayIntroduce(
  w: Pick<Word, 'tags' | 'source' | 'level'>,
  pickedLevel: Level | undefined,
  cfg: Pick<ReviewPileConfig, 'lookupLevelsAbove'> = REVIEW_PILE_CONFIG,
): boolean {
  if (isName(w)) return false;
  if (w.source === 'custom' || isTextbookWord(w)) return true;
  if (w.source !== 'tocfl' || w.level === null) return false;
  if (!pickedLevel) return true;
  return levelIndex(w.level) <= levelIndex(pickedLevel) + cfg.lookupLevelsAbove;
}

/**
 * "Not now" ends when the word's own level becomes the picked level, or its lesson becomes the
 * active study step — and that wasn't already so when it was snoozed.
 */
export function shouldWake(
  c: Pick<SkillCard, 'flags'>,
  word: { level: Level | null; lessonId?: string } | undefined,
  now: { level?: Level; activeLessonId?: string },
): boolean {
  if (!c.flags.snoozed || !word) return false;
  const was = c.flags.snoozedWhen ?? {};
  if (word.level && now.level === word.level && was.level !== word.level) return true;
  if (word.lessonId && now.activeLessonId === word.lessonId && was.lessonId !== word.lessonId) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Part A / D: the pile report, and clean-up groups.

export type LevelBucket = Level | 'textbook' | 'custom' | 'none';

export interface PileRow {
  item: ItemRef;
  skill: SkillCard['skill'];
  headword: string;
  source: CardSource;
  level: LevelBucket;
  /** Above the picked level (TOCFL level only). */
  aboveLevel: boolean;
  dueDay: string;
  removed: 'not_now' | 'known' | 'never' | undefined;
}

export interface PileReport {
  rows: PileRow[];
  bySource: Partial<Record<CardSource, number>>;
  byLevel: Partial<Record<LevelBucket, number>>;
  /** yyyy-mm-dd → active cards due that day, busiest first. */
  busiestDays: Array<{ day: string; count: number; bySource: Partial<Record<CardSource, number>> }>;
  aboveLevel: number;
  notInAnyList: number;
}


export function levelBucketOf(w: Pick<Word, 'tags' | 'source' | 'level'> | undefined): LevelBucket {
  if (!w) return 'none';
  if (w.source === 'tocfl' && w.level) return w.level;
  if (isTextbookWord(w)) return 'textbook';
  if (w.source === 'custom') return 'custom';
  return 'none';
}

export function pileReport(
  cards: readonly SkillCard[],
  wordOf: (id: string) => Word | undefined,
  pickedLevel: Level | undefined,
): PileReport {
  const rows: PileRow[] = [];
  for (const c of cards) {
    if (c.item.kind !== 'word' || c.skill === 'listening') continue;
    const w = wordOf(c.item.id);
    const level = levelBucketOf(w);
    rows.push({
      item: c.item,
      skill: c.skill,
      headword: w?.headword ?? c.item.id,
      source: c.source ?? 'other',
      level,
      aboveLevel:
        !!pickedLevel && LEVEL_ORDER.includes(level as Level) && levelIndex(level as Level) > levelIndex(pickedLevel),
      dueDay: dueDayOf(c),
      removed: c.flags.excluded ? 'never' : c.flags.snoozed ? 'not_now' : c.flags.markedKnown ? 'known' : undefined,
    });
  }
  const active = rows.filter((r) => !r.removed || r.removed === 'known');
  const count = <K extends string>(xs: PileRow[], key: (r: PileRow) => K) => {
    const o: Partial<Record<K, number>> = {};
    for (const r of xs) o[key(r)] = (o[key(r)] ?? 0) + 1;
    return o;
  };
  const days = new Map<string, PileRow[]>();
  for (const r of active.filter((x) => !x.removed)) days.set(r.dueDay, [...(days.get(r.dueDay) ?? []), r]);
  return {
    rows,
    bySource: count(active, (r) => r.source),
    byLevel: count(active, (r) => r.level),
    busiestDays: [...days]
      .map(([day, rs]) => ({ day, count: rs.length, bySource: count(rs, (r) => r.source) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    aboveLevel: active.filter((r) => r.aboveLevel).length,
    notInAnyList: active.filter((r) => r.level === 'none').length,
  };
}

export type CleanupGroup =
  | { kind: 'above_level' }
  | { kind: 'no_list' }
  | { kind: 'source'; source: CardSource };

/** Word ids in a clean-up group (active cards only; a word counts once). */
export function cleanupGroupWordIds(report: PileReport, g: CleanupGroup): string[] {
  const match = (r: PileRow) =>
    !r.removed &&
    (g.kind === 'above_level' ? r.aboveLevel : g.kind === 'no_list' ? r.level === 'none' : r.source === g.source);
  return [...new Set(report.rows.filter(match).map((r) => r.item.id))];
}
