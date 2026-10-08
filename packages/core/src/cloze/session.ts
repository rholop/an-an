import type { ClozeRung, SkillCard } from '../learner/types.js';
import type { Lexicon } from '../lexicon.js';
import type { ErrorItem } from '../journal/types.js';
import {
  normalisePattern,
  patternCounts,
  RECURRING_PATTERN_MIN,
  selectDueErrorItems,
} from '../journal/error-bank.js';
import type { Word } from '../types.js';
import { isNewCard } from '../progress/terms.js';
import { itemKey, orderSession, seededRng, type OrderedSession, type SessionCard } from '../session/orderSession.js';
import {
  selectClozeSource,
  type ClozeSourceCandidate,
  type SelectClozeSourceOptions,
} from './source.js';

export type ExerciseKind = 'word_bank' | 'multiple_choice' | 'typed';

export interface SessionItem {
  card: SkillCard;
  word: Word;
  exerciseKind: ExerciseKind;
  source: ClozeSourceCandidate | null;
}

export interface SessionConfig {
  /** Total items in the session. Default 20 (phase doc §"A full 20-item
   * session works offline"). */
  maxItems: number;
  /** Cards not yet in 'review'/'mature' state ("new" items) are capped
   * separately so a session doesn't become all-new-material; the rest of
   * maxItems is filled with review/mature cards. */
  maxNewItems: number;
  /** Phase 5: error-bank clozes per session (recurring patterns first). */
  maxErrorItems: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  maxItems: 20,
  maxNewItems: 5,
  maxErrorItems: 5,
};

/** rung 1/2 are recognition-style (word bank / multiple choice); rung 3 is
 * typed from memory. See cloze/ladder.ts's doc comment and apply-evidence's
 * applyClozeAnswer for why this is skill-agnostic: whichever SkillCard
 * (recognition or production) is actually due drives its own rung. */
