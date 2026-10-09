import type { SentenceBankEntry, SentenceGenRequest } from '../cloze/sentence.js';
import { chatSourceLabel, type ChatLineSource, type JournalSentenceSource } from '../cloze/source.js';
import { splitSentences } from '../journal/sentences.js';
import type { Lexicon } from '../lexicon.js';
import { levelIndex } from '../levels.config.js';
import type { Level, Word } from '../types.js';
import { analyzeText, type AnalyzeContext } from '../validate/turn.js';
import { COMPREHENSIBLE_CLASSES } from '../progress/terms.js';

/**
 * Phase 9: which sentence the reader's "New sentence" button shows next.
 * Pure — the caller (apps/web ReaderService) gathers the learner's state and
 * the candidate pools, and passes `now` and `rand` in, so every rule here is
 * unit-tested. Live generation is NOT here (it needs the network): the caller
 * runs it only when {@link selectLocalReaderSentence} finds no exact match,
 * and validates what comes back with {@link evaluateReaderSentence}.
 */

export type ReaderFocus = 'mixed' | 'review' | 'new' | 'lesson';
/** `lesson` (Phase 12) is offered only while "My class" is on: sentences written for the current textbook lesson. */
export const READER_FOCUSES: readonly ReaderFocus[] = ['mixed', 'review', 'new', 'lesson'];
export const isReaderFocus = (v: unknown): v is ReaderFocus =>
  typeof v === 'string' && (READER_FOCUSES as readonly string[]).includes(v);

/** Phase 9 §"Where sentences come from": a sentence must be >= 95% known and
 * have at most 2 unknown words. */
export const READER_COVERAGE_THRESHOLD = 0.95;
export const READER_MAX_UNKNOWN = 2;
/** "hasn't been shown to this profile in the last 7 days". */
export const READER_REPEAT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ReaderSentenceSource = 'bank' | 'live' | 'chat' | 'journal';

export interface ReaderSentence {
  /** Stable: bank/live entries keep their id; chat/journal lines get a content hash. */
  id: string;
  zh: string;
  en?: string;
  source: ReaderSentenceSource;
  /** "example sentence", "From your chat with 阿美 (…)", "From your journal". */
  sourceLabel: string;
  level?: Level;
  /** Bank/live only: the word the sentence was written around. */
  targetWordId?: string;
}

export interface ReaderPick {
  sentence: ReaderSentence;
  focus: ReaderFocus;
  /** The due / learning / new word this sentence was chosen for. */
  focusWordId?: string;
  /** "Practising 便利商店 (in this review session)", "New word: 垃圾車", … */
  reason: string;
  /** Meets the coverage rule (and the focus rule). False = "closest match". */
  exact: boolean;
  coverage: number;
  unknownCount: number;
}

export interface ReaderLearnerState {
  lexicon: Lexicon;
  learnerLevel: Level;
  /** Learned word ids (the ledger's `comprehensible().knownIds`). */
  knownIds: ReadonlySet<string>;
  /** Word ids with a card in the current review session (`comprehensible().dueIds`). */
  dueIds: ReadonlySet<string>;
  /** Answered at least once, not Learned yet (`comprehensible().learningIds`). */
  learningIds: ReadonlySet<string>;
  /** New words the next session may introduce (the ledger's `pickNew`, one new-word rule). */
  frontier: readonly Word[];
}

/** FNV-1a, hex — a short stable id for sentences that have none of their own. */
export function hashReaderText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const MIN_OWN_CHARS = 4;
const MAX_OWN_CHARS = 40;

export function bankEntryToReaderSentence(entry: SentenceBankEntry): ReaderSentence {
  return {
    id: entry.id,
    zh: entry.zh,
    en: entry.en || undefined,
    source: entry.source === 'generated-live' ? 'live' : 'bank',
    sourceLabel: entry.source === 'generated-live' ? 'made for you' : 'example sentence',
    level: entry.level,
    targetWordId: entry.targetWordId,
  };
}

