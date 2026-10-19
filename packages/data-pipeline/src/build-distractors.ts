#!/usr/bin/env tsx
/**
 * Phase 48 Part A: `pnpm build:distractors` writes data/build/distractors.v1.json: for every word
 * that can be studied (TOCFL N1–L3, textbook words with lesson extras, custom words), up to 8
 * candidate distractors with the axes they are close on (char, shape, sound, meaning; `suggest` =
 * a checked Gemini suggestion from data/build/distractor-suggestions.v1.json). The web app ships it
 * hashed as lexicon/distractors.v1.json (`pnpm --filter @anan/web sync:lexicon`).
 *
 *   pnpm build:distractors                 # code-only axes (+ cached suggestions), no AI
 *   pnpm build:distractors --suggest       # first ask Gemini for meaning neighbours (free tier,
 *                                          # batch reserve, resumable; --max-calls N, --status, --model M)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDistractorTable, type DistractorSuggestions, type Word } from '@anan/core';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const LEXICON = path.join(REPO, 'data/build/lexicon.v2.json');
const SUGGESTIONS = path.join(REPO, 'data/build/distractor-suggestions.v1.json');
const OUT = path.join(REPO, 'data/build/distractors.v1.json');

if (argv.includes('--suggest') || argv.includes('--status')) {
  // the Gemini pass lives with the proxy (its model chain and quota tracker)
  const pass = argv.filter((a) => a !== '--suggest');
  const r = spawnSync('pnpm', ['--filter', '@anan/proxy', 'distractors:suggest', ...pass], { cwd: REPO, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  if (argv.includes('--status')) process.exit(0);
}

const lexicon = JSON.parse(readFileSync(LEXICON, 'utf8')) as { words: Word[] };
const suggestions = existsSync(SUGGESTIONS) ? (JSON.parse(readFileSync(SUGGESTIONS, 'utf8')) as DistractorSuggestions) : undefined;
const table = buildDistractorTable(lexicon.words, suggestions ? { suggestions } : {});
// one line per word: a small diff when the lexicon changes
const body = Object.entries(table.words)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([id, c]) => `${JSON.stringify(id)}:${JSON.stringify(c)}`)
  .join(',\n');
writeFileSync(OUT, `{"version":1,"words":{\n${body}\n}}\n`);
const n = Object.keys(table.words).length;
const sug = Object.values(table.words).reduce((k, c) => k + c.filter(([, a]) => a.includes('suggest')).length, 0);
console.log(`distractors: ${n} words -> data/build/distractors.v1.json (${sug} checked Gemini suggestions used)`);
