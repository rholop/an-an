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
}

/**
 * Phase 4 §6 session builder: caps new items, fills the rest from due
 * review/mature cards, interleaves (a plain shuffle — "across topics and
 * exercise types" falls out naturally once rungs/words aren't grouped),
 * and resolves each item's cloze source (phase doc §2's priority order) so
 * the UI can show where it came from. Only word items are supported (no
 * grammar-pattern cloze yet); grammar cards in `dueCards` are skipped.
 */
export function buildSession(dueCards: SkillCard[], options: BuildSessionOptions): SessionItem[] {
  const rng = options.rng ?? Math.random;
  const config = { ...DEFAULT_SESSION_CONFIG, ...options.config };

  const wordCards = dueCards.filter((c) => c.item.kind === 'word');
  const newCards = wordCards.filter((c) => c.state !== 'review' && c.state !== 'mature');
  const reviewCards = wordCards.filter((c) => c.state === 'review' || c.state === 'mature');

  // Phase 5 gap capture: unreviewed words the learner needed mid-journal go
  // to the front of the new-item allowance, ahead of the shuffled rest.
  const isPriority = (c: SkillCard) => c.flags.priority === true;
  const cappedNew = [
    ...shuffle(newCards.filter(isPriority), rng),
    ...shuffle(
      newCards.filter((c) => !isPriority(c)),
      rng,
    ),
  ].slice(0, config.maxNewItems);
  const remainingSlots = Math.max(0, config.maxItems - cappedNew.length);
  const pool = shuffle([...cappedNew, ...shuffle(reviewCards, rng).slice(0, remainingSlots)], rng);

  const items: SessionItem[] = [];
  for (const card of pool) {
    const word = options.lexicon.byId(card.item.id);
    if (!word) continue; // stale/renamed id — skip rather than crash a whole session
    const source = selectClozeSource(word, options);
    items.push({ card, word, exerciseKind: exerciseKindForRung(card.clozeRung), source });
  }
  return items;
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
): SessionEntry[] {
  const rng = options.rng ?? Math.random;
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

  const mixed: SessionEntry[] = shuffle(
    [
      ...cards.map((item): SessionEntry => ({ kind: 'card', item })),
      ...rest.map((error): SessionEntry => ({ kind: 'error', error })),
    ],
    rng,
  );
  return [...recurring.map((error): SessionEntry => ({ kind: 'error', error })), ...mixed];
}
