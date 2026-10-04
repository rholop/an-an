import { z } from 'zod';

/**
 * `data/curriculum/<bookId>/config.json`: everything about a book's PDF layout
 * the importer needs, so none of it is hard-coded for book 1. Fill it in by
 * reading the book's contents page (lesson start pages = printed page + the
 * book's front-matter offset).
 */
export const BookConfigSchema = z.object({
  bookId: z.string().regex(/^[a-z0-9-]+$/),
  titleZh: z.string(),
  titleEn: z.string(),
  /** Printed words/grammar the preface (編者的話) states: the check numbers. */
  stated: z.object({ words: z.number().int(), grammar: z.number().int() }),
  /** PDF page of the first page of each lesson (the 'Learning Objectives' page). */
  lessonStartPages: z.array(z.number().int()).min(1),
  /** First PDF page AFTER the last lesson's grammar/activities (the closing culture notes). */
  endPage: z.number().int(),
  /** PDF pages holding the contents (目次) lesson list. */
  tocPages: z.array(z.number().int()).min(1),
  /** First and last PDF page of the appendix vocabulary index. */
  indexPages: z.tuple([z.number().int(), z.number().int()]),
  /** Run PyMuPDF glyph decoding (fonts without a Unicode map: 來學華語 3). */
  glyphDecode: z.boolean().default(false),
  /** The 1-in-N ruby glitch of book 1 ("名字子") needs the syllable-count cleanup. */
  rubyDuplicates: z.boolean().default(false),
  vocab: z.object({
    /** See `VocabParseOptions.sections`. */
    sections: z.enum(['headings', 'order']),
    /** Headings of the vocabulary blocks, as regex source. */
    headings: z.object({
      core: z.string(),
      phrase: z.string(),
      proper: z.string(),
      supplementary: z.string(),
    }),
    /** Heading that closes the vocabulary and opens the grammar notes. */
    grammarHeading: z.string(),
    /** Repeated headwords the book teaches as a NEW sense (so each counts as a new word). */
    distinctSenses: z.array(z.string()).default([]),
  }),
  /** Marker that starts the dialogue in the activities ("Read aloud"). */
  dialogueMarker: z.string().default('Read aloud'),
  /** `builtin:laixue1` (hand transcription in code) or a path under the book's folder. */
  grammarSource: z.string(),
  /** Names used in the dialogues that are not separate vocabulary entries. */
  extraNames: z
    .array(
      z.object({ headword: z.string(), pinyin: z.string(), glossEn: z.string(), lesson: z.number().int() }),
    )
    .default([]),
  /**
   * Function words/particles a grammar point teaches that are neither in the
   * lesson vocabulary nor in the lexicon (的話): created as textbook entries and
   * counted as the lesson's grammar words.
   */
  extraWords: z
    .array(
      z.object({
        headword: z.string(),
        pinyin: z.string(),
        glossEn: z.string(),
        pos: z.array(z.string()).default([]),
        lesson: z.number().int(),
      }),
    )
    .default([]),
  /** Human explanations of any difference between the book's stated counts and what was parsed. */
  explanations: z.array(z.string()).default([]),
});
export type BookConfig = z.infer<typeof BookConfigSchema>;
