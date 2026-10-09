// Phase 24: graded stories. The budget per difficulty, the prompt word lists, the validator (rung
// shares, Taiwan / traditional, length), regeneration feedback, comprehension-question checks and
// the library helpers. Pure: no fetch, no storage; time is injected.

import type { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import type { Level } from '../levels.config.js';
import { segment } from '../segment.js';
import { checkTaiwanness, type TaiwannessResult } from '../taiwanness.js';
import { glossFor } from '../gloss/context.js';
import { hashText } from '../hash.js';
import { isOpenChatAllowedWord } from '../chat/openChat.js';
import { bestRung, type VocabLadder, type VocabRung } from '../progress/vocabLadder.js';
import { STORY_BUDGETS, STORY_CONFIG, type RungBudget, type StoryDifficulty } from './stories.config.js';
import type {
  StoryCheckRequest,
  StoryCheckResponse,
  StoryQuestion,
  StoryRepairRequest,
  StoryRepairResponse,
  StoryRequest,
  StoryResponse,
} from './types.js';
import type { ProviderName } from '../journal/types.js';

export * from './stories.config.js';
export * from './types.js';

export const storyBudget = (d: StoryDifficulty = 'middle'): RungBudget => STORY_BUDGETS[d];
export const storyLength = (level: Level): { min: number; max: number } => STORY_CONFIG.length[level];

/** Han characters in a text (what "You read 214 characters" counts). */
export const hanCount = (text: string): number => [...text].filter((c) => /\p{Script=Han}/u.test(c)).length;

/** Sentences of a paragraph (kept with their end punctuation). */
export function storySentences(paragraph: string): string[] {
  return paragraph.match(/[^。！？!?]+[。！？!?」』”]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

// ---------------------------------------------------------------------------------------------
// The prompt's word lists

export interface StoryPromptInput {
  ladder: VocabLadder;
  lexicon: Pick<Lexicon, 'byId'>;
  /** Due now: they lead rung 1 after the topic words (reading them is review). */
  dueIds?: ReadonlySet<string>;
  /** Recently learned word ids, newest first. */
  recentIds?: readonly string[];
  /** For the rest of rung 1. */
  rng?: () => number;
  /** Phase 26: the story's topic and the topic's words (Phase 18's cached list): matching words go first. */
  topic?: string;
  topicWords?: readonly string[];
}

/** Phase 26: the groups the prompt shows (rung 2 first, then rung 1 by kind). */
export const STORY_WORD_GROUPS = ['people', 'places', 'food', 'time', 'verbs', 'adjectives', 'measure words', 'things', 'other'] as const;
export type StoryWordGroup = (typeof STORY_WORD_GROUPS)[number];

const GROUP_GLOSS: Array<[StoryWordGroup, RegExp]> = [
  ['people', /\b(person|people|friends?|teachers?|students?|mother|father|mom|dad|brothers?|sisters?|child|children|son|daughter|husband|wife|man|woman|boy|girl|classmates?|doctor|boss|colleague|grand\w*|uncle|aunt|baby|family|guests?|customers?|waiter|clerk|driver|everyone|somebody|someone)\b/i],
  ['food', /\b(food|tea|coffee|rice|noodles?|meat|beef|pork|chicken|fish|fruits?|vegetables?|soup|dumplings?|bread|cake|milk|juice|water|beer|wine|breakfast|lunch|dinner|meal|snacks?|eggs?|tofu|apples?|bananas?|sugar|dessert|menu|dish)\b/i],
  ['time', /\b(day|days|week|month|year|time|morning|afternoon|evening|night|noon|o'clock|today|tomorrow|yesterday|hours?|minutes?|now|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|spring|summer|autumn|winter|birthday|holiday)\b/i],
  ['places', /\b(place|stores?|shops?|station|park|school|restaurant|room|home|house|city|country|market|street|road|office|hospital|library|bank|hotel|airport|bathroom|toilet|kitchen|classroom|building|mountain|beach|sea|river|temple|museum|company|supermarket|cafe|outside|inside|here|there|nearby|side)\b/i],
];

/** Phase 26: the group a word is listed under in the prompt (and its swaps come from). */
export function storyWordGroup(w: Pick<Word, 'pos' | 'glossEn'>): StoryWordGroup {
  const pos = w.pos ?? [];
  if (pos.includes('M')) return 'measure words';
  const noun = pos.length === 0 || pos.some((p) => p === 'N' || p === 'Nb');
  if (noun) for (const [g, re] of GROUP_GLOSS) if (re.test(w.glossEn)) return g;
  if (pos.some((p) => p === 'N' || p === 'Nb')) return 'things';
  if (pos.some((p) => p === 'Vs' || p === 'Vs-attr' || p === 'Vs-pred' || p === 'Vs-sep')) return 'adjectives';
  if (pos.some((p) => p.startsWith('V'))) return 'verbs';
  return 'other';
}

const TOPIC_STOP = new Set(['the', 'and', 'for', 'with', 'about', 'what', 'from', 'lesson', 'your', 'you', 'are', 'how', 'this', 'that', 'some', 'day']);
/** Topic words for gloss matching, with a plain stem too ("eating" → "eat", "markets" → "market"). */
const topicTerms = (topic: string): Set<string> => {
  const out = new Set<string>();
  for (const x of topic.toLowerCase().split(/[^a-z]+/)) {
    if (x.length <= 2 || TOPIC_STOP.has(x)) continue;
    out.add(x);
    const stem = x.replace(/(ing|es|s)$/, '');
    if (stem.length > 2) out.add(stem);
  }
  return out;
};

/** A short English gloss for a word list (first sense, no brackets). */
export const shortGloss = (w: Parameters<typeof glossFor>[0]): string =>
  (glossFor(w, { textbook: true }).split(/[;,(]/)[0] ?? '').trim().slice(0, 40);

/**
 * Phase 26 Part A3: the prompt's word lists. Rung 1 is topic words first, then due and recent words,
 * then the rest, at most `promptRung1Max`; rung 5 only when it matches the topic; rungs 1–2 also come
 * grouped with glosses (this lesson first, then people, places, food, time, verbs…).
 */
export function storyPromptLists(input: StoryPromptInput): { rungs: StoryRequest['rungs']; groups: NonNullable<StoryRequest['groups']> } {
  const lex = input.lexicon;
  const terms = topicTerms(input.topic ?? '');
  const topicWords = new Set(input.topicWords ?? []);
  const onTopic = (id: string): boolean => {
    const w = lex.byId(id);
    if (!w) return false;
    if (topicWords.has(w.headword)) return true;
    if (terms.size === 0) return false;
    return glossFor(w, { textbook: true })
      .toLowerCase()
      .split(/[^a-z]+/)
      .some((x) => terms.has(x));
  };
  const uniqueHeadwords = (ids: Iterable<string>) => {
    const out: Word[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const w = lex.byId(id);
      if (w && !seen.has(w.headword)) {
        seen.add(w.headword);
        out.push(w);
      }
    }
    return out;
  };
  const r1 = input.ladder.ids[1];
  const rng = input.rng ?? Math.random;
  const topical = [...r1].filter(onTopic);
  const lead = [...(input.dueIds ?? [])].filter((id) => r1.has(id));
  const recent = (input.recentIds ?? []).filter((id) => r1.has(id));
  const first = new Set([...topical, ...lead, ...recent]);
  const rest = shuffle([...r1].filter((id) => !first.has(id)), rng);
  const r1Words = uniqueHeadwords([...topical, ...lead, ...recent, ...rest]).slice(0, STORY_CONFIG.promptRung1Max);
  const r2Words = uniqueHeadwords(input.ladder.ids[2]);
  const r5Words = uniqueHeadwords([...input.ladder.ids[5]].filter(onTopic)).slice(0, STORY_CONFIG.promptRung5Max);
  const item = (w: Word) => ({ zh: w.headword, en: shortGloss(w) });
  const groups: NonNullable<StoryRequest['groups']> = [];
  if (r2Words.length) groups.push({ label: 'this lesson', words: r2Words.map(item) });
  for (const g of STORY_WORD_GROUPS) {
    const words = r1Words.filter((w) => storyWordGroup(w) === g).map(item);
    if (words.length) groups.push({ label: g, words });
  }
  return {
    rungs: {
      r1: r1Words.map((w) => w.headword),
      r2: r2Words.map((w) => w.headword),
      r3: uniqueHeadwords(input.ladder.ids[3]).map((w) => w.headword),
      r4: uniqueHeadwords(input.ladder.ids[4]).map((w) => w.headword),
      r5: r5Words.map((w) => w.headword),
    },
    groups,
  };
}

/** Headwords per rung for the prompt (see `storyPromptLists`). */
export function storyPromptRungs(input: StoryPromptInput): StoryRequest['rungs'] {
  return storyPromptLists(input).rungs;
}

function shuffle<T>(a: T[], rng: () => number): T[] {
  const c = [...a];
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [c[i], c[j]] = [c[j]!, c[i]!];
  }
  return c;
}

/** The budget as the prompt states it (Easier asks for no rung 4–5 words at all). */
export const promptBudget = (b: RungBudget): StoryRequest['budget'] => ({
  rung1Share: b.targetRung1Share,
  rung3: b.maxRung3Words,
  rung4: b.maxRung4Words,
  rung5: b.maxRung5Words,
});

/** Stable key of a story request (feedback left out): the same request is never paid for twice. */
export function storyRequestKey(req: Omit<StoryRequest, 'feedback'> & { difficulty?: StoryDifficulty; seriesId?: string; variant?: number }): string {
  const { rungs, ...rest } = req as StoryRequest & { difficulty?: StoryDifficulty };
  const norm = JSON.stringify({
    ...rest,
    feedback: undefined,
    fresh: undefined,
    rungs: { r1: [...rungs.r1].sort(), r2: [...rungs.r2].sort(), r3: [...rungs.r3].sort(), r4: [...rungs.r4].sort(), r5: [...rungs.r5].sort() },
  });
  return `story-${hashText(norm)}`;
}

// ---------------------------------------------------------------------------------------------
// Validation

export interface StoryToken {
  text: string;
  /** 'allowed': names, particles, numbers, punctuation (never counted). */
  rung: VocabRung | 'allowed';
  wordId?: string;
  /** Rung 6 word the story glosses inline. */
  glossed?: boolean;
}

export interface StoryContext {
  ladder: Pick<VocabLadder, 'rung'>;
  lexicon: Lexicon;
  /** Names the learner has met, the story's characters: always allowed. */
  allowedTexts?: ReadonlySet<string>;
  /** Words the story glosses inline (rung 6 only allowed so). */
  glossed?: ReadonlySet<string>;
}

export type StoryFailure = 'rung1' | 'rung3' | 'rung4' | 'rung5' | 'rung6' | 'taiwanness' | 'length' | 'questions';

export interface StoryReport {
  pass: boolean;
  failed: StoryFailure[];
  /** Tokens per paragraph. */
  paragraphs: StoryToken[][];
  contentTokens: number;
  rung1Share: number;
  /** Phase 25/26: known or this lesson (rungs 1–2), the share the mini-lesson floor uses. */
  knownShare: number;
  /** Content tokens per rung. */
  counts: Record<VocabRung, number>;
  /** Distinct words per rung (word id, or the text for words outside the lexicon). */
  distinct: Record<VocabRung, string[]>;
  chars: number;
  /** Phase 25: shorter than the target but long enough to show (regenerate once, then accept). */
  short?: boolean;
  /** Sentences with simplified characters or mainland terms. */
  taiwanness: { sentence: string; result: TaiwannessResult }[];
}

const RUNGS: VocabRung[] = [1, 2, 3, 4, 5, 6];

/** Segments a paragraph, keeping each allowed name (小美, 王先生) whole even when the lexicon would split it. */
export function segmentWithNames(
  text: string,
  lexicon: Lexicon,
  names?: ReadonlySet<string>,
): Array<{ kind: string; text: string }> {
  const list = [...(names ?? [])].filter((n) => n.length > 1).sort((a, b) => b.length - a.length);
  if (list.length === 0) return segment(text, lexicon);
  const out: Array<{ kind: string; text: string }> = [];
  let rest = '';
  for (let i = 0; i < text.length; ) {
    const hit = list.find((n) => text.startsWith(n, i));
    if (hit) {
      if (rest) out.push(...segment(rest, lexicon));
      rest = '';
      out.push({ kind: 'word', text: hit });
      i += hit.length;
    } else {
      rest += text[i];
      i++;
    }
  }
  if (rest) out.push(...segment(rest, lexicon));
  return out;
}

/** Names a story may use freely: the learner's known names, plus the story's own characters when
 * they are not ordinary words (a model can't make 咖啡 "a character" to dodge the shares). */
export function storyAllowedNames(names: readonly string[], characters: readonly string[], lexicon: Pick<Lexicon, 'lookup'>): Set<string> {
  const out = new Set(names.map((n) => n.trim()).filter(Boolean));
  for (const c of characters.map((x) => x.trim())) {
    if (!c || /[^\p{Script=Han}·]/u.test(c) || c.length > 4) continue;
    const words = lexicon.lookup(c);
    if (words.length === 0 || words.every((w) => isOpenChatAllowedWord(w.tags))) out.add(c);
  }
  return out;
}

type RungOf = (text: string) => { rung: VocabRung | 'allowed'; id?: string };

/**
 * Phase 25: the rung of a piece of story text. Names and particles are 'allowed'; a lexicon word
 * takes its best ladder rung; a word on no rung that splits into ladder words takes the highest
 * rung of its parts (不是 = 不 + 是, 好吃 = 好 + 吃), so a compound of known words is not "unknown".
 */
function storyRungOf(ctx: StoryContext): RungOf {
  const memo = new Map<string, ReturnType<RungOf>>();
  const of: RungOf = (text) => {
    const hit = memo.get(text);
    if (hit) return hit;
    let res: ReturnType<RungOf>;
    if (ctx.allowedTexts?.has(text)) res = { rung: 'allowed' };
    else {
      const cands = ctx.lexicon.lookup(text);
      if (cands.some((w) => isOpenChatAllowedWord(w.tags))) res = { rung: 'allowed', id: cands[0]!.id };
      else {
        res = bestRung(ctx.ladder, cands.map((w) => w.id));
        if (res.rung === 6 && [...text].length > 1) {
          const split = splitRung(text, of);
          if (split !== undefined && split < 6) res = { rung: split, ...(res.id ? { id: res.id } : {}) };
        }
      }
    }
    memo.set(text, res);
    return res;
  };
  return of;
}

/** The lowest "highest rung" over the ways `text` splits into two or more ladder pieces. */
function splitRung(text: string, of: RungOf): VocabRung | undefined {
  const chars = [...text];
  let best: VocabRung | undefined;
  for (let i = 1; i < chars.length; i++) {
    const head = of(chars.slice(0, i).join(''));
    const tailText = chars.slice(i).join('');
    const tail = of(tailText);
    const hr = head.rung === 'allowed' ? 1 : head.rung;
    const tr = tail.rung === 'allowed' ? 1 : tail.rung;
    if (hr === 6 || tr === 6) continue;
    const r = Math.max(hr, tr) as VocabRung;
    if (best === undefined || r < best) best = r;
  }
  return best;
}

/**
 * Phase 25: the segmenter's longest-match can split a story wrongly (做工作 → 做工 + 作). Each run of
 * Chinese words is re-split to put as few words as possible on rung 6, then use as few words as possible.
 */
function resegmentStory(
  tokens: Array<{ kind: string; text: string }>,
  ctx: StoryContext,
  of: RungOf,
): Array<{ kind: string; text: string }> {
  const out: Array<{ kind: string; text: string }> = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(...bestSplit(run.join(''), ctx.lexicon, of));
    run = [];
  };
  for (const t of tokens) {
    const isRun = (t.kind === 'word' || t.kind === 'unknown') && !ctx.allowedTexts?.has(t.text) && /^\p{Script=Han}+$/u.test(t.text);
    if (isRun) run.push(t.text);
    else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out;
}

function bestSplit(text: string, lexicon: Lexicon, of: RungOf): Array<{ kind: string; text: string }> {
  const chars = [...text];
  const n = chars.length;
  const max = Math.max(1, lexicon.maxHeadwordLength);
  // cost[i] = best [rung-6 words, words] for chars[i..]
  const cost: Array<[number, number]> = new Array(n + 1);
  const cut: number[] = new Array(n + 1);
  cost[n] = [0, 0];
  for (let i = n - 1; i >= 0; i--) {
    let best: [number, number] | undefined;
    for (let l = Math.min(max, n - i); l >= 1; l--) {
      const piece = chars.slice(i, i + l).join('');
      if (l > 1 && lexicon.lookup(piece).length === 0) continue;
      const r = of(piece).rung;
      const rest = cost[i + l]!;
      const c: [number, number] = [rest[0] + (r === 6 ? 1 : 0), rest[1] + 1];
      if (!best || c[0] < best[0] || (c[0] === best[0] && c[1] < best[1])) {
        best = c;
        cut[i] = l;
      }
    }
    cost[i] = best!;
  }
  const res: Array<{ kind: string; text: string }> = [];
  for (let i = 0; i < n; i += cut[i]!) {
    const piece = chars.slice(i, i + cut[i]!).join('');
    res.push({ kind: lexicon.lookup(piece).length > 0 ? 'word' : 'unknown', text: piece });
  }
  return res;
}

/** Classifies every token of the story and checks Part A's shares, Taiwan / traditional and length. */
export function analyzeStory(
  paragraphs: readonly string[],
  ctx: StoryContext,
  budget: RungBudget = storyBudget('middle'),
  length?: { min: number; max: number },
): StoryReport {
  const out: StoryToken[][] = [];
  const rungOf = storyRungOf(ctx);
  for (const p of paragraphs) {
    const toks: StoryToken[] = [];
    for (const t of resegmentStory(segmentWithNames(p, ctx.lexicon, ctx.allowedTexts), ctx, rungOf)) {
      if (t.kind !== 'word' && t.kind !== 'unknown') continue; // numbers, latin, punctuation
      const best = rungOf(t.text);
      if (best.rung === 'allowed') {
        toks.push({ text: t.text, rung: 'allowed', ...(best.id ? { wordId: best.id } : {}) });
        continue;
      }
      const tok: StoryToken = { text: t.text, rung: best.rung, ...(best.id ? { wordId: best.id } : {}) };
      if (best.rung === 6 && ctx.glossed?.has(t.text)) tok.glossed = true;
      toks.push(tok);
    }
    out.push(toks);
  }
  const all = out.flat();
  const counts = Object.fromEntries(RUNGS.map((r) => [r, 0])) as Record<VocabRung, number>;
  const distinctSets = Object.fromEntries(RUNGS.map((r) => [r, new Set<string>()])) as Record<VocabRung, Set<string>>;
  for (const t of all) {
    if (t.rung === 'allowed') continue;
    counts[t.rung]++;
    distinctSets[t.rung].add(t.wordId ?? t.text);
  }
  const distinct = Object.fromEntries(RUNGS.map((r) => [r, [...distinctSets[r]]])) as Record<VocabRung, string[]>;
  const contentTokens = RUNGS.reduce((n, r) => n + counts[r], 0);
  // Phase 25: a glossed word is explained where it stands, so it does not count against the share
  // (the rung 6 limit still caps how many there are).
  const glossedTokens = all.filter((t) => t.glossed).length;
  const shareBase = contentTokens - glossedTokens;
  const rung1Share = shareBase <= 0 ? 1 : counts[1] / shareBase;
  const knownShare = shareBase <= 0 ? 1 : (counts[1] + counts[2]) / shareBase;
  const chars = paragraphs.reduce((n, p) => n + hanCount(p), 0);

  const taiwanness = paragraphs
    .flatMap(storySentences)
    .map((sentence) => ({ sentence, result: checkTaiwanness(sentence) }))
    .filter((x) => !x.result.isClean);

  const failed: StoryFailure[] = [];
  let short = false;
  // Phase 26 A1: this lesson's words (rung 2) count as known: the prompt asks for them by name.
  if (knownShare < budget.minRung1Share) failed.push('rung1');
  if (distinct[3].length > budget.maxRung3Words) failed.push('rung3');
  if (distinct[4].length > budget.maxRung4Words) failed.push('rung4');
  if (distinct[5].length > budget.maxRung5Words) failed.push('rung5');
  const unglossed6 = all.filter((t) => t.rung === 6 && !t.glossed);
  if (unglossed6.length > 0 || distinct[6].length > budget.maxRung6Glossed) failed.push('rung6');
  if (taiwanness.length > 0) failed.push('taiwanness');
  if (length) {
    const slack = STORY_CONFIG.lengthSlack;
    if (chars < length.min * STORY_CONFIG.minLengthShare || chars > length.max * (1 + slack)) failed.push('length');
    else if (chars < length.min * (1 - slack)) short = true;
  }
  return {
    pass: failed.length === 0,
    failed,
    paragraphs: out,
    contentTokens,
    rung1Share,
    knownShare,
    counts,
    distinct,
    chars,
    ...(short ? { short } : {}),
    taiwanness,
  };
}

/** Rung 1 words that could stand in for an over-budget word (a shared English gloss word). */
export function simplerSwaps(
  wordId: string,
  ladder: Pick<VocabLadder, 'ids'>,
  lexicon: Pick<Lexicon, 'byId'>,
  max = 2,
): string[] {
  const w = lexicon.byId(wordId);
  if (!w) return [];
  const STOP = new Set(['to', 'a', 'an', 'the', 'of', 'be', 'one', 'in', 'on', 'for', 'and', 'or', 'sb', 'sth']);
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).filter((x) => x.length > 2 && !STOP.has(x)));
  const mine = words(glossFor(w, { textbook: false }));
  if (mine.size === 0) return [];
  const out: string[] = [];
  for (const id of ladder.ids[1]) {
    const o = lexicon.byId(id);
    if (!o || o.headword === w.headword) continue;
    if ([...words(glossFor(o, { textbook: false }))].some((x) => mine.has(x))) out.push(o.headword);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Phase 26: rung 1 words to suggest for an over-budget word: ones sharing a gloss word
 * (`simplerSwaps`), then ones from the same group (a place for a place: 公園 → 外面 / 那裡).
 */
export function storySwaps(
  word: { wordId?: string; text: string },
  ladder: Pick<VocabLadder, 'ids'>,
  lexicon: Pick<Lexicon, 'byId'>,
  max = 3,
): string[] {
  const out = word.wordId ? simplerSwaps(word.wordId, ladder, lexicon, max) : [];
  const w = word.wordId ? lexicon.byId(word.wordId) : undefined;
  const g = w ? storyWordGroup(w) : undefined;
  if (g && ['people', 'places', 'food', 'time'].includes(g))
    for (const id of ladder.ids[1]) {
      if (out.length >= max) break;
      const o = lexicon.byId(id);
      if (o && o.headword !== word.text && !out.includes(o.headword) && storyWordGroup(o) === g) out.push(o.headword);
    }
  return out.slice(0, max);
}

/** Phase 26 Part B: a word that cost the known share or broke a limit. */
export interface StoryProblemWord {
  text: string;
  wordId?: string;
  rung: VocabRung;
  why: string;
}

const RUNG_NAME: Record<number, string> = { 2: 'this lesson', 3: 'next lesson', 4: 'the lesson after', 5: 'your level', 6: 'in none of your lists' };

/**
 * Every word to change, in reading order: when the known share is too low, every word from rungs 3–6;
 * otherwise the words over each rung's limit (the first ones up to the limit stay) and rung 6 words.
 */
export function storyProblemWords(report: StoryReport, budget: RungBudget): StoryProblemWord[] {
  const seen = new Map<string, StoryProblemWord>();
  const lowShare = report.failed.includes('rung1');
  const limit: Record<number, number> = { 3: budget.maxRung3Words, 4: budget.maxRung4Words, 5: budget.maxRung5Words };
  const kept: Record<number, Set<string>> = { 3: new Set(), 4: new Set(), 5: new Set() };
  for (const t of report.paragraphs.flat()) {
    if (t.rung === 'allowed' || t.rung === 1 || t.rung === 2 || seen.has(t.text)) continue;
    const key = t.wordId ?? t.text;
    let why: string | undefined;
    if (t.rung === 6) {
      if (report.failed.includes('rung6') || lowShare) why = 'in none of your lists';
    } else if (lowShare) why = `${RUNG_NAME[t.rung]} word: too many words outside the known list`;
    else if (kept[t.rung]!.has(key)) continue;
    else if (kept[t.rung]!.size < limit[t.rung]!) {
      kept[t.rung]!.add(key);
      continue;
    } else why = `${RUNG_NAME[t.rung]} word over the limit of ${limit[t.rung]}`;
    if (!why) continue;
    seen.set(t.text, { text: t.text, ...(t.wordId ? { wordId: t.wordId } : {}), rung: t.rung, why });
  }
  return [...seen.values()];
}

/** Phase 26 A4: words from rungs 3–6 the writer used but did not list in `newWords` (or `glosses`). */
export function storyUndeclaredWords(report: StoryReport, res: Pick<StoryResponse, 'newWords' | 'glosses'>): string[] {
  const listed = new Set([...(res.newWords ?? []), ...res.glosses].map((w) => w.zh));
  const out = new Set<string>();
  for (const t of report.paragraphs.flat())
    if (t.rung !== 'allowed' && t.rung >= 3 && !listed.has(t.text)) out.add(t.text);
  return [...out];
}

/** Regeneration feedback: names every word that cost share or broke a limit, its rung and swaps. */
export function storyFeedback(
  report: StoryReport,
  budget: RungBudget,
  ctx: { ladder: Pick<VocabLadder, 'ids'>; lexicon: Pick<Lexicon, 'byId'>; undeclared?: readonly string[] },
): string {
  const parts: string[] = [];
  const problems = storyProblemWords(report, budget);
  if (report.failed.includes('rung1'))
    parts.push(
      `Only ${(report.knownShare * 100).toFixed(0)}% of the words are known or this lesson's; it must be at least ${(budget.minRung1Share * 100).toFixed(0)}%.`,
    );
  if (problems.length > 0)
    parts.push(
      `Change these words: ${problems
        .slice(0, 12)
        .map((p) => {
          const swaps = storySwaps(p, ctx.ladder, ctx.lexicon);
          return `${p.text} (${p.why}${swaps.length ? `; try ${swaps.join(' / ')}` : ''})`;
        })
        .join('、')}.`,
    );
  if (ctx.undeclared?.length) parts.push(`You used ${ctx.undeclared.slice(0, 8).join('、')} but didn't list them in "newWords".`);
  if (report.failed.includes('taiwanness'))
    parts.push(
      `Use Taiwan Mandarin in traditional characters only: ${report.taiwanness
        .flatMap((t) => [...t.result.simplifiedChars.map((c) => c.char), ...t.result.mainlandTerms.map((m) => `${m.matched} → ${m.taiwan}`)])
        .slice(0, 8)
        .join('、')}.`,
    );
  if (report.short) parts.push(`The story has only ${report.chars} characters; write a little more, up to the target length.`);
  if (report.failed.includes('length')) parts.push(`The story has ${report.chars} characters; keep to the target length.`);
  if (parts.length > 0) parts.push('Keep the same characters and topic, and change only what is needed.');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Phase 26 Part B: sentence-level repair

export interface StorySentenceRef {
  /** Index in the whole story, in reading order. */
  i: number;
  /** Paragraph index. */
  p: number;
  start: number;
  end: number;
  zh: string;
}

/** Every sentence of the story with its place in its paragraph (end punctuation kept). */
export function storySentenceRefs(paragraphs: readonly string[]): StorySentenceRef[] {
  const out: StorySentenceRef[] = [];
  paragraphs.forEach((para, p) => {
    for (const m of para.matchAll(/[^。！？!?]+[。！？!?」』”]*/g)) {
      const raw = m[0];
      const lead = raw.length - raw.trimStart().length;
      const zh = raw.trim();
      if (!zh) continue;
      const start = m.index! + lead;
      out.push({ i: out.length, p, start, end: start + zh.length, zh });
    }
  });
  return out;
}

/**
 * The repair call: only the sentences holding a problem word (or a simplified character / mainland
 * term), each with its problems and swaps. Undefined when no sentence needs changing.
 */
export function storyRepairRequest(
  res: Pick<StoryResponse, 'paragraphs'>,
  report: StoryReport,
  budget: RungBudget,
  ctx: { req: StoryRequest; ladder: Pick<VocabLadder, 'ids'>; lexicon: Pick<Lexicon, 'byId'> },
): StoryRepairRequest | undefined {
  const problems = storyProblemWords(report, budget);
  const gloss = (p: StoryProblemWord) => {
    const w = p.wordId ? ctx.lexicon.byId(p.wordId) : undefined;
    return w ? shortGloss(w) : '';
  };
  const sentences: StoryRepairRequest['sentences'] = [];
  for (const ref of storySentenceRefs(res.paragraphs.map((x) => x.zh))) {
    const list: StoryRepairRequest['sentences'][number]['problems'] = problems
      .filter((p) => ref.zh.includes(p.text))
      .map((p) => ({ zh: p.text, en: gloss(p), why: p.why.slice(0, 120), swaps: storySwaps(p, ctx.ladder, ctx.lexicon) }));
    const tw = checkTaiwanness(ref.zh);
    if (!tw.isClean) {
      for (const c of tw.simplifiedChars) list.push({ zh: c.char, en: '', why: 'simplified character: use the traditional one', swaps: [] });
      for (const m of tw.mainlandTerms) list.push({ zh: m.matched.slice(0, 20), en: '', why: 'mainland term', swaps: [m.taiwan.slice(0, 20)] });
    }
    if (list.length > 0 && sentences.length < 20) sentences.push({ i: ref.i, zh: ref.zh.slice(0, 300), problems: list.slice(0, 10) });
  }
  if (sentences.length === 0) return undefined;
  return {
    learnerLevel: ctx.req.learnerLevel,
    story: res.paragraphs.map((x) => x.zh),
    sentences,
    words: [...new Set([...ctx.req.rungs.r2, ...ctx.req.rungs.r1])].slice(0, 400),
    names: ctx.req.names,
    ...(ctx.req.variant !== undefined ? { variant: ctx.req.variant } : {}),
  };
}

/**
 * Puts the rewritten sentences back. Only the sentences that were asked about change; every other
 * byte of the story stays as written. English is replaced for the paragraphs that changed.
 */
export function applyStoryRepair(res: StoryResponse, repair: StoryRepairResponse, asked: ReadonlySet<number>): StoryResponse {
  const refs = storySentenceRefs(res.paragraphs.map((p) => p.zh));
  const byI = new Map(repair.sentences.filter((s) => asked.has(s.i)).map((s) => [s.i, s.zh.trim()]));
  const paragraphs = res.paragraphs.map((para, p) => {
    let zh = para.zh;
    let changed = false;
    for (const ref of refs.filter((r) => r.p === p).reverse()) {
      const next = byI.get(ref.i);
      if (!next || next === ref.zh || !/\p{Script=Han}/u.test(next)) continue;
      const out = zh.slice(0, ref.start) + next + zh.slice(ref.end);
      if (out.length > 600) continue;
      zh = out;
      changed = true;
    }
    if (!changed) return para;
    const en = repair.paragraphsEn.find((x) => x.p === p)?.en ?? para.en;
    return { zh, en };
  });
  const text = paragraphs.map((p) => p.zh).join('');
  const newWords = [...(res.newWords ?? []), ...repair.newWords].filter(
    (w, k, all) => text.includes(w.zh) && all.findIndex((x) => x.zh === w.zh) === k,
  );
  return { ...res, paragraphs, newWords };
}

/** Of several attempts, the one that breaks the fewest limits (then the highest rung 1 share). */
export function pickBestStoryAttempt<T extends { report: StoryReport }>(attempts: readonly T[]): T {
  return [...attempts].sort(
    (x, y) =>
      Number(y.report.pass) - Number(x.report.pass) ||
      x.report.failed.length - y.report.failed.length ||
      Number(!!x.report.short) - Number(!!y.report.short) ||
      y.report.knownShare - x.report.knownShare ||
      y.report.rung1Share - x.report.rung1Share,
  )[0]!;
}

// ---------------------------------------------------------------------------------------------
// Comprehension questions

export interface QuestionCheck {
  ok: boolean;
  /** The questions to show (well-formed, one right answer each), at most `questions.max`. */
  questions: StoryQuestion[];
  problems: string[];
}

/**
 * Each question needs 3–4 distinct options and exactly one right answer: its own `answer`, and
 * (when the independent check is given) the only option the checker found correct.
 */
export function checkStoryQuestions(questions: readonly StoryQuestion[], check?: Pick<StoryCheckResponse, 'correctOptions'>): QuestionCheck {
  const cfg = STORY_CONFIG.questions;
  const problems: string[] = [];
  const kept: StoryQuestion[] = [];
  questions.forEach((q, i) => {
    const opts = q.options.map((o) => o.zh.trim());
    if (opts.length < cfg.optionsMin || opts.length > cfg.optionsMax) return void problems.push(`Question ${i + 1}: ${opts.length} options.`);
    if (new Set(opts).size !== opts.length) return void problems.push(`Question ${i + 1}: two options are the same.`);
    if (q.answer < 0 || q.answer >= opts.length) return void problems.push(`Question ${i + 1}: the answer is not one of the options.`);
    if (!checkTaiwanness(`${q.q_zh}${opts.join('')}`).isClean) return void problems.push(`Question ${i + 1}: not Taiwan Mandarin.`);
    if (check) {
      const right = [...new Set(check.correctOptions[i] ?? [])];
      if (right.length !== 1 || right[0] !== q.answer)
        return void problems.push(`Question ${i + 1}: the independent reader found ${right.length === 0 ? 'no' : right.join(', ')} correct, not only ${q.answer}.`);
    }
    if (kept.length < cfg.max) kept.push(q);
  });
  const ok = kept.length >= cfg.min;
  if (!ok) problems.push(`Only ${kept.length} good question(s); need ${cfg.min}.`);
  return { ok, questions: kept, problems };
}

/** The independent reader approved the story. */
export const storyCheckPasses = (c: StoryCheckResponse): boolean => c.natural && c.coherent && c.taiwan && c.summaryMatches;

/** What the independent reader is given: the story and its questions, never the prompt or lists. */
export function storyCheckRequest(
  s: Pick<StoryResponse, 'paragraphs' | 'summary_en' | 'questions'>,
  glosses: ReadonlyArray<{ zh: string; en: string }> = [],
): StoryCheckRequest {
  return {
    ...(glosses.length ? { glosses: glosses.slice(0, 10).map((g) => ({ zh: g.zh, en: g.en.slice(0, 80) })) } : {}),
    paragraphs: s.paragraphs.map((p) => p.zh),
    summaryEn: s.summary_en,
    questions: s.questions.map((q) => ({ q: q.q_zh, options: q.options.map((o) => o.zh) })),
  };
}

// ---------------------------------------------------------------------------------------------
// The library

/** A saved story (per profile, synced). Rung words are kept so reading can underline them. */
/** What the web app needs from the proxy for stories (implemented by apps/web's FetchTutorLLM). */
export interface StoryLLM {
  writeStory(req: StoryRequest): Promise<{ story: StoryResponse; servedBy?: ProviderName }>;
  checkStory(req: StoryCheckRequest): Promise<StoryCheckResponse>;
  /** Phase 26: rewrite only the given sentences (POST /v1/story-repair). */
  repairStory(req: StoryRepairRequest): Promise<StoryRepairResponse>;
}

export interface StoryRecord {
  /** `storyRequestKey`: the same request is never generated twice. */
  id: string;
  createdAt: Date;
  updatedAt: Date;
  level: Level;
  difficulty: StoryDifficulty;
  topic: string;
  /** The lesson it was written for (the active lesson then). */
  lessonId?: string;
  /** "Continue a story": one series, episode 1, 2, … */
  seriesId?: string;
  episode?: number;
  titleZh: string;
  titleEn: string;
  paragraphs: { zh: string; en: string }[];
  summaryEn: string;
  glosses: { zh: string; en: string }[];
  characters: string[];
  questions: StoryQuestion[];
  /** Word ids by rung (2–6) when it was written: underlined while reading, listed afterwards. */
  newWords: { wordId?: string; text: string; rung: VocabRung }[];
  /** Content word ids in the story (for "easier now"). */
  wordIds: string[];
  chars: number;
  rung1Share: number;
  /** Set when finished. */
  readAt?: Date;
  /** Comprehension: right answers / questions. */
  score?: { right: number; of: number };
  readCount?: number;
  /** Every time it was finished (for "characters read this week"). */
  readDates?: Date[];
  /** "Something's wrong": a reported story leaves the library and is never suggested again. */
  report?: { reason: string; note?: string; at: Date };
}

/** Words to underline and list afterwards: rungs 2–6, once each. */
export function storyNewWords(report: StoryReport): StoryRecord['newWords'] {
  const seen = new Set<string>();
  const out: StoryRecord['newWords'] = [];
  for (const t of report.paragraphs.flat()) {
    if (t.rung === 'allowed' || t.rung === 1) continue;
    const k = t.wordId ?? t.text;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...(t.wordId ? { wordId: t.wordId } : {}), text: t.text, rung: t.rung });
  }
  return out;
}

/** A story record from an accepted response and its report. */
export function storyRecord(
  res: StoryResponse,
  report: StoryReport,
  questions: StoryQuestion[],
  meta: Pick<StoryRecord, 'id' | 'level' | 'difficulty' | 'topic' | 'lessonId' | 'seriesId' | 'episode'>,
  now: Date,
): StoryRecord {
  const wordIds = [...new Set(report.paragraphs.flat().flatMap((t) => (t.rung !== 'allowed' && t.wordId ? [t.wordId] : [])))];
  return {
    ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)),
    id: meta.id,
    level: meta.level,
    difficulty: meta.difficulty,
    topic: meta.topic,
    createdAt: now,
    updatedAt: now,
    titleZh: res.title_zh,
    titleEn: res.title_en,
    paragraphs: res.paragraphs,
    summaryEn: res.summary_en,
    glosses: res.glosses,
    characters: res.characters,
    questions,
    newWords: storyNewWords(report),
    wordIds,
    chars: report.chars,
    rung1Share: report.rung1Share,
  };
}

/** Share of a story's words the learner knows now (for "You'll find this one easier now"). */
export function knownShareNow(s: Pick<StoryRecord, 'wordIds'>, knownIds: ReadonlySet<string>): number {
  if (s.wordIds.length === 0) return 1;
  return s.wordIds.filter((id) => knownIds.has(id)).length / s.wordIds.length;
}

/** Older read stories that are now mostly known words: suggested again. */
export function rereadSuggestions(stories: readonly StoryRecord[], knownIds: ReadonlySet<string>, now: Date): StoryRecord[] {
  const cfg = STORY_CONFIG.reread;
  return stories
    .filter((s) => s.readAt && now.getTime() - s.readAt.getTime() >= cfg.minAgeDays * 86_400_000)
    .filter((s) => s.rung1Share < 1 && knownShareNow(s, knownIds) >= Math.max(cfg.minLearnedShare, s.rung1Share))
    .sort((a, b) => a.readAt!.getTime() - b.readAt!.getTime())
    .slice(0, cfg.maxSuggestions);
}

/** Minutes to read at Novice pace (at least 1). */
/** "Characters read this week": every finish since `since` counts its characters. */
export function storyReadingStats(stories: readonly Pick<StoryRecord, 'chars' | 'readDates' | 'readAt'>[], since: Date): { chars: number; finished: number } {
  let chars = 0;
  let finished = 0;
  for (const s of stories) {
    const dates = s.readDates ?? (s.readAt ? [s.readAt] : []);
    const n = dates.filter((d) => d.getTime() >= since.getTime()).length;
    chars += n * s.chars;
    finished += n;
  }
  return { chars, finished };
}

export const storyMinutes = (chars: number): number => Math.max(1, Math.round(chars / STORY_CONFIG.charsPerMinute));
export * from './pipeline.js';
export * from './dry.js';
