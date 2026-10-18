import type { ClozeRung, SkillCard } from '../learner/types.js';
import type { Lexicon } from '../lexicon.js';
import type { ErrorItem } from '../journal/types.js';
import { selectDueErrorItems } from '../journal/error-bank.js';
import type { Evidence, Word } from '../types.js';
import type { AnswerKnown } from '../journal/answer-words.js';
import { practiceAnswerKind, type PracticeGrade } from '../progress/practice.js';
import { CLOZE_CONFIG } from './cloze.config.js';
import { compareOverdue, isNewCard } from '../progress/terms.js';
import {
  itemKey,
  markOrderedSession,
  orderSession,
  seededRng,
  sessionMeta,
  type OrderedSession,
  type SessionCard,
} from '../session/orderSession.js';
import {
  selectClozeSource,
  type ClozeSourceCandidate,
  type SelectClozeSourceOptions,
} from './source.js';

export type ExerciseKind = 'word_bank' | 'multiple_choice' | 'typed';

export interface SessionItem {
  /** Phase 37: the card the exercise uses (the word's most overdue card; production on a tie). */
  card: SkillCard;
  /** Phase 37: the word's other cards in this session (credited with the same answer when
   * `CLOZE_CONFIG.creditAllFacesOfWord` is on). Absent or empty = the word has one card here. */
  siblings?: SkillCard[];
  word: Word;
  exerciseKind: ExerciseKind;
  source: ClozeSourceCandidate | null;
  /** Phase 37: a retry later in the sitting (shown with an "Again" label), not a duplicate. */
  again?: true;
}

