/**
 * Phase 25 C: re-derive the readings of every MOE-composed lexicon entry with the fixed
 * `resolveMoeReading` (positional heteronym pick) and apply data/supplement/lexicon-overrides.yaml,
 * without a full lexicon rebuild (a rebuild without the git-ignored Wiktionary dump changes
 * thousands of glosses). The next full `build:lexicon` does the same by itself.
 * Usage: tsx src/patch-lexicon-readings.ts [--write]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPinyinNumeric, type Word } from '@anan/core';
import { MoeDictionary, resolveMoeReading } from './lib/moe.js';
import { loadSupplementYaml } from './lib/supplement.js';
import { applyLexiconOverrides, loadLexiconOverrides } from './lib/lexicon-overrides.js';
import { normalizeRow } from './lib/normalize.js';
import { readTocflWorkbook } from './lib/tocfl-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const LEX = path.join(ROOT, 'data/build/lexicon.v2.json');
const moe = MoeDictionary.loadFromJsonFile(path.join(ROOT, 'data/raw/.cache/dict-revised-translated.json'));

const hints = new Map<string, string[]>(); // source|headword -> hint pinyins
const add = (source: string, h: string, p: string) => {
  const k = `${source}|${h}`;
  hints.set(k, [...(hints.get(k) ?? []), p]);
};
for (const row of readTocflWorkbook(path.join(ROOT, 'data/raw/tocfl-words.xlsx')))
  for (const s of normalizeRow(row.headwordRaw, row.pinyinRaw, row.posRaw, [])) add('tocfl', s.headword, s.pinyin);
for (const e of loadSupplementYaml(path.join(ROOT, 'data/supplement/particles-fillers.yaml'))) add('supplement', e.headword, e.pinyin);
for (const b of ['laixue-1', 'laixue-2', 'laixue-3', 'laixue-4'])
  for (const e of loadSupplementYaml(path.join(ROOT, `data/supplement/textbook-${b}.yaml`))) add('textbook', e.headword, e.pinyin);

const toneless = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zü]/gi, '').toLowerCase();
const lex = JSON.parse(readFileSync(LEX, 'utf8')) as { words: Word[]; charIndex: Record<string, string[]> };
const changes: string[] = [];
let ambiguous = 0;
for (const w of lex.words) {
  if (!w.tags.includes('reading:composed')) continue;
  const cands = [...new Set(hints.get(`${w.source}|${w.headword}`) ?? [])];
  if (cands.length === 0) continue;
  const results = cands.map((h) => ({ h, r: resolveMoeReading(moe, w.headword, h) }));
  let pick = results.length === 1 ? results[0] : results.find((x) => toneless(x.h) === toneless(w.pinyin));
  if (!pick) pick = results.find((x) => toneless(x.r.pinyin) === toneless(w.pinyin));
  if (!pick) { ambiguous++; console.warn(`ambiguous ${w.id} ${w.headword} ${w.pinyin} ${cands.join(' / ')}`); continue; }
  const p = pick.r.pinyin || pick.h;
  if (p !== w.pinyin || (pick.r.zhuyin && pick.r.zhuyin !== w.zhuyin)) {
    changes.push(`${w.id}\t${w.headword}\t${w.pinyin} → ${p}\t${w.zhuyin} → ${pick.r.zhuyin}`);
    w.pinyin = p;
    w.pinyinNumeric = toPinyinNumeric(p || '?');
    if (pick.r.zhuyin) w.zhuyin = pick.r.zhuyin;
  }
}
for (const w of lex.words) w.pinyinNumeric = toPinyinNumeric(w.pinyin || '?');
const overridden = applyLexiconOverrides(lex.words, loadLexiconOverrides(path.join(ROOT, 'data/supplement/lexicon-overrides.yaml')));
for (const id of overridden) {
  const w = lex.words.find((x) => x.id === id)!;
  w.pinyinNumeric = toPinyinNumeric(w.pinyin || '?');
  changes.push(`${id}\t${w.headword}\toverride → ${w.pinyin}`);
}
console.log(changes.join('\n'));
console.log(`${changes.length} changed, ${ambiguous} ambiguous`);
if (process.argv.includes('--write')) {
  // the character index follows the (possibly changed) headwords, as build-lexicon writes it
  const charIndex: Record<string, string[]> = {};
  for (const w of lex.words) for (const ch of w.chars) (charIndex[ch] ??= []).push(w.id);
  lex.charIndex = charIndex;
  const out = JSON.stringify(lex, null, 2);
  writeFileSync(LEX, out);
  writeFileSync(`${LEX}.gz`, gzipSync(out, { level: 9 }));
}
