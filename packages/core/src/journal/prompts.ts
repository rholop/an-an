import type { SkillCard } from '../learner/types.js';
import type { Lexicon } from '../lexicon.js';
import { segment } from '../segment.js';
import { levelIndex } from '../levels.config.js';
import type { Level, Word } from '../types.js';

export interface WritingPrompt {
  id: string;
  en: string;
  /** A short Chinese starter to get the learner going; always N1-ish. */
  starterZh: string;
}

export const WRITING_PROMPTS: readonly WritingPrompt[] = [
  { id: 'today', en: 'What did you do today?', starterZh: '今天我…' },
  { id: 'food', en: 'What did you eat recently? Was it good?', starterZh: '我最近吃了…' },
  { id: 'weekend', en: 'What are you doing this weekend?', starterZh: '這個週末我想…' },
  { id: 'friend', en: 'Describe a friend.', starterZh: '我的朋友…' },
  { id: 'transport', en: 'How do you get to work or school?', starterZh: '我每天搭…' },
  {
    id: 'weather',
    en: 'What is the weather like, and how does it make you feel?',
    starterZh: '今天天氣…',
  },
  { id: 'family', en: 'Tell me about your family.', starterZh: '我的家人…' },
  { id: 'shopping', en: 'Describe something you bought lately.', starterZh: '我最近買了…' },
  { id: 'plan', en: 'What would you like to do next year?', starterZh: '明年我想…' },
  { id: 'city', en: 'Describe the place where you live.', starterZh: '我住在…' },
  { id: 'hobby', en: 'What do you do in your free time?', starterZh: '有空的時候，我…' },
  { id: 'memory', en: 'Write about a trip you remember.', starterZh: '我記得有一次…' },
  {
    id: 'tea',
    en: 'Imagine you are ordering a drink in Taiwan. What do you say?',
    starterZh: '我想要一杯…',
  },
  { id: 'free', en: 'Free write: anything on your mind.', starterZh: '' },
];

/** One prompt per calendar day, cycling. `now` is injected (CLAUDE.md:
 * time is never read inside core). */
export function dailyPrompt(now: Date): WritingPrompt {
  const day = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
  return WRITING_PROMPTS[
    ((day % WRITING_PROMPTS.length) + WRITING_PROMPTS.length) % WRITING_PROMPTS.length
  ]!;
}

/**
 * "Try to use these 3 due words" (phase doc §1): from the due queue,
 * production-skill cards first, then recognition, soonest-due first; one
 * entry per word.
 */
export function pickPromptWords(
  dueCards: readonly SkillCard[],
  lexicon: Lexicon,
  now: Date,
  count = 3,
  /** Phase 7: the learner's chosen level. Words at or below it come first (a
   * prompt word should be writable); above-level due words only fill gaps. */
  currentLevel?: Level,
): Word[] {
  const aboveLevel = (id: string) => {
    const lvl = lexicon.byId(id)?.level;
    return currentLevel && lvl && levelIndex(lvl) > levelIndex(currentLevel) ? 1 : 0;
  };
  const eligible = dueCards
    .filter((c) => c.item.kind === 'word' && c.card.due <= now && lexicon.byId(c.item.id))
    .sort(
      (a, b) =>
        aboveLevel(a.item.id) - aboveLevel(b.item.id) ||
        Number(b.skill === 'production') - Number(a.skill === 'production') ||
        a.card.due.getTime() - b.card.due.getTime(),
    );
  const picked: Word[] = [];
  const seen = new Set<string>();
  for (const c of eligible) {
    if (seen.has(c.item.id)) continue;
    seen.add(c.item.id);
    picked.push(lexicon.byId(c.item.id)!);
    if (picked.length >= count) break;
  }
  return picked;
}

/** Which of the given words appear in `text` (re-segmenting, so 還 inside
 * 還是 doesn't count as 還). Returns the matching word ids. Occurrences
 * overlapping `excludeSpans` (e.g. spans the review flagged as wrong) don't
 * count — a word used incorrectly isn't "used". */
export function findWordsUsed(
  text: string,
  words: readonly Word[],
  lexicon: Lexicon,
  excludeSpans: readonly (readonly [number, number])[] = [],
): Set<string> {
  const used = new Set<string>();
  for (const token of segment(text, lexicon)) {
    if (token.kind !== 'word') continue;
    if (excludeSpans.some(([a, b]) => a < token.end && token.start < b)) continue;
    for (const w of lexicon.lookup(token.text)) {
      if (words.some((target) => target.id === w.id)) used.add(w.id);
    }
  }
  return used;
}
