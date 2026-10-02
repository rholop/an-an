import type { GlossAdjudicationRequest, Word } from '@anan/core';
import type { SenseInventory } from './inventory.js';

/** The adjudication request for one word (phase doc B2): word + POS from the
 * TOCFL list, MOE definition(s), every candidate English sense, and up to two
 * example sentences from the sentence bank. */
export function buildAdjudicationRequest(
  word: Pick<Word, 'id' | 'headword' | 'pinyin' | 'pos' | 'level'>,
  inventory: SenseInventory,
  examples: { zh: string; en: string }[] = [],
): GlossAdjudicationRequest {
  return {
    word: {
      id: word.id,
      headword: word.headword,
      pinyin: word.pinyin,
      pos: word.pos,
      level: word.level,
    },
    moeDefsZh: inventory.moeDefsZh.slice(0, 3),
    candidates: inventory.candidates.slice(0, 30),
    examples: examples.slice(0, 2),
  };
}