/** Chat turns -> single sentences. A turn's English is only attached when the
 * turn is one sentence (otherwise it translates the whole turn). */
export function readerSentencesFromChat(lines: readonly ChatLineSource[]): ReaderSentence[] {
  const out = new Map<string, ReaderSentence>();
  for (const line of lines) {
    const spans = splitSentences(line.zh);
    for (const [s, e] of spans) {
      const zh = line.zh.slice(s, e).trim();
      if (zh.length < MIN_OWN_CHARS || zh.length > MAX_OWN_CHARS || /[[［\]］]/.test(zh)) continue;
      const id = `chat-${hashReaderText(zh)}`;
      if (out.has(id)) continue;
      out.set(id, {
        id,
        zh,
        en: spans.length === 1 ? line.en : undefined,
        source: 'chat',
        sourceLabel: chatSourceLabel(line).replace(/^from/, 'From'),
      });
    }
  }
  return [...out.values()];
}

export function readerSentencesFromJournal(
  sentences: readonly JournalSentenceSource[],
): ReaderSentence[] {
  const out = new Map<string, ReaderSentence>();
  for (const j of sentences) {
    if (j.zh.length > MAX_OWN_CHARS) continue;
    const id = `journal-${hashReaderText(j.zh)}`;
    if (!out.has(id))
      out.set(id, { id, zh: j.zh, en: j.en, source: 'journal', sourceLabel: 'From your journal' });
  }
  return [...out.values()];
}

// --------------------------------------------------------------------------
// Evaluating one candidate sentence
// --------------------------------------------------------------------------

export interface ReaderEvaluation {
  exact: boolean;
  coverage: number;
  unknownCount: number;
  /** Meets the focus rule (a due word for review, 1–2 due/learning for mixed, exactly one frontier word for new). */
  focusOk: boolean;
  taiwanClean: boolean;
  focusWordId?: string;
  /** Higher = closer to passing; used to rank "closest match". */
  closeness: number;
}


/** The ids the focus is built around, in priority order. */
export function focusWordIds(focus: ReaderFocus, state: ReaderLearnerState): Set<string> {
  if (focus === 'new') return new Set(state.frontier.map((w) => w.id));
  if (focus === 'review') {
    if (state.dueIds.size > 0) return new Set(state.dueIds);
    return new Set(state.learningIds);
  }
  return new Set([...state.dueIds, ...state.learningIds]);
}

export function evaluateReaderSentence(
  zh: string,
  focus: ReaderFocus,
  state: ReaderLearnerState,
): ReaderEvaluation {
  const frontierIds = new Set(state.frontier.map((w) => w.id));
  const ctx: AnalyzeContext = {
    lexicon: state.lexicon,
    learnerLevel: state.learnerLevel,
    knownIds: state.knownIds,
    dueIds: state.dueIds,
    learningIds: state.learningIds,
    targetIds: focus === 'new' ? frontierIds : new Set(),
    allowedExtraIds: new Set(),
  };
  const analysis = analyzeText(zh, ctx);
  const ids = [...new Set(analysis.classifications.flatMap((c) => (c.wordId ? [c.wordId] : [])))];

  const dueHit = ids.filter((id) => state.dueIds.has(id));
  const learningHit = ids.filter((id) => !state.dueIds.has(id) && state.learningIds.has(id));
  const newHit = ids.filter((id) => frontierIds.has(id));

  let focusOk: boolean;
  let focusWordId: string | undefined;
  if (focus === 'new') {
    focusOk = frontierIds.size === 0 || newHit.length === 1;
    focusWordId = newHit[0];
  } else if (focus === 'review') {
    const pool = state.dueIds.size > 0 ? dueHit : learningHit;
    focusOk = state.dueIds.size + state.learningIds.size === 0 || pool.length >= 1;
    focusWordId = pool[0] ?? dueHit[0] ?? learningHit[0];
  } else {
    const hits = dueHit.length + learningHit.length;
    focusOk = state.dueIds.size + state.learningIds.size === 0 || (hits >= 1 && hits <= 2);
    focusWordId = dueHit[0] ?? learningHit[0];
  }

  // The new word is the point of a "new words" sentence, so (like cloze) it is
  // left out of the coverage ratio; it still counts toward the unknown cap.
  const rest =
    focus === 'new' && newHit.length === 1
      ? analysis.classifications.filter((c) => c.wordId !== newHit[0])
      : analysis.classifications;
  const coverage =
    rest.length === 0 ? 1 : rest.filter((c) => COMPREHENSIBLE_CLASSES.has(c.class)).length / rest.length;
  const unknownCount = analysis.unknown.length;
  const taiwanClean = analysis.taiwanness.isClean;

  const exact =
    taiwanClean &&
    focusOk &&
    coverage >= READER_COVERAGE_THRESHOLD &&
    unknownCount <= READER_MAX_UNKNOWN;
  const closeness =
    coverage - 0.05 * unknownCount - (focusOk ? 0 : 0.3) - (taiwanClean ? 0 : 1);
  return { exact, coverage, unknownCount, focusOk, taiwanClean, focusWordId, closeness };
}

