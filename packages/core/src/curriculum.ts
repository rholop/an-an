// Phase 29 Part B.4: there is one new-word picker (`pickNewForSession`, under the ledger's
// allowance). With the study order off (or no textbook) its candidates are the picked level's
// words, in the order below; level coverage and the level-up suggestion are the ledger's
// (`ledger.level`, `ledger.frontierLevel`). Pure.
import { transparency } from './learner/char-stats.js';
import { newItemInBounds } from './learner/review-pile.js';
import type { Lexicon } from './lexicon.js';
import type { ItemRef, Level, Word } from './types.js';
import { LEVEL_IDS } from './levels.config.js';
import { tagsInScope, type ClassScope } from './textbook/scope.js';

export interface LevelCandidatesInput {
  lexicon: Pick<Lexicon, 'allWords'>;
  /** The picked level ("My level"), or the ledger's frontier level. */
  level: Level;
  /** Also offer the next level's words after this level's (its Learned share passed the level-up line). */
  nextLevelToo: boolean;
  /** Word ids that already have a card (never introduced twice). */
  carded: ReadonlySet<string>;
  /** Characters of Learned words (`knownCharacters`). */
  knownChars: ReadonlySet<string>;
  /** My class: textbook words beyond the class stay out (visibility only). */
  classScope?: ClassScope;
  /** Topic tags to prefer (e.g. the current chat scenario's). */
  scenarioTags?: readonly string[];
}

/** New-word candidates when no study focus orders them: the level's in-bounds words not met yet,
 * topic tags first, then frequency, then the share of characters already known. */
export function levelNewCandidates(input: LevelCandidatesInput): ItemRef[] {
  const scope = input.classScope?.enabled ? input.classScope : undefined;
  const tags = new Set(input.scenarioTags ?? []);
  const next = LEVEL_IDS[LEVEL_IDS.indexOf(input.level) + 1];
  const pool = (level: Level | undefined) =>
    level === undefined
      ? []
      : input.lexicon
          .allWords()
          .filter(
            (w) =>
              (w.level === level || (level === input.level && w.source === 'custom')) &&
              newItemInBounds(w) &&
              !input.carded.has(w.id) &&
              (!scope || tagsInScope(w.tags, scope)),
          )
          .sort((a, b) => compare(a, b, tags, input.knownChars));
  const words = [...pool(input.level), ...(input.nextLevelToo ? pool(next) : [])];
  return words.map((w) => ({ kind: 'word' as const, id: w.id }));
}

function compare(a: Word, b: Word, tags: ReadonlySet<string>, known: ReadonlySet<string>): number {
  const tag = (w: Word) => (w.tags.some((t) => tags.has(t)) ? 0 : 1);
  if (tag(a) !== tag(b)) return tag(a) - tag(b);
  const fa = a.freqRank ?? Number.POSITIVE_INFINITY;
  const fb = b.freqRank ?? Number.POSITIVE_INFINITY;
  if (fa !== fb) return fa - fb;
  return transparency(b, known) - transparency(a, known) || a.id.localeCompare(b.id);
}
