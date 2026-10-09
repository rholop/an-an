import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import { pinyinToZhuyin, type Word } from '@anan/core';

/**
 * Phase 25 C: hand fixes to lexicon entries that no source gets right (data/supplement/lexicon-overrides.yaml).
 * Applied at the end of the lexicon build, after readings and glosses are resolved, so a rebuild
 * keeps them. Each fix names an entry by id (one entry) or by headword (every entry with it).
 */
const OverrideSchema = z
  .object({
    id: z.string().optional(),
    headword: z.string().optional(),
    set: z.object({
      headword: z.string().optional(),
      variants: z.array(z.string()).optional(),
      pinyin: z.string().optional(),
      glossEn: z.string().optional(),
      addTags: z.array(z.string()).optional(),
    }),
    reason: z.string().min(10),
  })
  .refine((o) => !!o.id !== !!o.headword, 'give exactly one of id / headword');
export type LexiconOverride = z.infer<typeof OverrideSchema>;

export function loadLexiconOverrides(file: string): LexiconOverride[] {
  return z.array(OverrideSchema).parse(yaml.load(readFileSync(file, 'utf8')) ?? []);
}

type MutableWord = Word & { senses?: Array<{ id?: string; glossEn: string }>; textbookSenseId?: string; primarySenseId?: string };

/** Applies the fixes in place; returns the ids changed. Throws on a fix that matches nothing. */
export function applyLexiconOverrides(words: Word[], overrides: readonly LexiconOverride[]): string[] {
  const changed: string[] = [];
  for (const o of overrides) {
    const hits = words.filter((w) => (o.id ? w.id === o.id : w.headword === o.headword)) as MutableWord[];
    if (hits.length === 0) throw new Error(`lexicon override matches no entry: ${o.id ?? o.headword}`);
    for (const w of hits) {
      const s = o.set;
      if (s.headword !== undefined) {
        w.headword = s.headword;
        w.chars = [...s.headword];
      }
      if (s.variants !== undefined) w.variants = [...s.variants];
      if (s.pinyin !== undefined) {
        w.pinyin = s.pinyin;
        w.zhuyin = pinyinToZhuyin(s.pinyin);
        w.tags = w.tags.filter((t) => !t.startsWith('reading:') && t !== 'zhuyin:derived');
        w.tags.push('reading:override');
      }
      if (s.glossEn !== undefined) {
        w.glossEn = s.glossEn;
        const senseId = w.textbookSenseId ?? w.primarySenseId;
        const sense = w.senses?.find((x) => x.id === senseId) ?? (w.senses?.length === 1 ? w.senses[0] : undefined);
        if (sense) sense.glossEn = s.glossEn;
      }
      for (const t of s.addTags ?? []) if (!w.tags.includes(t)) w.tags.push(t);
      changed.push(w.id);
    }
  }
  return changed;
}
