// Phase 18: Open chat. Word tiers (what the NPC may say), the topic word list,
// the validator profile and the wire shapes. Pure functions: no DOM, no fetch.
import { z } from 'zod';
import { LevelSchema } from './level-schema.js';
import { TurnHistoryEntrySchema } from './types.js';
import type { Lexicon } from '../lexicon.js';
import { levelIndex, type Level } from '../levels.config.js';
import { segment, type HintToken } from '../segment.js';
import { checkTaiwanness } from '../taiwanness.js';
import { courseOrdinal, LAIXUE_COURSE } from '../textbook/course.js';
import { derivedCompoundIds } from '../textbook/scope.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import type { StudyFocus } from '../study/study-focus.js';
import type { TurnResponse } from './types.js';
import { locateHints } from '../validate/turn.js';
import { glossFor } from '../gloss/context.js';
import {
  DEFAULT_TOPICS,
  OPEN_CHAT_CONFIG,
  type DefaultTopic,
  type OpenChatConfig,
} from './openChat.config.js';

// ---- wire shapes -----------------------------------------------------------

export const OpenChatTiersSchema = z.object({
  /** Headwords: known + upcoming (in-topic first, then a sample). */
  a: z.array(z.string()),
  /** Headwords of the current level that suit the topic. */
  b: z.array(z.string()),
  /** The few tier C words the NPC may introduce, glossed. */
  cAllowed: z.array(z.string()),
});
export type OpenChatTiers = z.infer<typeof OpenChatTiersSchema>;

/** POST /v1/turn with `mode: 'open'` (no scenario fields). */
export const OpenTurnRequestSchema = z.object({
  mode: z.literal('open'),
  topic: z.string().max(200),
  tiers: OpenChatTiersSchema,
  /** Running summary of the turns that are no longer sent. */
  summary: z.string().max(1500).optional(),
  /** Grammar patterns of the upcoming lessons ("V + 了"). */
  grammar: z.array(z.string()).optional(),
  /** The topic needs many tier C words: keep it simple, one new word per reply. */
  hardTopic: z.boolean().optional(),
  history: z.array(TurnHistoryEntrySchema),
  feedback: z.string().optional(),
  /** Phase 21: retry once on the other provider after repeated Taiwan / traditional failures. */
  alternateProvider: z.boolean().optional(),
  learnerLevel: LevelSchema,
  scaffolding: z.enum(['high', 'medium', 'low']),
  englishFallback: z.boolean(),
});
export type OpenTurnRequest = z.infer<typeof OpenTurnRequestSchema>;

export const TopicWordsRequestSchema = z.object({
  topic: z.string().min(1).max(200),
  level: LevelSchema,
});
export type TopicWordsRequest = z.infer<typeof TopicWordsRequestSchema>;

export const TopicWordsResponseSchema = z.object({ words: z.array(z.string()) });
export type TopicWordsResponse = z.infer<typeof TopicWordsResponseSchema>;

// ---- upcoming lessons --------------------------------------------------------

export interface MyClassPosition {
  enabled: boolean;
  textbookId: string;
  currentLesson: number;
}

export interface OpenChatProfile {
  lexicon: Pick<Lexicon, 'allWords' | 'byId' | 'lookup'> &
    Partial<Pick<Lexicon, 'grammarItemById'>>;
  /** The header level picker. */
  level: Level;
  /** Word ids with a card at state ≥ review. */
  knownIds: ReadonlySet<string>;
  /** Word ids whose recognition card is due now. */
  dueIds: ReadonlySet<string>;
  /** Word ids in `learning`/`introduced` state. */
  learningIds: ReadonlySet<string>;
  /** Imported textbooks, in course order. Empty = no textbook. */
  books: readonly Textbook[];
  /** Phase 14, when built and enabled. Phase 21: the only source of "upcoming" (it follows My class). */
  studyFocus?: StudyFocus;
}

export interface OpenChatTopic {
  /** What the learner typed or tapped. Empty = "Just chat". */
  text: string;
  /** Headwords from POST /v1/topic-words; absent until that call has returned. */
  words?: readonly string[];
}