function exerciseKindForRung(rung: ClozeRung): ExerciseKind {
  if (rung === 1) return 'word_bank';
  if (rung === 2) return 'multiple_choice';
  return 'typed';
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export interface BuildSessionOptions extends SelectClozeSourceOptions {
  lexicon: Lexicon;
  config?: Partial<SessionConfig>;
  rng?: () => number;
  /** Phase 14: lower rank = picked first among new / review cards (stable, after the shuffle).
   * Absent = the pre-Phase-14 session exactly. */
  rank?: (card: SkillCard) => number;
  /** Phase 19: seed for the session order (the session id). Default: drawn from `rng`. */
  seed?: string;
  /** Phase 19: keys of the cards shown just before (see orderSession's `recent`). */
  recent?: readonly (readonly string[])[];
}

const describeItem = (item: SessionItem): SessionCard => ({
  keys: [itemKey(item.card.item), `zh:${item.word.headword}`],
});

function describeEntry(e: SessionEntry): SessionCard {
  if (e.kind === 'card') return describeItem(e.item);
  return { keys: [`error:${e.error.id}`, ...(e.error.itemRef ? [itemKey(e.error.itemRef)] : [])] };
}

const seedFrom = (options: BuildSessionOptions, rng: () => number) =>
  options.seed ?? `cloze-${Math.floor(rng() * 2 ** 32).toString(36)}`;

/**
 * Phase 4 §6 session builder: caps new items, fills the rest from due
 * review/mature cards, interleaves (a plain shuffle — "across topics and
 * exercise types" falls out naturally once rungs/words aren't grouped),
 * and resolves each item's cloze source (phase doc §2's priority order) so
 * the UI can show where it came from. Only word items are supported (no
 * grammar-pattern cloze yet); grammar cards in `dueCards` are skipped.
 */
export function buildSession(dueCards: SkillCard[], options: BuildSessionOptions): OrderedSession<SessionItem> {
  // Phase 21: every random choice comes from the session seed, so a logged seed rebuilds it exactly.
  const rng = options.rng ?? (options.seed ? seededRng(`${options.seed}:pool`) : Math.random);
  const config = { ...DEFAULT_SESSION_CONFIG, ...options.config };

  // Phase 21: "New" is the shared definition (never answered); everything else is a due card.
  const wordCards = dueCards.filter((c) => c.item.kind === 'word');
  const newCards = wordCards.filter((c) => isNewCard(c));
  const reviewCards = wordCards.filter((c) => !isNewCard(c));

  // Phase 5 gap capture: unreviewed words the learner needed mid-journal go
  // to the front of the new-item allowance, ahead of the shuffled rest.
  const isPriority = (c: SkillCard) => c.flags.priority === true;
  const byRank = <T extends SkillCard>(cards: T[]): T[] => {
    const rank = options.rank;
    if (!rank) return cards;
    return cards
      .map((c, i) => ({ c, i, r: rank(c) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.c);
  };
  const cappedNew = [
    ...shuffle(newCards.filter(isPriority), rng),
    ...byRank(
      shuffle(
        newCards.filter((c) => !isPriority(c)),
        rng,
      ),
    ),
  ].slice(0, config.maxNewItems);
  const remainingSlots = Math.max(0, config.maxItems - cappedNew.length);
  const pool = shuffle([...cappedNew, ...byRank(shuffle(reviewCards, rng)).slice(0, remainingSlots)], rng);

  const items: SessionItem[] = [];
  for (const card of pool) {
    const word = options.lexicon.byId(card.item.id);
    if (!word) continue; // stale/renamed id — skip rather than crash a whole session
    const source = selectClozeSource(word, options);
    items.push({ card, word, exerciseKind: exerciseKindForRung(card.clozeRung), source });
  }
  // Phase 19: the shared order — a word's recognition and production clozes never side by side.
  return orderSession(items, describeItem, { seed: seedFrom(options, rng), recent: options.recent });
}

export type SessionEntry =
  { kind: 'card'; item: SessionItem } | { kind: 'error'; error: ErrorItem };

export interface BuildMixedSessionOptions extends BuildSessionOptions {
  errorItems: readonly ErrorItem[];
  now: Date;
}

/**
 * Phase 5 §7: the Phase 4 session plus due error-bank clozes. Error items
 * take up to `maxErrorItems` of the `maxItems` slots (recurring patterns
 * first — see selectDueErrorItems); word cards fill the rest. Entries are
 * interleaved, except that recurring-pattern error items lead the session.
 */
export function buildMixedSession(
  dueCards: SkillCard[],
  options: BuildMixedSessionOptions,
): OrderedSession<SessionEntry> {
  const rng = options.rng ?? (options.seed ? seededRng(`${options.seed}:mix`) : Math.random);
  const config = { ...DEFAULT_SESSION_CONFIG, ...options.config };
  const errors = selectDueErrorItems(options.errorItems, options.now, config.maxErrorItems);
  const cards = buildSession(dueCards, {
    ...options,
    config: { ...options.config, maxItems: Math.max(0, config.maxItems - errors.length) },
  });

  const counts = patternCounts(options.errorItems);
  const recurring = errors.filter(
    (e) => e.pattern && (counts.get(normalisePattern(e.pattern)) ?? 0) >= RECURRING_PATTERN_MIN,
  );
  const rest = errors.filter((e) => !recurring.includes(e));

  // Phase 19: recurring-pattern error items lead (band 0), the rest is the shared order.
  const entries: Array<{ e: SessionEntry; band: number }> = [
    ...recurring.map((error) => ({ e: { kind: 'error', error } as SessionEntry, band: 0 })),
    ...cards.map((item) => ({ e: { kind: 'card', item } as SessionEntry, band: 1 })),
    ...rest.map((error) => ({ e: { kind: 'error', error } as SessionEntry, band: 1 })),
  ];
  const bandOf = new Map(entries.map((x) => [x.e, x.band]));
  return orderSession(
    entries.map((x) => x.e),
    (e) => ({ ...describeEntry(e), band: bandOf.get(e) ?? 1 }),
    { seed: seedFrom(options, rng), recent: options.recent },
  );
}
