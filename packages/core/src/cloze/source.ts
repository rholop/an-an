import { isUsableSentence } from './report.js';
import { lessonBadge } from '../textbook/course.js';
import { homeLessonOfTags } from '../textbook/scope.js';
import { COMPREHENSIBLE_CLASSES } from '../progress/terms.js';
import type { Lexicon } from '../lexicon.js';
import { levelIndex } from '../levels.config.js';
import type { Level, Word } from '../types.js';
import { analyzeText, DEFAULT_VALIDATE_CONFIG, type AnalyzeContext } from '../validate/turn.js';
import type { SentenceBankEntry } from './sentence.js';

export type ClozeSourceKind = 'journal' | 'chat' | 'bank' | 'none';

export interface ClozeSourceCandidate {
  zh: string;
  en?: string;
  sourceKind: ClozeSourceKind;
  sourceLabel: string;
  /** When this line was produced, for the UI to render its own relative
   * phrasing ("on Tuesday") — core stays free of locale/"now" concerns. */
  at?: Date;
}

/** Phase 5 stub shape — always pass `[]`/omit until journal mode exists. */
export interface JournalSentenceSource {
  zh: string;
  en?: string;
  at: Date;
}

export interface ChatLineSource {
  zh: string;
  /** English gloss when the turn has one (npc turns), for the reader. */
  en?: string;
  role: 'npc' | 'learner';
  scenarioTitle: string;
  npcName?: string;
  at: Date;
}

export interface SelectClozeSourceOptions {
  lexicon: Lexicon;
  knownIds: ReadonlySet<string>;
  learnerLevel: Level;
  journalSentences?: JournalSentenceSource[];
  chatLines?: ChatLineSource[];
  /** The whole bank (or any superset) — filtered internally by
   * targetWordId, so callers don't need to pre-filter. */
  bankSentences?: SentenceBankEntry[];
  coverageThreshold?: number;
  /** Skip any candidate whose `zh` is in this set — used by the leech
   * `new_context` treatment (learner/leech.ts) to force a sentence the
   * learner hasn't already seen for this item. */
  excludeZh?: ReadonlySet<string>;
}

function containsWord(zh: string, word: Word): boolean {
  return [word.headword, ...word.variants].some((hw) => zh.includes(hw));
}


export interface ClozeCoverageResult {
  pass: boolean;
  coverage: number;
}

/**
 * Coverage check for a cloze sentence — "must pass coverage for the
 * learner's current known set, apart from the blank" (phase doc 04 §2).
 * Unlike Phase 3's chat validator (where a `target` word still counts
 * against the turn's coverage ratio, as part of its "new words per turn"
 * budget), the blanked/generated word here is the whole point of the
 * exercise and must NOT count against coverage at all — so every
 * classified token belonging to `excludeWordId` is excluded from the ratio
 * entirely, rather than merely exempted-but-still-penalizing. Also used by
 * data-pipeline's build-sentences.ts to validate freshly-generated
 * sentences, which hit the exact same "target word tanks a short sentence's
 * coverage" trap if graded the Phase-3 way.
 */
export function analyzeClozeCoverage(
  zh: string,
  ctx: AnalyzeContext,
  excludeWordId: string,
  coverageThreshold: number = DEFAULT_VALIDATE_CONFIG.coverageThreshold,
): ClozeCoverageResult {
  const result = analyzeText(zh, ctx);
  const rest = result.classifications.filter((c) => c.wordId !== excludeWordId);
  const coverage =
    rest.length === 0
      ? 1
      : rest.filter((c) => COMPREHENSIBLE_CLASSES.has(c.class)).length / rest.length;
  return { pass: coverage >= coverageThreshold && result.taiwanness.isClean, coverage };
}

function passesCoverage(zh: string, word: Word, opts: SelectClozeSourceOptions): boolean {
  const ctx: AnalyzeContext = {
    lexicon: opts.lexicon,
    learnerLevel: opts.learnerLevel,
    knownIds: opts.knownIds,
    dueIds: new Set(),
    targetIds: new Set(),
    learningIds: new Set(),
    allowedExtraIds: new Set(),
  };
  return analyzeClozeCoverage(zh, ctx, word.id, opts.coverageThreshold).pass;
}

export function chatSourceLabel(line: ChatLineSource): string {
  if (line.role === 'npc' && line.npcName)
    return `from your chat with ${line.npcName} (${line.scenarioTitle})`;
  return `from your own reply in ${line.scenarioTitle}`;
}

/**
 * Phase 4 §2's cloze source priority: a learner journal sentence (Phase 5,
 * always empty today) -> an NPC or learner line from chat history
 * containing the word -> a sentence-bank sentence -> none (plain card).
 * Chat lines are tried most-recent-first — personal, recent context is the
 * most memorable (phase doc §6), and it's also the most likely to still
 * reflect words the learner currently knows.
 */
export function selectClozeSource(
  word: Word,
  opts: SelectClozeSourceOptions,
): ClozeSourceCandidate | null {
  const excluded = (zh: string) => !isUsableSentence(zh, opts.excludeZh);

  for (const j of opts.journalSentences ?? []) {
    if (!excluded(j.zh) && containsWord(j.zh, word) && passesCoverage(j.zh, word, opts)) {
      return {
        zh: j.zh,
        en: j.en,
        sourceKind: 'journal',
        sourceLabel: 'from your journal',
        at: j.at,
      };
    }
  }

  const chatByRecency = [...(opts.chatLines ?? [])].sort((a, b) => b.at.getTime() - a.at.getTime());
  for (const line of chatByRecency) {
    if (!excluded(line.zh) && containsWord(line.zh, word) && passesCoverage(line.zh, word, opts)) {
      return { zh: line.zh, sourceKind: 'chat', sourceLabel: chatSourceLabel(line), at: line.at };
    }
  }

  // Phase 7: prefer sentences written at or below the learner's chosen level;
  // above-level ones are still a last resort within the bank (stable order).
  const levelRank = (s: SentenceBankEntry) =>
    levelIndex(s.level) <= levelIndex(opts.learnerLevel) ? 0 : 1;
  const bankCandidates = (opts.bankSentences ?? [])
    .filter((s) => s.targetWordId === word.id)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => levelRank(a.s) - levelRank(b.s) || a.i - b.i)
    .map(({ s }) => s);
  for (const s of bankCandidates) {
    if (!excluded(s.zh) && passesCoverage(s.zh, word, opts)) {
      // Phase 21: a lesson's own sentence says which lesson ("來學華語 1 · Lesson 3 sentence").
      const home = homeLessonOfTags(s.tags ?? []);
      const sourceLabel = home ? `${lessonBadge(home.n, home.bookId)} sentence` : 'example sentence';
      return { zh: s.zh, en: s.en, sourceKind: 'bank', sourceLabel };
    }
  }

  return null;
}
