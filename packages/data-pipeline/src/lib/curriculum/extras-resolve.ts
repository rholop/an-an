/**
 * Phase 34: turn one `extras.yaml` line into a lesson extra: link it to the lexicon (same reading
 * and sense rules as the import), or create a textbook entry, and skip anything that is already a
 * core word, a name, or a repeat. Shared by the full import and `--extras-only`.
 */
import type { Lexicon, Level } from '@anan/core';
import { textbookTag, lessonTag } from '@anan/core';
import { stableId } from '../ids.js';
import type { ExtraEntry } from './extras-file.js';
import { linkBookWord, pinyinOptions } from './link.js';
import type { BookWord } from './vocab-parse.js';

export interface ExtraNote {
  wordId: string;
  lesson: number;
  page: number;
  headword: string;
  pinyin: string;
  glossEn: string;
}

export interface ResolveCtx {
  lexicon: Lexicon;
  /** `headword|pinyin` → id of entries an earlier book created. */
  prior: ReadonlyMap<string, string>;
  bookId: string;
  level: Level;
  /** Ids already core (or supplementary / proper) in this lesson or an earlier one, or core of an earlier book. */
  coreIds: ReadonlySet<string>;
  /** Ids already taken as an extra of this lesson. */
  taken: ReadonlySet<string>;
}

export type Resolved =
  | { ok: false; reason: string }
  | { ok: true; id: string; note: ExtraNote; created?: { key: string; entry: Record<string, unknown>; message: string } };

export function resolveExtra(e: ExtraEntry, ctx: ResolveCtx): Resolved {
  const base = ctx.lexicon.lookup(e.headword).find((x) => x.source !== 'textbook');
  const pinyin = e.pinyin || base?.pinyin;
  const glossEn = e.glossEn || base?.glossEn;
  if (!pinyin || !glossEn)
    return { ok: false, reason: `L${e.lesson} extra ${e.headword} (p${e.page}) has no pinyin/gloss and is not in the lexicon: add them to extras.yaml` };
  const bw: BookWord = { lesson: e.lesson, n: 0, section: 'supplementary', headword: e.headword, variants: [], pinyin, pos: [], glossEn };
  const link = linkBookWord(bw, ctx.lexicon);
  if (link.word?.tags.includes('name')) return { ok: false, reason: `L${e.lesson} extra ${e.headword} is a name` };
  const hint = pinyinOptions(pinyin)[0] ?? pinyin;
  const key = `${e.headword}|${hint}`;
  const id = link.word?.id ?? ctx.prior.get(key) ?? stableId('tb', e.headword, hint, ctx.bookId);
  if (ctx.coreIds.has(id) || ctx.taken.has(id))
    return { ok: false, reason: `L${e.lesson} extra ${e.headword} (p${e.page}) is already a core or earlier word and was left out` };
  const note: ExtraNote = {
    wordId: id,
    lesson: e.lesson,
    page: e.page,
    headword: link.word?.headword ?? e.headword,
    pinyin: pinyin.replace(/ /g, ''),
    glossEn,
  };
  if (link.word || ctx.prior.has(key)) return { ok: true, id, note };
  return {
    ok: true,
    id,
    note,
    created: {
      key,
      message: `L${e.lesson} extra ${e.headword} (${pinyin}) "${glossEn}" → new textbook entry ${id}`,
      entry: {
        headword: e.headword,
        variants: [],
        pos: [],
        level: ctx.level,
        pinyin: hint,
        glossEn,
        tags: [textbookTag(ctx.bookId), lessonTag(e.lesson, ctx.bookId)],
      },
    },
  };
}
