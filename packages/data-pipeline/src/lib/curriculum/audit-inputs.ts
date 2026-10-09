import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { COURSE_BOOK_IDS, Lexicon, type GrammarItem, type SentenceBankEntry, type Word } from '@anan/core';
import { MoeDictionary } from '../moe.js';
import { AUDIT_CHECKS, type AuditBook, type AuditCheck, type AuditInputs, type AuditText } from './audit.js';

const ConfigSchema = z.object({
  allowedLatin: z.array(z.string()).default([]),
  detect: z.record(z.string()).default({}),
  allow: z
    .array(
      z.object({
        check: z.enum(Object.keys(AUDIT_CHECKS) as [AuditCheck, ...AuditCheck[]]),
        where: z.string(),
        reason: z.string().min(10),
      }),
    )
    .default([]),
});

function loadMoe(REPO: string): MoeDictionary {
  const cache = path.join(REPO, 'data/raw/.cache/dict-revised-translated.json');
  if (existsSync(cache)) return MoeDictionary.loadFromJsonFile(cache);
  return MoeDictionary.loadFromXz(path.join(REPO, 'data/raw/dict-revised-translated.json.xz'));
}

const ContentSchema = z.object({
  lesson: z.number(),
  scenarios: z.array(
    z.object({ slug: z.string(), opener: z.object({ zh: z.string() }), successLine: z.object({ zh: z.string() }) }).passthrough(),
  ),
}).passthrough();

/** Everything the curriculum audit reads, from the repo's built data. */
export function loadAuditInputs(REPO: string): AuditInputs {
  const lexRaw = JSON.parse(readFileSync(path.join(REPO, 'data/build/lexicon.v2.json'), 'utf8')) as { words: Word[]; grammar: GrammarItem[] };
  const lexicon = new Lexicon(lexRaw.words, lexRaw.grammar);
  const books: AuditBook[] = [];
  const sentences: SentenceBankEntry[] = [];
  const texts: AuditText[] = [];
  for (const bookId of COURSE_BOOK_IDS) {
    const dir = path.join(REPO, 'data/curriculum', bookId);
    if (!existsSync(path.join(dir, 'book.json'))) continue;
    books.push(JSON.parse(readFileSync(path.join(dir, 'book.json'), 'utf8')) as AuditBook);
    const bank = path.join(REPO, 'data/build', `sentences.textbook-${bookId}.json`);
    if (existsSync(bank)) sentences.push(...(JSON.parse(readFileSync(bank, 'utf8')) as { sentences: SentenceBankEntry[] }).sentences);
    const contentDir = path.join(dir, 'content');
    if (!existsSync(contentDir)) continue;
    for (const f of readdirSync(contentDir).filter((x) => /^L\d\d\.yaml$/.test(x)).sort()) {
      const c = ContentSchema.parse(yaml.load(readFileSync(path.join(contentDir, f), 'utf8')));
      for (const sc of c.scenarios) {
        const where = `${bookId} L${c.lesson} ${sc.slug}`;
        texts.push({ bookId, lesson: c.lesson, where: `${where} opener`, zh: sc.opener.zh });
        texts.push({ bookId, lesson: c.lesson, where: `${where} success line`, zh: sc.successLine.zh });
      }
    }
  }
  const config = ConfigSchema.parse(yaml.load(readFileSync(path.join(REPO, 'data/curriculum/audit-config.yaml'), 'utf8')) ?? {});
  return { lexicon, books, sentences, texts, moe: loadMoe(REPO), config };
}
