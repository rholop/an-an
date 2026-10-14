/**
 * Phase 40 Part A: `pnpm pipeline:levels` fills `estimatedLevel` in the built lexicon without a full
 * rebuild (a rebuild without the git-ignored Wiktionary dump changes thousands of glosses) and writes
 * docs/level-estimates.md. `build:lexicon` runs the same step on every build.
 * Usage: tsx src/estimate-levels.ts [--check]   (--check: report only, don't write the lexicon)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Word } from '@anan/core';
import { applyLevelEstimates, loadTbcl, renderLevelReport } from './lib/level-estimates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const LEX = path.join(ROOT, 'data/build/lexicon.v2.json');

const lex = JSON.parse(readFileSync(LEX, 'utf8')) as {
  meta: { contentHash: string };
  words: Word[];
  grammar: unknown[];
  charIndex: unknown;
};
const tbcl = loadTbcl(path.join(ROOT, 'data/raw'));
const stats = applyLevelEstimates(lex.words, tbcl);
console.log(
  `levels: ${stats.official} official, ${stats.bySource.tbcl} TBCL, ${stats.bySource.chars} from characters, ${stats.none} none${tbcl ? '' : ' (no TBCL file in data/raw)'}`,
);
writeFileSync(path.join(ROOT, 'docs/level-estimates.md'), renderLevelReport(stats, lex.words), 'utf8');
if (!process.argv.includes('--check')) {
  lex.meta.contentHash = createHash('sha256')
    .update(JSON.stringify({ words: lex.words, grammar: lex.grammar, charIndex: lex.charIndex }, null, 2))
    .digest('hex');
  const out = JSON.stringify(lex, null, 2);
  writeFileSync(LEX, out, 'utf8');
  writeFileSync(`${LEX}.gz`, gzipSync(Buffer.from(out, 'utf8')));
  console.log('Wrote data/build/lexicon.v2.json and docs/level-estimates.md');
}
