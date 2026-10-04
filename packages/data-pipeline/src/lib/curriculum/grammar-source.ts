import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { LAIXUE1_GRAMMAR, type BookGrammarPoint } from './grammar-points.js';

const GrammarPointSchema = z.object({
  id: z.string().regex(/^gram-[a-z0-9-]+$/),
  lesson: z.number().int().min(1),
  /** The book's own numbering inside the lesson (1-based). */
  n: z.number().int().min(1),
  pdfPage: z.number().int().default(0),
  pattern: z.string().min(1),
  explanationEn: z.string().min(20),
  /** Regex source: which Chinese sentences exercise the pattern. */
  matcher: z.string(),
  words: z.array(z.string()).optional(),
  focus: z.array(z.string()).default([]),
  /**
   * The book teaches this pattern again (or a second sense of it) after an
   * earlier book already did. The course keeps ONE item: it must name an id
   * defined in an earlier book, and only adds this lesson's tag to it.
   */
  reteaches: z.boolean().default(false),
});
export const GrammarFileSchema = z.array(GrammarPointSchema);
export type GrammarFilePoint = z.infer<typeof GrammarPointSchema>;

/** Loads a book's grammar table: `builtin:laixue1` (in code) or a YAML file next to the config. */
export function loadBookGrammar(
  source: string,
  bookDir: string,
): Array<BookGrammarPoint & { reteaches?: boolean }> {
  if (source === 'builtin:laixue1') return LAIXUE1_GRAMMAR;
  const file = path.join(bookDir, source);
  if (!existsSync(file)) throw new Error(`Grammar table not found: ${file}`);
  const pts = GrammarFileSchema.parse(yaml.load(readFileSync(file, 'utf8')));
  const ids = new Set<string>();
  for (const p of pts) {
    if (ids.has(p.id)) throw new Error(`Duplicate grammar id ${p.id} in ${file}`);
    ids.add(p.id);
    new RegExp(p.matcher, 'u'); // throws on a bad regex
  }
  return pts;
}