function reasonFor(
  focus: ReaderFocus,
  evaluation: ReaderEvaluation,
  state: ReaderLearnerState,
): string {
  const word = evaluation.focusWordId ? state.lexicon.byId(evaluation.focusWordId) : undefined;
  if (word) {
    if (focus === 'new' || state.frontier.some((w) => w.id === word.id))
      return `New word: ${word.headword}`;
    if (state.dueIds.has(word.id)) return `Practising ${word.headword} (in this review session)`;
    return `Practising ${word.headword} (still learning)`;
  }
  return 'Mostly words you know';
}

function pickOf(
  sentence: ReaderSentence,
  focus: ReaderFocus,
  evaluation: ReaderEvaluation,
  state: ReaderLearnerState,
): ReaderPick {
  return {
    sentence,
    focus,
    focusWordId: evaluation.focusWordId,
    reason: reasonFor(focus, evaluation, state),
    exact: evaluation.exact,
    coverage: evaluation.coverage,
    unknownCount: evaluation.unknownCount,
  };
}

/** Turn a validated live-generated sentence into a pick (always exact — the caller only keeps passes). */
export function pickFromEvaluated(
  sentence: ReaderSentence,
  focus: ReaderFocus,
  evaluation: ReaderEvaluation,
  state: ReaderLearnerState,
): ReaderPick {
  return pickOf(sentence, focus, evaluation, state);
}

// --------------------------------------------------------------------------
// Picking from the local pools (bank, then the learner's own lines)
// --------------------------------------------------------------------------

export interface SelectLocalOptions {
  state: ReaderLearnerState;
  focus: ReaderFocus;
  /** Static bank + the profile's live-generated sentences. */
  bank: readonly SentenceBankEntry[];
  /** Chat / journal sentences (readerSentencesFrom*). */
  own: readonly ReaderSentence[];
  /** sentence id -> when it was last shown to this profile (ms). Include ids
   * already in this session's history so back-to-back presses never repeat. */
  shown: ReadonlyMap<string, number>;
  now: Date;
  rand?: () => number;
  /** Cap on sentences analysed per pool per press — keeps a press instant on a big bank. */
  maxEvaluations?: number;
}

