#!/usr/bin/env tsx
/**
 * Phase 48 Part D.2: `pnpm audit:distractors` (CI). Builds the Pick set for every TOCFL N1–L1 and
 * textbook word with a fixed seed and a beginner's known words; fails on an odd-one-out set, an
 * option not close to the answer, or more than 5% of words with fewer than 3 options. Writes
 * docs/distractors-audit.md (worst 50 listed).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DistractorTable, Word } from '@anan/core';
import { renderDistractorAudit, runDistractorAudit } from './lib/distractor-audit.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const lexicon = JSON.parse(readFileSync(path.join(REPO, 'data/build/lexicon.v2.json'), 'utf8')) as { words: Word[] };
const tableFile = path.join(REPO, 'data/build/distractors.v1.json');
const table = existsSync(tableFile) ? (JSON.parse(readFileSync(tableFile, 'utf8')) as DistractorTable) : undefined;
if (!table) console.warn('audit:distractors: no data/build/distractors.v1.json (pnpm build:distractors); auditing the code axes alone');
const res = runDistractorAudit(lexicon.words, table);
const owner = res.rows.filter((r) => ['平常', '冰淇淋'].includes(r.word.headword));
writeFileSync(path.join(REPO, 'docs/distractors-audit.md'), renderDistractorAudit(res, owner));
console.log(
  `Checked ${res.rows.length} words: ${res.odd.length} odd one out, ${res.far.length} not close, ${res.short.length} with fewer than 3 options (${(res.shortShare * 100).toFixed(1)}%).`,
);
for (const r of [...res.odd, ...res.far].slice(0, 20)) console.error(`  - ${r.word.headword}: ${r.problem}`);
if (!res.passed) {
  console.error('\nDistractor audit failed (docs/distractors-audit.md).');
  process.exit(1);
}
console.log('Distractor audit passed (docs/distractors-audit.md).');
