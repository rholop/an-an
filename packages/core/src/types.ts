// Shared contract between phases. See CLAUDE.md §"Shared core types" — phases may add
// fields but must not rename or remove these.

export type Level = 'N1' | 'N2' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';
export type Skill = 'recognition' | 'production';
export type ItemState = 'unseen' | 'introduced' | 'learning' | 'review' | 'mature';

export interface Word {
  id: string;
  headword: string;
  variants: string[];
  pos: string[];
  level: Level | null;
  source: 'tocfl' | 'supplement' | 'custom';
  pinyin: string;
  pinyinNumeric: string;
  zhuyin: string;
  glossEn: string;
  senseNote?: string;
  chars: string[];
  tags: string[];
  freqRank?: number;
}

export interface GrammarItem {
  id: string;
  pattern: string;
  level: Level | null;
  explanationEn: string;
  examples: string[];
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
    | 'placement_unknown';
  at: Date;
  context?: { source: 'chat' | 'journal' | 'cloze' | 'review' | 'placement'; refId?: string };
}
