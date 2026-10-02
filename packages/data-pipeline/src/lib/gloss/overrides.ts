import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';

/**
 * data/supplement/gloss-overrides.yaml — hand corrections. ALWAYS win over
 * generated glosses and survive rebuilds. Match by lexicon `id`, or by
 * `word` (+ optional `pinyin`). Example:
 *
 *   - word: 機車
 *     pinyin: jī chē
 *     senses:
 *       - glossEn: scooter; motorbike
 *         taiwanOnly: true
 *       - glossEn: annoying; hard to get along with
 *         register: slang
 *     note: reported by owner
 */
const OverrideSense = z.object({
  glossEn: z.string().min(1),
  noteEn: z.string().optional(),
  register: z.string().optional(),
  taiwanOnly: z.boolean().optional(),
  pos: z.string().optional(),
});

export const GlossOverrideSchema = z
  .object({
    id: z.string().optional(),
    word: z.string().optional(),
    pinyin: z.string().optional(),
    senses: z.array(OverrideSense).min(1),
    note: z.string().optional(),
  })
  .refine((o) => o.id || o.word, { message: 'override needs an id or a word' });
export type GlossOverride = z.infer<typeof GlossOverrideSchema>;

export function loadGlossOverrides(path: string): GlossOverride[] {
  if (!existsSync(path)) return [];
  const raw = yaml.load(readFileSync(path, 'utf8'));
  if (raw == null) return [];
  return z.array(GlossOverrideSchema).parse(raw);
}

export function findOverride(
  overrides: readonly GlossOverride[],
  word: { id: string; headword: string; pinyin: string },
  keyOf: (p: string) => string,
): GlossOverride | undefined {
  return (
    overrides.find((o) => o.id === word.id) ??
    overrides.find(
      (o) =>
        !o.id && o.word === word.headword && (!o.pinyin || keyOf(o.pinyin) === keyOf(word.pinyin)),
    )
  );
}
