// Shared contract between phases. See CLAUDE.md §"Shared core types" — phases may add
// fields but must not rename or remove these.

export type { Level } from './levels.config.js';
import type { Level } from './levels.config.js';
/** Phase 15 brings back `listening` (scheduled by FSRS like the others; never part of Phase 14 mastery). */
export type Skill = 'recognition' | 'production' | 'listening';
export type ItemState = 'unseen' | 'introduced' | 'learning' | 'review' | 'mature';

export interface Word {
  id: string;
  headword: string;
  variants: string[];
  pos: string[];
  level: Level | null;
  source: 'tocfl' | 'supplement' | 'custom' | 'textbook';
  pinyin: string;
  pinyinNumeric: string;
  zhuyin: string;
  glossEn: string;
  senseNote?: string;
  chars: string[];
  tags: string[];
  freqRank?: number;
  /** Phase 7: every sense worth showing, primary first. `glossEn` stays the
   * primary sense's gloss for back-compat. Absent on custom/legacy words. */
  senses?: Sense[];
  primarySenseId?: string;
  /** Source ids behind the primary gloss, e.g. ['cedict', 'top2011']. */
  glossSources?: string[];
  /** MOE 重編國語辭典 definition(s) for this reading, VERBATIM (CC BY-ND:
   * never edit this text; show it with credit). */
  moeDefZh?: string[];
  /** Phase 12: the textbook's own sense (an entry of `senses`), shown first in textbook context. */
  textbookSenseId?: string;
}

/** One sense of a word. Chosen and condensed from source candidates, never
 * free-form invented (phase 7 §B2). */
export interface Sense {
  /** `${wordId}#${n}` — stable within a build; refs from chat tokens use it. */
  id: string;
  glossEn: string;
  noteEn?: string;
  register?: string;
  taiwanOnly?: boolean;
  pos?: string;
  /** Which sources support it: 'cedict' | 'moe-cedict' | 'wiktionary' | 'top2011' | 'moe-zh' | 'override' | 'ai'. */
  basedOn: string[];
}

export interface GrammarItem {
  id: string;
  pattern: string;
  level: Level | null;
  explanationEn: string;
  examples: string[];
  /** Phase 12: e.g. ['textbook:laixue-1', 'textbook:laixue-1:L03']. */
  tags?: string[];
  /** Phase 12: the function word(s) that signal the pattern in a sentence; blanked by the grammar cloze. */
  focus?: string[];
}

export type ItemRef = { kind: 'word' | 'grammar'; id: string };

export interface Evidence {
  item: ItemRef;
  skill: Skill;
  kind:
    | 'cloze_correct_nohint'
    | 'cloze_correct_hint'
    | 'cloze_wrong'
    | 'journal_correct_use'
    | 'journal_misuse'
    | 'chat_read_no_lookup'
    | 'chat_lookup_gloss'
    | 'chat_hover_reading'
    | 'review_again'
    | 'review_hard'
    | 'review_good'
    | 'review_easy'
    | 'anki_import_seen'
    | 'placement_known'
    | 'placement_unknown'
    /** Phase 12: the class covered this item's lesson. Introduces the card only. */
    | 'textbook_lesson_covered'
    /** Phase 15: heard it and got it on the first play (Good). */
    | 'listening_correct'
    /** Correct after 2+ replays, at slow speed, or right syllables with a wrong tone (Hard). */
    | 'listening_correct_replayed'
    | 'listening_wrong';
  at: Date;
  context?: {
    source: 'chat' | 'journal' | 'cloze' | 'review' | 'placement' | 'reader' | 'textbook';
    refId?: string;
    /** Phase 5: a journal_misuse the learner corrected themselves. */
    selfFixed?: boolean;
  };
}