export type UpcomingSource = 'study-order' | 'level-step' | 'none';

export interface UpcomingLesson {
  lessonId: string;
  bookId: string;
  n: number;
  topic: string;
  titleEn: string;
}

export interface Upcoming {
  source: UpcomingSource;
  lessons: UpcomingLesson[];
  wordIds: string[];
  grammarIds: string[];
}

const NONE: Upcoming = { source: 'none', lessons: [], wordIds: [], grammarIds: [] };

function lessonCore(l: Lesson): string[] {
  const proper = new Set(l.properNouns);
  return [...new Set([...l.vocab, ...(l.grammarWords ?? [])])].filter((id) => !proper.has(id));
}

function describe(l: Lesson, bookId: string): UpcomingLesson {
  return { lessonId: l.id, bookId, n: l.n, topic: l.topic, titleEn: l.titleEn };
}

function fromLessons(
  source: UpcomingSource,
  picked: Array<{ lesson: Lesson; bookId: string }>,
): Upcoming {
  return {
    source,
    lessons: picked.map((p) => describe(p.lesson, p.bookId)),
    wordIds: [...new Set(picked.flatMap((p) => lessonCore(p.lesson)))],
    grammarIds: [...new Set(picked.flatMap((p) => p.lesson.grammar))],
  };
}

