/**
 * Phase 34: `data/curriculum/<book>/extras.yaml` — the lesson extras (vocabulary found on a
 * lesson's pages outside the four parsed lists). A word list only, never page text.
 *
 * The owner edits this file: `status: drop` removes a word, `keep` (or `proposed`) imports it,
 * and a hand-written line (lesson + page + headword) adds one the scan could not read.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

export const ExtraEntrySchema = z.object({
  lesson: z.number().int().min(1),
  /** Printed page number (what the book shows at the foot of the page). */
  page: z.number().int().min(1),
  /** Page index in the PDF, when it differs from the printed number. */
  pdfPage: z.number().int().min(1).optional(),
  headword: z.string().min(1),
  pinyin: z.string().optional(),
  glossEn: z.string().optional(),
  /** Lexicon id the scan linked (informational: the import links again). */
  wordId: z.string().nullable().optional(),
  found: z.enum(['label', 'table', 'word-bank', 'image', 'hand']).optional(),
  status: z.enum(['proposed', 'keep', 'drop']).default('keep'),
});
export type ExtraEntry = z.infer<typeof ExtraEntrySchema>;

const HEADER = (bookId: string) =>
  `# Lesson extras for ${bookId} (Phase 34). Words only, no book text.\n` +
  `# Written by \`pnpm curriculum:extras ${bookId}\`; edit freely, re-runs keep your edits.\n` +
  `#   status: proposed | keep -> imported as a lesson extra by \`pnpm curriculum:import\`\n` +
  `#   status: drop            -> left out\n` +
  `# Add a word by hand with just: lesson, page, headword (pinyin and gloss come from the lexicon).\n`;

export function extrasPath(dir: string): string {
  return path.join(dir, 'extras.yaml');
}

export function loadExtras(dir: string): ExtraEntry[] {
  const file = extrasPath(dir);
  if (!existsSync(file)) return [];
  const raw = (yaml.load(readFileSync(file, 'utf8')) as unknown[] | null) ?? [];
  return raw.map((e) => ExtraEntrySchema.parse(e));
}

export function saveExtras(dir: string, bookId: string, entries: ExtraEntry[]): void {
  const sorted = [...entries].sort((a, b) => a.lesson - b.lesson || a.page - b.page);
  const clean = sorted.map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)));
  writeFileSync(extrasPath(dir), HEADER(bookId) + yaml.dump(clean, { lineWidth: 120 }), 'utf8');
}

/** Merge fresh scan results into the owner's file: existing lines (and their status) win. */
export function mergeExtras(existing: ExtraEntry[], fresh: ExtraEntry[]): { merged: ExtraEntry[]; added: ExtraEntry[] } {
  const key = (e: ExtraEntry) => `${e.lesson}|${e.headword}`;
  const have = new Set(existing.map(key));
  const added = fresh.filter((e) => !have.has(key(e)));
  return { merged: [...existing, ...added], added };
}

/** Entries the import teaches: not dropped. */
export function activeExtras(entries: ExtraEntry[]): ExtraEntry[] {
  return entries.filter((e) => e.status !== 'drop');
}
