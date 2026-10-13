/**
 * Phase 39: add data/supplement/grammar-supplement.yaml's general grammar points to the built
 * lexicon without a full rebuild (a rebuild without the git-ignored Wiktionary dump changes
 * thousands of glosses). The next full `build:lexicon` merges them by itself (mergeGrammar).
 * Usage: tsx src/patch-lexicon-grammar.ts [--write]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GrammarItem } from '@anan/core';
import { loadGrammarSupplementYaml } from './lib/supplement.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const LEX = path.join(ROOT, 'data/build/lexicon.v2.json');

const lex = JSON.parse(readFileSync(LEX, 'utf8')) as {
  meta: { contentHash: string };
  words: unknown[];
  grammar: GrammarItem[];
  charIndex: unknown;
};
const textbook = lex.grammar.filter((g) => !(g.tags ?? []).includes('supplement'));
const supplement: GrammarItem[] = loadGrammarSupplementYaml(path.join(ROOT, 'data/supplement/grammar-supplement.yaml')).map(
  (g) => ({ ...g, examples: [], tags: ['supplement'] }),
);
for (const g of supplement)
  if (textbook.some((t) => t.id === g.id)) throw new Error(`Grammar id ${g.id} is in grammar-supplement.yaml and a textbook`);
lex.grammar = [...textbook, ...supplement];
console.log(`${supplement.length} supplement grammar points: ${supplement.map((g) => g.id).join(', ')}`);
if (process.argv.includes('--write')) {
  // the same content hash build-lexicon writes
  lex.meta.contentHash = createHash('sha256')
    .update(JSON.stringify({ words: lex.words, grammar: lex.grammar, charIndex: lex.charIndex }, null, 2))
    .digest('hex');
  const out = JSON.stringify(lex, null, 2);
  writeFileSync(LEX, out, 'utf8');
  writeFileSync(`${LEX}.gz`, gzipSync(Buffer.from(out, 'utf8')));
}