/** Every lesson of the imported books, in course order. */
function lessonsInCourseOrder(
  books: readonly Textbook[],
): Array<{ lesson: Lesson; bookId: string; ordinal: number }> {
  const out: Array<{ lesson: Lesson; bookId: string; ordinal: number }> = [];
  for (const b of books) {
    for (const l of b.lessons) {
      const ordinal = courseOrdinal(LAIXUE_COURSE, b.id, l.n);
      if (ordinal !== undefined) out.push({ lesson: l, bookId: b.id, ordinal });
    }
  }
  return out.sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * The "next three lessons" of Part A.
 * - The active lesson plus the next two in study order. Phase 21: lessons already mastered or
 *   gated behind an unmastered TOCFL level are skipped (they don't use up a place). When the
 *   active step is "the rest of a TOCFL level", that level's unmastered words take the place of lessons.
 * - Study order off, or no textbook: nothing. Phase 21: priority never comes from My class
 *   directly; the study focus already follows the class.
 */
export function upcomingContent(
  profile: Pick<OpenChatProfile, 'books' | 'studyFocus'>,
  config: Pick<OpenChatConfig, 'upcomingLessons' | 'levelStepWordCap'> = OPEN_CHAT_CONFIG,
): Upcoming {
  if (profile.books.length === 0) return NONE;
  const ordered = lessonsInCourseOrder(profile.books);
  const focus = profile.studyFocus;
  if (!focus?.enabled || !focus.activeStep) return NONE;
  const step = focus.activeStep;
  if (step.kind === 'level') {
    const wordIds = focus.focusItems
      .filter((i) => i.kind === 'word')
      .map((i) => i.id)
      .slice(0, config.levelStepWordCap);
    return { source: 'level-step', lessons: [], wordIds, grammarIds: [] };
  }
  const at = ordered.findIndex((o) => o.lesson.id === step.lessonId);
  if (at < 0) return NONE;
  const skip = new Set([...(focus.gatedLessonIds ?? []), ...(focus.masteredLessonIds ?? [])]);
  const window = [
    ordered[at]!,
    ...ordered.slice(at + 1).filter((o) => !skip.has(o.lesson.id)),
  ].slice(0, config.upcomingLessons);
  return fromLessons('study-order', window);
}

// ---- tiers -------------------------------------------------------------------

export type OpenChatTier = 'A' | 'B' | 'C';

export interface OpenChatVocab {
  /** Word ids of tier A: known, due, learning + upcoming lessons (and their obvious compounds). */
  tierAIds: ReadonlySet<string>;
  /** Word ids of tier B: the picked level, not in A. */
  tierBIds: ReadonlySet<string>;
  upcoming: Upcoming;
  /** Word ids of the upcoming lessons' core words (⊆ tier A). */
  upcomingIds: ReadonlySet<string>;
  /** What goes into the prompt. */
  tiers: OpenChatTiers;
  /** Grammar patterns of the upcoming lessons. */
  grammar: string[];
  /** In-topic counts, for the chat header / dev drawer. */
  topicCounts: { a: number; b: number; c: number };
  hardTopic: boolean;
  /** Headwords the NPC is allowed to use as tier C this chat (⊆ topic words). */
  topicCWords: string[];
}

function sampleOf<T>(arr: readonly T[], n: number, rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

/** Particles, names and the like are never counted against a tier. */
export function isOpenChatAllowedWord(tags: readonly string[]): boolean {
  return tags.some((t) => t === 'name' || t === 'npc' || t === 'particle' || t === 'filler');
}

/**
 * Part A. `now` is accepted for contract symmetry (time is injected, never read);
 * the due set in `profile` is already computed for it by the caller.
 */
export function buildOpenChatVocab(
  profile: OpenChatProfile,
  topic: OpenChatTopic,
  _now: Date,
  config: OpenChatConfig = OPEN_CHAT_CONFIG,
  rng: () => number = Math.random,
): OpenChatVocab {
  void _now;
  const lex = profile.lexicon;
  const upcoming = upcomingContent(profile, config);
  const upcomingIds = new Set(upcoming.wordIds);

  const a = new Set<string>([
    ...profile.knownIds,
    ...profile.dueIds,
    ...profile.learningIds,
    ...upcomingIds,
  ]);
  // Obvious parts/compounds of the upcoming words are as good as the words themselves.
  if (upcomingIds.size > 0) {
    for (const id of derivedCompoundIds(lex, upcomingIds)) a.add(id);
  }

  const picked = levelIndex(profile.level);
  const b = new Set<string>();
  for (const w of lex.allWords()) {
    if (a.has(w.id) || w.source !== 'tocfl' || w.level === null) continue;
    const li = levelIndex(w.level);
    if (config.tierBIncludesLowerLevels ? li <= picked : li === picked) b.add(w.id);
  }

  const tierOfWord = (id: string): OpenChatTier => (a.has(id) ? 'A' : b.has(id) ? 'B' : 'C');
  const tierOfHeadword = (hw: string): OpenChatTier => {
    const cands = lex.lookup(hw);
    if (cands.length === 0) return 'C';
    const tiers = cands.map((w) => tierOfWord(w.id));
    return tiers.includes('A') ? 'A' : tiers.includes('B') ? 'B' : 'C';
  };

  const topicWords = [...new Set(topic.words ?? [])].filter(Boolean);
  const topicA: string[] = [];
  const topicB: string[] = [];
  const topicC: string[] = [];
  for (const hw of topicWords) {
    const t = tierOfHeadword(hw);
    (t === 'A' ? topicA : t === 'B' ? topicB : topicC).push(hw);
  }
  const topicSet = new Set(topicWords);

  // Other tier A words: due first, then upcoming-lesson words, then a random sample of the rest.
  const headwordOf = (id: string) => lex.byId(id)?.headword;
  const take = (ids: Iterable<string>) =>
    [...new Set([...ids].map(headwordOf).filter((h): h is string => !!h && !topicSet.has(h)))];
  const dueFirst = take([...profile.dueIds].filter((id) => a.has(id)));
  const upcomingNext = take(upcomingIds).filter((h) => !dueFirst.includes(h));
  const used = new Set([...dueFirst, ...upcomingNext]);
  const rest = take(a).filter((h) => !used.has(h));
  const others = [
    ...sampleOf(dueFirst, dueFirst.length, rng),
    ...sampleOf(upcomingNext, upcomingNext.length, rng),
    ...sampleOf(rest, rest.length, rng),
  ].slice(0, config.prompt.tierASample);

  const cAllowed = topicC.slice(0, config.prompt.tierCTopicMax);
  const grammar = upcoming.grammarIds
    .map((id) => lex.grammarItemById?.(id)?.pattern)
    .filter((p): p is string => !!p);

  return {
    tierAIds: a,
    tierBIds: b,
    upcoming,
    upcomingIds,
    tiers: {
      a: [...topicA.slice(0, config.prompt.tierATopicMax), ...others],
      b: topicB.slice(0, config.prompt.tierBTopicMax),
      cAllowed,
    },
    grammar,
    topicCounts: { a: topicA.length, b: topicB.length, c: topicC.length },
    hardTopic: topicC.length >= config.hardTopicTierCWords,
    topicCWords: topicC,
  };
}

// ---- chips -------------------------------------------------------------------

export interface TopicChip {
  id: string;
  label: string;
  /** The topic text sent to the model. */
  topic: string;
  source: 'lesson' | 'default';
}

/** "Occupations (I)" → "Occupations"; "Weather and seasons" stays. */
export function lessonThemeLabel(topic: string): string {
  return topic.replace(/\s*\((?:[IVX]+|\d+)\)\s*$/i, '').trim();
}

/**
 * Part B entry: 8 chips from the upcoming lessons' themes, filled with defaults that
 * suit the picked level (a default is hidden until the level reaches its `minLevel`).
 */
export function openChatChips(
  upcoming: Pick<Upcoming, 'lessons'>,
  level: Level,
  config: Pick<OpenChatConfig, 'chips'> = OPEN_CHAT_CONFIG,
  defaults: readonly DefaultTopic[] = DEFAULT_TOPICS,
): TopicChip[] {
  const chips: TopicChip[] = [];
  const seen = new Set<string>();
  const add = (c: TopicChip) => {
    const key = c.label.toLowerCase();
    if (seen.has(key) || chips.length >= config.chips.count) return;
    seen.add(key);
    chips.push(c);
  };
  for (const l of upcoming.lessons) {
    if (chips.filter((c) => c.source === 'lesson').length >= config.chips.maxFromLessons) break;
    const label = lessonThemeLabel(l.topic);
    if (label) add({ id: `lesson:${l.lessonId}`, label, topic: label, source: 'lesson' });
  }
  const picked = levelIndex(level);
  // Suitable topics, those nearest the picked level first (a higher level sees "Work" and
  // "The news" before "The weather"); the original order breaks ties.
  const suitable = defaults
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => levelIndex(d.minLevel) <= picked)
    .sort((x, y) => levelIndex(y.d.minLevel) - levelIndex(x.d.minLevel) || x.i - y.i);
  for (const { d } of suitable)
    add({ id: `default:${d.id}`, label: d.label, topic: d.topic, source: 'default' });
  return chips;
}

// ---- validation (Part C) -------------------------------------------------------

export interface OpenChatContext {
  vocab: Pick<OpenChatVocab, 'tierAIds' | 'tierBIds'>;
  lexicon: Lexicon;
  /** Token texts the learner typed in this chat: always allowed. */
  typedTexts?: ReadonlySet<string>;
  /** Item ids of upcoming-lesson words (for the "uses an upcoming word" stat). */
  upcomingIds?: ReadonlySet<string>;
}

export interface OpenChatToken {
  text: string;
  tier: OpenChatTier | 'allowed';
  wordId?: string;
}

export interface OpenChatReport {
  pass: boolean;
  /** Content tokens = everything except `allowed`. */
  contentTokens: number;
  counts: { a: number; b: number; c: number; allowed: number };
  shareA: number;
  /** Tokens of tier B / C, for feedback and inline glosses. */
  offendersB: OpenChatToken[];
  offendersC: OpenChatToken[];
  usesUpcoming: boolean;
  taiwanness: ReturnType<typeof checkTaiwanness>;
  /** Which limits failed. */
  failed: Array<'tierA' | 'tierB' | 'tierC' | 'taiwanness'>;
  tokens: OpenChatToken[];
}

/** Classifies each content token as tier A, B or C (plus `allowed`). */
export function analyzeOpenChatText(
  text: string,
  ctx: OpenChatContext,
  hints: HintToken[] = [],
  limits: OpenChatConfig['limits'] = OPEN_CHAT_CONFIG.limits,
): OpenChatReport {
  const toks = segment(text, ctx.lexicon, { hints });
  const tokens: OpenChatToken[] = [];
  let usesUpcoming = false;
  for (const t of toks) {
    if (t.kind !== 'word' && t.kind !== 'unknown') continue; // numbers, latin, punctuation
    if (ctx.typedTexts?.has(t.text)) {
      tokens.push({ text: t.text, tier: 'allowed' });
      continue;
    }
    if (t.kind === 'unknown') {
      tokens.push({ text: t.text, tier: 'C' });
      continue;
    }
    const cands = ctx.lexicon.lookup(t.text);
    if (cands.length === 0) {
      tokens.push({ text: t.text, tier: 'C' });
      continue;
    }
    if (cands.some((w) => isOpenChatAllowedWord(w.tags))) {
      tokens.push({ text: t.text, tier: 'allowed', wordId: cands[0]!.id });
      continue;
    }
    const inA = cands.find((w) => ctx.vocab.tierAIds.has(w.id));
    const inB = cands.find((w) => ctx.vocab.tierBIds.has(w.id));
    const chosen = inA ?? inB ?? cands[0]!;
    if (inA && ctx.upcomingIds?.has(inA.id)) usesUpcoming = true;
    tokens.push({ text: t.text, tier: inA ? 'A' : inB ? 'B' : 'C', wordId: chosen.id });
  }

  const counts = { a: 0, b: 0, c: 0, allowed: 0 };
  for (const t of tokens) {
    if (t.tier === 'A') counts.a++;
    else if (t.tier === 'B') counts.b++;
    else if (t.tier === 'C') counts.c++;
    else counts.allowed++;
  }
  const contentTokens = counts.a + counts.b + counts.c;
  const shareA = contentTokens === 0 ? 1 : counts.a / contentTokens;
  const taiwanness = checkTaiwanness(text);
  const failed: OpenChatReport['failed'] = [];
  if (shareA < limits.tierAMinShare) failed.push('tierA');
  if (counts.b > limits.tierBMaxTokens) failed.push('tierB');
  if (counts.c > limits.tierCMaxTokens) failed.push('tierC');
  if (!taiwanness.isClean) failed.push('taiwanness');

  return {
    pass: failed.length === 0,
    contentTokens,
    counts,
    shareA,
    offendersB: tokens.filter((t) => t.tier === 'B'),
    offendersC: tokens.filter((t) => t.tier === 'C'),
    usesUpcoming,
    taiwanness,
    failed,
    tokens,
  };
}

/** Validates a TurnResponse's reply_zh (its own `tokens` are segmentation hints). */
export function validateOpenChatTurn(
  response: Pick<TurnResponse, 'reply_zh' | 'tokens'>,
  ctx: OpenChatContext,
  limits: OpenChatConfig['limits'] = OPEN_CHAT_CONFIG.limits,
): OpenChatReport {
  const hints = locateHints(
    response.reply_zh,
    response.tokens.map((t) => t.text),
  );
  return analyzeOpenChatText(response.reply_zh, ctx, hints, limits);
}

/** Regeneration feedback naming the offending words (Phase 3 flow). */
export function openChatFeedback(
  report: OpenChatReport,
  limits: OpenChatConfig['limits'] = OPEN_CHAT_CONFIG.limits,
): string {
  const names = (ts: OpenChatToken[]) => [...new Set(ts.map((t) => t.text))].slice(0, 8).join('、');
  const parts: string[] = [];
  if (report.failed.includes('tierC'))
    parts.push(
      `These words are too hard (tier C, at most ${limits.tierCMaxTokens} per reply): ${names(report.offendersC)}.`,
    );
  if (report.failed.includes('tierB') || report.failed.includes('tierA'))
    parts.push(
      `Too many words outside the learner's known list (tier A is ${(report.shareA * 100).toFixed(0)}%, need ${(limits.tierAMinShare * 100).toFixed(0)}%; at most ${limits.tierBMaxTokens} tier B words): ${names([...report.offendersB, ...report.offendersC])}.`,
    );
  if (report.failed.includes('taiwanness'))
    parts.push('Use Taiwan Mandarin and traditional characters only.');
  parts.push(
    'Say it again with simpler words from the tier A list (or tier B sparingly); keep it to 1–2 short sentences and keep the conversation going with a question.',
  );
  return parts.join(' ');
}

/** Of several attempts, the one that breaks the fewest limits (then the highest tier A share). */
export function pickBestOpenChatAttempt<T extends { report: OpenChatReport }>(attempts: readonly T[]): T {
  return [...attempts].sort(
    (x, y) =>
      Number(y.report.pass) - Number(x.report.pass) ||
      x.report.failed.length - y.report.failed.length ||
      y.report.shareA - x.report.shareA,
  )[0]!;
}

/** Inline glosses for the tier B/C words of an accepted reply (English from the lexicon). */
export function openChatGlosses(
  report: Pick<OpenChatReport, 'offendersB' | 'offendersC'>,
  lexicon: Pick<Lexicon, 'byId'>,
): Array<{ text: string; gloss: string }> {
  const seen = new Set<string>();
  const out: Array<{ text: string; gloss: string }> = [];
  for (const t of [...report.offendersC, ...report.offendersB]) {
    if (seen.has(t.text) || !t.wordId) continue;
    const w = lexicon.byId(t.wordId);
    // Phase 21: the one gloss rule (open chat is not textbook content).
    const gloss = w ? glossFor(w, { textbook: false }) : '';
    if (!gloss) continue;
    seen.add(t.text);
    out.push({ text: t.text, gloss });
  }
  return out;
}

/** Share of word tokens across NPC turns that were tier A, for the end-of-chat summary. */
export function openChatTierMix(
  reports: ReadonlyArray<{ a: number; b: number; c: number }>,
): { shareA: number; turns: number } {
  let a = 0;
  let total = 0;
  for (const r of reports) {
    a += r.a;
    total += r.a + r.b + r.c;
  }
  return { shareA: total === 0 ? 1 : a / total, turns: reports.length };
}

/** Last N turns (what is sent) and the older ones (what the running summary stands in for). */
export function openChatHistoryWindow<T>(
  turns: readonly T[],
  config: Pick<OpenChatConfig, 'history'> = OPEN_CHAT_CONFIG,
): { recent: T[]; dropped: T[] } {
  const n = config.history.recentTurns;
  return { recent: turns.slice(-n), dropped: turns.slice(0, Math.max(0, turns.length - n)) };
}

export function openChatSummaryDue(
  turnCount: number,
  summarizedUpTo: number,
  config: Pick<OpenChatConfig, 'history'> = OPEN_CHAT_CONFIG,
): boolean {
  return (
    turnCount > config.history.recentTurns &&
    turnCount - summarizedUpTo >= config.history.summaryEveryTurns
  );
}

/**
 * The running summary is built locally (no extra model call on the free tier): a short
 * digest of what the learner said and what 安安 asked, newest last, capped in length.
 * `summary` covers every turn before `fromIndex`; call it with the turns since then.
 */
export function summarizeOpenChat(
  previous: string | undefined,
  turns: ReadonlyArray<{ role: 'npc' | 'learner'; zh: string }>,
  maxChars: number = OPEN_CHAT_CONFIG.history.summaryMaxChars,
): string {
  const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
  const lines = turns.map((t) =>
    t.role === 'learner' ? `Learner: ${clip(t.zh, 40)}` : `安安: ${clip(t.zh, 30)}`,
  );
  const joined = [previous, ...lines].filter(Boolean).join(' / ');
  return joined.length <= maxChars ? joined : `…${joined.slice(joined.length - maxChars + 1)}`;
}