export interface LocalSelection {
  /** Fresh (not shown in 7 days), meets the rule. Use this. */
  exact: ReaderPick | null;
  /** Meets the rule but was shown within 7 days — only worth showing if nothing fresh can be made. */
  repeatExact: ReaderPick | null;
  /** Best sentence that misses the rule — shown only with the "closest match" label. */
  closest: ReaderPick | null;
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function containsAny(zh: string, ids: ReadonlySet<string>, lexicon: Lexicon): boolean {
  for (const id of ids) {
    const w = lexicon.byId(id);
    if (w && [w.headword, ...w.variants].some((h) => zh.includes(h))) return true;
  }
  return false;
}

export function selectLocalReaderSentence(opts: SelectLocalOptions): LocalSelection {
  const { state, focus, now } = opts;
  const rand = opts.rand ?? Math.random;
  const cap = opts.maxEvaluations ?? 80;
  const focusIds = focusWordIds(focus, state);
  const cutoff = now.getTime() - READER_REPEAT_WINDOW_MS;
  const isRecent = (id: string) => (opts.shown.get(id) ?? -Infinity) > cutoff;

  const bankPool: ReaderSentence[] = opts.bank
    .filter(
      (e) =>
        levelIndex(e.level) <= levelIndex(state.learnerLevel) &&
        (focusIds.size === 0 || focusIds.has(e.targetWordId)),
    )
    .map(bankEntryToReaderSentence);
  const ownPool = opts.own.filter(
    (s) => focusIds.size === 0 || containsAny(s.zh, focusIds, state.lexicon),
  );

  let exact: ReaderPick | null = null;
  let repeatExact: ReaderPick | null = null;
  let closest: ReaderPick | null = null;
  let closestScore = -Infinity;

  for (const pool of [bankPool, ownPool]) {
    if (exact) break;
    const fresh = shuffled(
      pool.filter((s) => !isRecent(s.id)),
      rand,
    );
    const recent = pool
      .filter((s) => isRecent(s.id))
      .sort((a, b) => (opts.shown.get(a.id) ?? 0) - (opts.shown.get(b.id) ?? 0));

    let evaluated = 0;
    for (const [list, isFresh] of [
      [fresh, true],
      [recent, false],
    ] as const) {
      for (const sentence of list) {
        if (evaluated++ >= cap) break;
        if (!isFresh && repeatExact) break;
        const ev = evaluateReaderSentence(sentence.zh, focus, state);
        if (ev.exact) {
          if (isFresh) {
            exact = pickOf(sentence, focus, ev, state);
            break;
          }
          repeatExact = pickOf(sentence, focus, ev, state);
          break;
        }
        if (isFresh && ev.closeness > closestScore) {
          closestScore = ev.closeness;
          closest = pickOf(sentence, focus, ev, state);
        }
      }
      if (exact) break;
    }
  }
  return { exact, repeatExact, closest };
}

// --------------------------------------------------------------------------
// Live generation helpers
// --------------------------------------------------------------------------

/** The word a live-generated sentence should be built around. */
export function pickGenerationWord(
  focus: ReaderFocus,
  state: ReaderLearnerState,
  rand: () => number = Math.random,
): Word | undefined {
  const ids = [...focusWordIds(focus, state)];
  const words = ids.flatMap((id) => {
    const w = state.lexicon.byId(id);
    return w ? [w] : [];
  });
  const pool = focus === 'new' ? words.slice(0, 20) : words;
  if (pool.length > 0) return pool[Math.floor(rand() * pool.length)];
  // Nothing due / learning (or no frontier): fall back to the first frontier word.
  return state.frontier[0];
}

/** POST /v1/sentences body: the focus word plus a sample of the learner's own
 * known words to build from, so the sentence is mostly comprehensible. */
export function buildReaderGenRequest(
  word: Word,
  state: ReaderLearnerState,
  rand: () => number = Math.random,
  sampleSize = 120,
): SentenceGenRequest {
  const known = shuffled(
    [...new Set([...state.knownIds, ...state.dueIds, ...state.learningIds])],
    rand,
  );
  const allowed: string[] = [];
  for (const id of known) {
    if (allowed.length >= sampleSize) break;
    const hw = state.lexicon.byId(id)?.headword;
    if (hw && hw !== word.headword) allowed.push(hw);
  }
  return {
    word: {
      headword: word.headword,
      pinyin: word.pinyin,
      level: word.level ?? state.learnerLevel,
      glossEn: word.glossEn,
    },
    allowedVocab: allowed,
    count: 3,
  };
}
