#!/usr/bin/env tsx
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { GrammarItem, Word } from '@anan/core';
import { toPinyinNumeric } from '@anan/core';
import { normalizeRow } from './lib/normalize.js';
import { resolveId, type IdMap } from './lib/ids.js';
import { MoeDictionary, resolveMoeReading } from './lib/moe.js';
import { ReviewReport } from './lib/review-report.js';
import { loadSupplementYaml } from './lib/supplement.js';
import { MISSING_LEVELS, readTocflWorkbook } from './lib/tocfl-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const RAW_DIR = path.join(REPO_ROOT, 'data/raw');
const CACHE_DIR = path.join(RAW_DIR, '.cache');
const SUPPLEMENT_DIR = path.join(REPO_ROOT, 'data/supplement');
const BUILD_DIR = path.join(REPO_ROOT, 'data/build');

const VERSION = 'v1';

function sha256OfFile(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function loadMoeCached(): MoeDictionary {
  mkdirSync(CACHE_DIR, { recursive: true });
  const xzPath = path.join(RAW_DIR, 'dict-revised-translated.json.xz');
  const cachePath = path.join(CACHE_DIR, 'dict-revised-translated.json');
  if (!existsSync(cachePath)) {
    console.log('Decompressing MOE dictionary (one-time, cached under data/raw/.cache)...');
    const json = execFileSync('unxz', ['-c', xzPath], { maxBuffer: 1024 * 1024 * 1024 });
    writeFileSync(cachePath, json);
  }
  return MoeDictionary.loadFromJsonFile(cachePath);
}

function senseKeyOf(pos: string[]): string {
  return pos.length > 0 ? pos.join('+') : 'default';
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function main(): void {
  mkdirSync(BUILD_DIR, { recursive: true });

  const report = new ReviewReport();

  console.log('Loading MOE dictionary...');
  const moe = loadMoeCached();
  console.log(`MOE dictionary: ${moe.size} titles.`);

  const idMapPath = path.join(BUILD_DIR, 'id-map.json');
  const idMap: IdMap = existsSync(idMapPath) ? JSON.parse(readFileSync(idMapPath, 'utf8')) : {};

  console.log('Reading TOCFL workbook...');
  const tocflRows = readTocflWorkbook(path.join(RAW_DIR, 'tocfl-words.xlsx'));
  console.log(`TOCFL rows: ${tocflRows.length}`);

  const words: Word[] = [];
  // dedupe key: headword|pinyin(normalized)|pos -> {level, index in words[]}
  const seen = new Map<string, { level: string; index: number }>();

  for (const row of tocflRows) {
    const senses = normalizeRow(row.headwordRaw, row.pinyinRaw, row.posRaw, report.normalizeNotes);
    for (const sense of senses) {
      const resolved = resolveMoeReading(moe, sense.headword, sense.pinyin);
      if (resolved.mismatch) {
        report.mismatches.push({
          headword: sense.headword,
          level: row.level,
          tocflPinyin: resolved.mismatch.tocflPinyin,
          moePinyin: resolved.mismatch.moePinyin,
        });
      }
      if (resolved.source === 'tocfl-unverified') {
        report.unverified.push({
          headword: sense.headword,
          level: row.level,
          reason: 'no MOE entry for this word or any of its individual characters',
        });
      }

      const gloss = moe.gloss(sense.headword);
      const wordTags: string[] = [];
      if (gloss) wordTags.push('gloss:cedict');
      else report.missingGloss.push(sense.headword);
      if (resolved.source === 'moe-composed') wordTags.push('reading:composed');
      if (resolved.source === 'zhuyin-derived') wordTags.push('zhuyin:derived');
      if (resolved.source === 'tocfl-unverified') wordTags.push('reading:unverified');

      const dedupeKey = `${sense.headword}|${resolved.pinyin}|${senseKeyOf(sense.pos)}`;
      const already = seen.get(dedupeKey);
      if (already) {
        report.duplicates.push({
          headword: sense.headword,
          pinyin: resolved.pinyin,
          pos: senseKeyOf(sense.pos),
          keptLevel: already.level,
          droppedLevel: row.level,
        });
        continue;
      }

      const id = resolveId(idMap, 'tocfl', sense.headword, resolved.pinyin, senseKeyOf(sense.pos));
      const word: Word = {
        id,
        headword: sense.headword,
        variants: sense.variants,
        pos: sense.pos,
        level: row.level,
        source: 'tocfl',
        pinyin: resolved.pinyin,
        pinyinNumeric: '', // filled below (needs @anan/core's toPinyinNumeric)
        zhuyin: resolved.zhuyin,
        glossEn: gloss ?? '',
        chars: [...sense.headword],
        tags: wordTags,
      };
      seen.set(dedupeKey, { level: row.level, index: words.length });
      words.push(word);
    }
  }

  console.log('Loading supplement entries...');
  const supplementEntries = loadSupplementYaml(path.join(SUPPLEMENT_DIR, 'particles-fillers.yaml'));
  for (const entry of supplementEntries) {
    const resolved = resolveMoeReading(moe, entry.headword, entry.pinyin);
    if (resolved.mismatch) {
      report.mismatches.push({
        headword: entry.headword,
        level: 'supplement',
        tocflPinyin: resolved.mismatch.tocflPinyin,
        moePinyin: resolved.mismatch.moePinyin,
      });
    }
    const wordTags = [...entry.tags];
    if (resolved.source === 'moe-composed') wordTags.push('reading:composed');
    if (resolved.source === 'zhuyin-derived') wordTags.push('zhuyin:derived');
    if (resolved.source === 'tocfl-unverified') wordTags.push('reading:unverified');

    const senseKey = entry.senseNote ?? senseKeyOf(entry.pos);
    const id = resolveId(idMap, 'supp', entry.headword, resolved.pinyin, senseKey);
    words.push({
      id,
      headword: entry.headword,
      variants: entry.variants,
      pos: entry.pos,
      level: entry.level,
      source: 'supplement',
      pinyin: resolved.pinyin || entry.pinyin,
      pinyinNumeric: '',
      zhuyin: resolved.zhuyin,
      glossEn: entry.glossEn,
      senseNote: entry.senseNote,
      chars: [...entry.headword],
      tags: wordTags,
    });
  }

  // Fill pinyinNumeric now that every Word's final pinyin is settled.
  for (const w of words) w.pinyinNumeric = toPinyinNumeric(w.pinyin || '?');

  words.sort((a, b) => a.id.localeCompare(b.id));

  const charIndex: Record<string, string[]> = {};
  for (const w of words) {
    for (const ch of w.chars) {
      (charIndex[ch] ??= []).push(w.id);
    }
  }

  const grammar: GrammarItem[] = [];

  const tocflHash = sha256OfFile(path.join(RAW_DIR, 'tocfl-words.xlsx'));
  const moeHash = sha256OfFile(path.join(RAW_DIR, 'dict-revised-translated.json.xz'));
  const supplementHash = sha256OfFile(path.join(SUPPLEMENT_DIR, 'particles-fillers.yaml'));

  const contentForHash = stableStringify({ words, grammar, charIndex });
  const contentHash = createHash('sha256').update(contentForHash).digest('hex');

  const outPath = path.join(BUILD_DIR, `lexicon.${VERSION}.json`);
  let buildDate = new Date().toISOString().slice(0, 10);
  if (existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf8'));
      if (prev?.meta?.contentHash === contentHash) buildDate = prev.meta.buildDate;
    } catch {
      /* ignore unreadable previous build, just use today */
    }
  }

  const lexiconOut = {
    meta: {
      version: VERSION,
      buildDate,
      contentHash,
      sourceHashes: { tocfl: tocflHash, moe: moeHash, supplement: supplementHash },
      wordCount: words.length,
      missingLevels: MISSING_LEVELS,
    },
    words,
    grammar,
    charIndex,
  };

  const json = stableStringify(lexiconOut);
  writeFileSync(outPath, json, 'utf8');
  writeFileSync(`${outPath}.gz`, gzipSync(Buffer.from(json, 'utf8')));
  writeFileSync(idMapPath, stableStringify(idMap), 'utf8');

  const migrationMapPath = path.join(BUILD_DIR, 'id-migration-map.json');
  if (!existsSync(migrationMapPath)) {
    writeFileSync(
      migrationMapPath,
      stableStringify({
        _comment:
          'old id -> new id, populated by hand when a future rebuild merges/renames entries. Empty for v1 (initial import).',
      }),
      'utf8',
    );
  }

  const reportPath = path.join(BUILD_DIR, 'review-report.md');
  writeFileSync(
    reportPath,
    report.render({ version: VERSION, buildDate, wordCount: words.length, missingLevels: MISSING_LEVELS }),
    'utf8',
  );

  const changelogPath = path.join(BUILD_DIR, 'CHANGELOG.md');
  const changelogEntry = `## ${VERSION} — ${buildDate}\n\n- ${words.length} words (${words.filter((w) => w.source === 'tocfl').length} TOCFL, ${words.filter((w) => w.source === 'supplement').length} supplement).\n- Content hash: \`${contentHash.slice(0, 16)}\`.\n- ${report.mismatches.length} MOE/TOCFL reading mismatches, ${report.unverified.length} unverified readings, ${report.duplicates.length} cross-level duplicates dropped. See review-report.md.\n`;
  const existingChangelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '# Lexicon build changelog\n\n';
  if (!existingChangelog.includes(`Content hash: \`${contentHash.slice(0, 16)}\``)) {
    writeFileSync(changelogPath, existingChangelog + '\n' + changelogEntry, 'utf8');
  }

  console.log(`Wrote ${words.length} words to ${outPath}`);
  console.log(`Review report: ${reportPath}`);
}

main();
