#!/usr/bin/env tsx
/**
 * Phase 25 D: `pnpm audit:curriculum`. Checks the lexicon entries, sentences, scenario lines,
 * prompts and grammar exercises of every textbook lesson (lib/curriculum/audit.ts), writes
 * docs/curriculum-audit.md and exits non-zero on any finding. Runs in CI.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { z } from 'zod';
import { COURSE_BOOK_IDS, Lexicon, type GrammarItem, type SentenceBankEntry, type Word } from '@anan/core';
import { MoeDictionary } from './lib/moe.js';
import { AUDIT_CHECKS, renderAuditReport, runCurriculumAudit, type AuditBook, type AuditCheck, type AuditText } from './lib/curriculum/audit.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

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

function loadMoe(): MoeDictionary {
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

function main(): void {
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
  const result = runCurriculumAudit({ lexicon, books, sentences, texts, moe: loadMoe(), config });

  const naturalnessFile = path.join(REPO, 'docs/curriculum-naturalness.md');
  const naturalness = existsSync(naturalnessFile) ? readFileSync(naturalnessFile, 'utf8') : undefined;
  const date = new Date().toISOString().slice(0, 10);
  if (!process.argv.includes('--no-write'))
    writeFileSync(path.join(REPO, 'docs/curriculum-audit.md'), renderAuditReport(result, date, naturalness) + '\n', 'utf8');

  const byCheck = new Map<string, number>();
  for (const f of result.findings) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
  console.log(`Checked ${result.stats.words} words, ${result.stats.sentences} sentences, ${result.stats.texts} other lines, ${result.stats.grammarPoints} grammar points.`);
  for (const [c, n] of byCheck) console.log(`  ${c}: ${n}`);
  for (const f of result.findings.slice(0, Number(process.env.AUDIT_SHOW ?? 40))) console.log(`  - [${f.check}] ${f.where}: ${f.detail}`);
  for (const a of result.staleAllows) console.log(`  - stale allow (matches nothing): [${a.check}] ${a.where}`);
  if (result.findings.length || result.staleAllows.length) {
    console.error(`\nCurriculum audit failed: ${result.findings.length} finding(s). See docs/curriculum-audit.md.`);
    process.exit(1);
  }
  console.log('Curriculum audit passed.');
}

main();
