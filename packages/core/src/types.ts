// Shared contract between phases. See CLAUDE.md §"Shared core types" — phases may add
// fields but must not rename or remove these.

export type { Level } from './levels.config.js';
import type { Level } from './levels.config.js';
/** Phase 15 brings back `listening` (scheduled by FSRS like the others; never part of Phase 14 mastery).
 * Phase 23 adds `reading`: knowing a word's pinyin and tones from its characters (Review "Say it" and
 * the Pinyin & tones tab; not part of lesson mastery either). */
export type Skill = 'recognition' | 'production' | 'listening' | 'reading';
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
    | 'listening_wrong'
    /** Phase 20: the learner said "nope" to a card (see `context.choice`). Never a lapse. */
    | 'review_nope'
    /** Phase 20: brought back into review (Removed words → Restore, or "Add to review"). */
    | 'review_restore'
    /** Phase 21: passed "I already know this" (quick check): Learned and Mastered until a lapse. */
    | 'known_check_passed'
    /** Phase 21: the recognition card was Learned, so the word's production card is created (New). */
    | 'production_unlocked'
    /** Phase 21: the word has a verified clip and a Learned recognition card: its listening card is created. */
    | 'listening_unlocked'
    /** Phase 21: a word the learner needed mid-journal: introduce/Again its production card, at the front. */
    | 'journal_priority'
    /** Phase 21: an answer was undone. `context.refId` = the undone evidence row; `context.restore` = the card before it. */
    | 'evidence_undone'
    /** Phase 21: set the cloze ladder rung without a rating (lesson grammar step, error bank). */
    | 'cloze_rung_set'
    /** Phase 23 pinyin & tones: right pinyin and tones (Good). */
    | 'reading_correct'
    /** Right sounds, a wrong tone (Hard). `context.tones` says which. */
    | 'reading_tone_wrong'
    /** Wrong sounds or wrong word (Again). */
    | 'reading_wrong'
    /** Phase 23: the recognition card reached learning, so the word's reading card is created (New). */
    | 'reading_unlocked'
    /** Phase 24: a due or learning word read in a story without a lookup (weak, like chat_read_no_lookup). */
    | 'story_read_no_lookup';
  at: Date;
  context?: {
    source: 'chat' | 'journal' | 'cloze' | 'review' | 'placement' | 'reader' | 'textbook' | 'pinyin' | 'story';
    refId?: string;
    /** Phase 5: a journal_misuse the learner corrected themselves. */
    selfFixed?: boolean;
    /** Phase 20: which "nope" (review_nope). */
    choice?: NopeChoice;
    /** Phase 20: a lookup of a word outside the learner's bounds: logged, but no card is created. */
    noIntroduce?: boolean;
    /** Phase 20: where the learner was when they said "Not now" (when it may come back). */
    snoozedWhen?: { level?: Level; lessonId?: string };
    /** Phase 21 evidence_undone: the card as it was before the undone answer (absent = it didn't exist). */
    restore?: unknown;
    /** Phase 21 cloze_rung_set: the rung to set. */
    rung?: number;
    /** Phase 23: which Review face was answered (the production ladder moves on 'pick' / 'recall'). */
    face?: 'meaning' | 'pick' | 'recall' | 'say' | 'grammar';
    /** Phase 23: a wrong pick (Pick the Mandarin, look-alikes, homophones): the word picked instead. */
    pickedId?: string;
    /** Phase 23 reading_tone_wrong: per wrong syllable, the right tone and the one given (5 = neutral). */
    tones?: { expected: number; given: number }[];
  };
}

/** Phase 20: Not now (back to the unstudied pool), I already know it, Never show this. */
export type NopeChoice = 'not_now' | 'known' | 'never';