export interface SessionConfig {
  /** Total items in the session. Default 20 (phase doc §"A full 20-item
   * session works offline"). */
  maxItems: number;
  /** Phase 5: error-bank clozes per session (recurring patterns first). Phase 47: 3 (was 5), and
   * one for every `wordsPerErrorItem` word clozes at most, so word clozes always lead. */
  maxErrorItems: number;
  /** Phase 47 Part B.2: word clozes per journal fix (a session with 6 word clozes gets 1 fix). */
  wordsPerErrorItem: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  maxItems: 20,
  maxErrorItems: 3,
  wordsPerErrorItem: 6,
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
  /** Phase 47 practice: the cards come already ranked (weakest first); take them in that order
   * instead of shuffling (the session itself is still mixed). */
  keepOrder?: boolean;
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

/** Phase 37: what a cloze session left out, for the session log. */
export interface ClozeSessionMeta {
  /** Words left out because every sentence they have is already used in this session. */
  skippedNoFreshSentence: string[];
}

const CLOZE_META = Symbol.for('anan.clozeSessionMeta');

function withClozeMeta<T>(session: OrderedSession<T>, meta: ClozeSessionMeta): OrderedSession<T> {
  Object.defineProperty(session, CLOZE_META, { value: meta, enumerable: false });
  return session;
}

/** Phase 37: the session meta of a `buildSession` / `buildMixedSession` result. */
export function clozeSessionMeta(session: readonly unknown[]): ClozeSessionMeta | undefined {
  return (session as unknown as Record<symbol, ClozeSessionMeta | undefined>)[CLOZE_META];
}

/** Phase 37: one group per word; the shown card is the most overdue, production on a tie. */
interface WordGroup {
  card: SkillCard;
  siblings: SkillCard[];
}

function groupByWord(cards: readonly SkillCard[]): WordGroup[] {
  const byId = new Map<string, SkillCard[]>();
  for (const c of cards) {
    const list = byId.get(c.item.id) ?? [];
    if (!list.some((x) => x.skill === c.skill)) list.push(c);
    byId.set(c.item.id, list);
  }
  return [...byId.values()].map((list) => {
    const [card, ...siblings] = [...list].sort(
      (a, b) => compareOverdue(a, b) || Number(b.skill === 'production') - Number(a.skill === 'production'),
    );
    return { card: card!, siblings };
  });
}

/**
 * Phase 4 §6 session builder: new items first (the caller's allowance), fills the rest from due
 * review/mature cards, interleaves (a plain shuffle — "across topics and
 * exercise types" falls out naturally once rungs/words aren't grouped),
 * and resolves each item's cloze source (phase doc §2's priority order) so
 * the UI can show where it came from. Only word items are supported (no
 * grammar-pattern cloze yet); grammar cards in `dueCards` are skipped.
 *
 * Phase 37: one item per word (its recognition and production cards share it), and no sentence
 * twice in a session: a word whose only sentences are already used is left out.
 */
export function buildSession(dueCards: SkillCard[], options: BuildSessionOptions): OrderedSession<SessionItem> {
  // Phase 21: every random choice comes from the session seed, so a logged seed rebuilds it exactly.
  const rng = options.rng ?? (options.seed ? seededRng(`${options.seed}:pool`) : Math.random);
  const config = { ...DEFAULT_SESSION_CONFIG, ...options.config };

  // Phase 21: "New" is the shared definition (never answered); everything else is a due card.
  // Phase 37: a word counts as new only when all its cards here are new.
  const groups = groupByWord(dueCards.filter((c) => c.item.kind === 'word'));
  const isNewGroup = (g: WordGroup) => isNewCard(g.card) && g.siblings.every((c) => isNewCard(c));
  const newGroups = groups.filter(isNewGroup);
  const reviewGroups = groups.filter((g) => !isNewGroup(g));

  // Phase 5 gap capture: unreviewed words the learner needed mid-journal go
  // to the front of the new-item allowance, ahead of the shuffled rest.
  const isPriority = (g: WordGroup) => [g.card, ...g.siblings].some((c) => c.flags.priority === true);
  const byRank = (list: WordGroup[]): WordGroup[] => {
    const rank = options.rank;
    if (!rank) return list;
    return list
      .map((g, i) => ({ g, i, r: Math.min(...[g.card, ...g.siblings].map(rank)) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.g);
  };
  // Phase 29 Part B.4: the caller passes New cards already capped by the ledger's Cloze allowance.
  const orderedNew = [
    ...shuffle(newGroups.filter(isPriority), rng),
    ...byRank(
      shuffle(
        newGroups.filter((g) => !isPriority(g)),
        rng,
      ),
    ),
  ];
  const orderedReview = options.keepOrder ? reviewGroups : byRank(shuffle(reviewGroups, rng));

  const usedZh = new Set<string>();
  const skippedNoFreshSentence: string[] = [];
  const take = (list: WordGroup[], max: number): SessionItem[] => {
    const out: SessionItem[] = [];
    for (const g of list) {
      if (out.length >= max) break;
      const word = options.lexicon.byId(g.card.item.id);
      if (!word) continue; // stale/renamed id — skip rather than crash a whole session
      const source = selectClozeSource(word, { ...options, usedZh });
      if (!source && usedZh.size > 0 && selectClozeSource(word, options)) {
        skippedNoFreshSentence.push(word.id); // its only sentences are already in this session
        continue;
      }
      if (source) usedZh.add(source.zh.trim());
      out.push({
        card: g.card,
        ...(g.siblings.length ? { siblings: g.siblings } : {}),
        word,
        exerciseKind: exerciseKindForRung(g.card.clozeRung),
        source,
      });
    }
    return out;
  };
  const newItems = take(orderedNew, config.maxItems);
  const reviewItems = take(orderedReview, Math.max(0, config.maxItems - newItems.length));
  const items = shuffle([...newItems, ...reviewItems], rng);
  // Phase 19: the shared order (a word's items, e.g. an Again retry, never side by side).
  const ordered = orderSession(items, describeItem, { seed: seedFrom(options, rng), recent: options.recent });
  return withClozeMeta(ordered, { skippedNoFreshSentence });
}

export type ClozeEvidenceKind = 'cloze_correct_nohint' | 'cloze_correct_hint' | 'cloze_wrong';

/**
 * Phase 37: the evidence one cloze answer records: the shown card, then (with
 * `creditAllFacesOfWord`) each of the word's other cards in this session, same rating.
 */
export function clozeAnswerEvidence(
  item: Pick<SessionItem, 'card' | 'siblings'>,
  kind: ClozeEvidenceKind,
  at: Date,
  config: { creditAllFacesOfWord: boolean } = CLOZE_CONFIG,
): Evidence[] {
  const cards = [item.card, ...(config.creditAllFacesOfWord ? (item.siblings ?? []) : [])];
  return cards.map((c) => ({ item: c.item, skill: c.skill, kind, at }));
}

export type SessionEntry =
  { kind: 'card'; item: SessionItem } | { kind: 'error'; error: ErrorItem };

export interface BuildMixedSessionOptions extends BuildSessionOptions {
  errorItems: readonly ErrorItem[];
  now: Date;
  /** Phase 47 Part B: the ledger's comprehensible set; an error item whose answer has a word outside
   * it waits. Absent: every showable item (tests, tools). */
  known?: AnswerKnown;
}

/**
 * Phase 5 §7: the Phase 4 session plus due error-bank clozes. Phase 47 Part B.2: word clozes lead
 * and fill most of it; at most `maxErrorItems` journal fixes (recurring patterns picked first), one
 * per `wordsPerErrorItem` word clozes, spread out so two are never side by side.
 */
export function buildMixedSession(
  dueCards: SkillCard[],
  options: BuildMixedSessionOptions,
): OrderedSession<SessionEntry> {
  const rng = options.rng ?? (options.seed ? seededRng(`${options.seed}:mix`) : Math.random);
  const config = { ...DEFAULT_SESSION_CONFIG, ...options.config };
  const wanted = selectDueErrorItems(options.errorItems, options.now, config.maxErrorItems, options.known);
  const cards = buildSession(dueCards, {
    ...options,
    config: { ...options.config, maxItems: Math.max(0, config.maxItems - wanted.length) },
  });
  const room = Math.min(cards.length, Math.ceil(cards.length / Math.max(1, config.wordsPerErrorItem)));
  const errors = wanted.slice(0, room);

  const ordered = orderSession(
    cards.map((item) => ({ kind: 'card', item }) as SessionEntry),
    describeEntry,
    { seed: seedFrom(options, rng), recent: options.recent },
  );
  return withClozeMeta(spreadErrors(ordered, errors), clozeSessionMeta(cards) ?? { skippedNoFreshSentence: [] });
}

/** Phase 47 Part B.2: the journal fixes spread evenly after the first word cloze, never two in a row. */
function spreadErrors(ordered: OrderedSession<SessionEntry>, errors: readonly ErrorItem[]): OrderedSession<SessionEntry> {
  if (errors.length === 0) return ordered;
  const words = [...ordered];
  const out: SessionEntry[] = [];
  // fix k goes after word number ceil((k + 1) * n / (e + 1)): evenly spaced, each after at least one word
  const after = errors.map((_, k) => Math.max(k + 1, Math.ceil(((k + 1) * words.length) / (errors.length + 1))));
  let next = 0;
  words.forEach((w, i) => {
    out.push(w);
    while (next < errors.length && after[next] === i + 1) out.push({ kind: 'error', error: errors[next++]! });
  });
  const meta = sessionMeta(ordered);
  return meta ? markOrderedSession(out, meta) : (out as OrderedSession<SessionEntry>);
}

/** Phase 47 Part A.3: practice counting (Phase 45) for a cloze answer outside the review session.
 * Each of the word's cards gets a `review_*` with `context.practice` when this is its first counted
 * answer of the day (`counts`, the ledger's `practiceCounts`), else a `practice_*` that changes
 * nothing but Again's priority. */
export function clozePracticeEvidence(
  item: Pick<SessionItem, 'card' | 'siblings'>,
  kind: ClozeEvidenceKind,
  at: Date,
  counts: (card: Pick<SkillCard, 'item' | 'skill'>) => boolean,
  config: { creditAllFacesOfWord: boolean } = CLOZE_CONFIG,
): Evidence[] {
  const grade: PracticeGrade = kind === 'cloze_correct_nohint' ? 'good' : kind === 'cloze_correct_hint' ? 'hard' : 'again';
  const cards = [item.card, ...(config.creditAllFacesOfWord ? (item.siblings ?? []) : [])];
  return cards.map((c) => ({
    item: c.item,
    skill: c.skill,
    kind: practiceAnswerKind(grade, counts(c)),
    at,
    context: { source: 'cloze', practice: true },
  }));
}
