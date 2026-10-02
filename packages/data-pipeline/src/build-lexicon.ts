#!/usr/bin/env tsx
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { GlossAdjudicationRequest, GrammarItem, SentenceBankFile, Word } from '@anan/core';
import { LEVEL_IDS, toPinyinNumeric } from '@anan/core';
import { readdirSync } from 'node:fs';
import { AdjudicationStore, type AdjudicationRecord } from './lib/gloss/adjudicate.js';
import { buildInventory, type GlossSources, type SenseInventory } from './lib/gloss/inventory.js';
import { loadGlossOverrides } from './lib/gloss/overrides.js';
import { buildAdjudicationRequest } from './lib/gloss/request.js';
import { computeStats, renderReview, type ReviewRow } from './lib/gloss/review.js';
import { resolveGloss } from './lib/gloss/resolve.js';
import {
  loadTocflCedict,
  loadTop2011,
  loadUnihanDefinitions,
  loadWiktionary,
} from './lib/gloss/sources.js';
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

const VERSION = 'v2';

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

/** Up to two example sentences per target word, from the generated sentence
 * bank (data/build/sentences.v*.*.json) when it exists — context for the
 * adjudication prompt. */
function loadSentenceExamples(): Map<string, { zh: string; en: string }[]> {
  const out = new Map<string, { zh: string; en: string }[]>();
  if (!existsSync(BUILD_DIR)) return out;
  for (const f of readdirSync(BUILD_DIR).filter((n) =>
    /^sentences\.v\d+\.[A-Z0-9]+\.json$/.test(n),
  )) {
    const file = JSON.parse(readFileSync(path.join(BUILD_DIR, f), 'utf8')) as SentenceBankFile;
    for (const s of file.sentences) {
      const list = out.get(s.targetWordId) ?? [];
      if (list.length < 2) list.push({ zh: s.zh, en: s.en });
      out.set(s.targetWordId, list);
    }
  }
  return out;
}

function senseKeyOf(pos: string[]): string {
  return pos.length > 0 ? pos.join('+') : 'default';
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function main(): Promise<void> {
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

  // ---- Phase 7 §B: sense inventory -> adjudicated/heuristic senses -> overrides.
  console.log('Resolving glosses (CEDICT per reading + TOP 2011 + MOE + optional Wiktionary)...');
  const wiktionaryPath = path.join(RAW_DIR, 'kaikki-chinese.jsonl');
  const wiktionary = await loadWiktionary(
    wiktionaryPath,
    new Set(words.flatMap((w) => [w.headword, ...w.variants])),
  );
  const glossSources: GlossSources = {
    cedict: loadTocflCedict(path.join(RAW_DIR, 'ivankra-tocfl-cedict.csv')),
    top2011: loadTop2011(path.join(RAW_DIR, 'ivankra-top-20111208.csv')),
    moe,
    wiktionary,
  };
  const overrides = loadGlossOverrides(path.join(SUPPLEMENT_DIR, 'gloss-overrides.yaml'));
  const adjudicated = new Map<string, AdjudicationRecord>(
    new AdjudicationStore(path.join(BUILD_DIR, 'gloss-adjudication.jsonl'))
      .all()
      .map((r) => [r.wordId, r]),
  );
  const examplesByWord = loadSentenceExamples();

  const reviewRows: ReviewRow[] = [];
  for (const w of words) {
    const inventory: SenseInventory = buildInventory(w, glossSources);
    const request: GlossAdjudicationRequest = buildAdjudicationRequest(
      w,
      inventory,
      examplesByWord.get(w.id),
    );
    const resolved = resolveGloss({
      word: w,
      inventory,
      adjudication: adjudicated.get(w.id),
      request,
      overrides,
    });
    w.tags = w.tags.filter((t) => t !== 'gloss:cedict');
    w.tags.push(`gloss:${resolved.origin}`);
    if (resolved.senses.length > 0) {
      w.glossEn = resolved.glossEn;
      w.senses = resolved.senses;
      w.primarySenseId = resolved.primarySenseId;
      w.glossSources = resolved.glossSources;
    }
    if (inventory.moeDefsZh.length > 0) w.moeDefZh = inventory.moeDefsZh.slice(0, 2);
    reviewRows.push({
      word: w,
      gloss: resolved,
      topCandidates: inventory.candidates
        .filter((c) => c.glossEn && c.source !== 'top2011')
        .map((c) => c.glossEn!),
    });
  }
  const glossStats = computeStats(reviewRows);
  writeFileSync(
    path.join(BUILD_DIR, 'gloss-review.md'),
    renderReview(reviewRows, glossStats),
    'utf8',
  );
  console.log(
    `Glosses: ${JSON.stringify(glossStats.byOrigin)}; N1–L2 supported ${(glossStats.earlySupportedShare * 100).toFixed(1)}%`,
  );

  // Unihan per-character definitions for the character-breakdown leech treatment (optional source).
  const unihan = loadUnihanDefinitions(path.join(RAW_DIR, 'Unihan_Readings.txt'));
  if (unihan.size > 0) {
    const chars = new Set(words.flatMap((w) => w.chars));
    writeFileSync(
      path.join(BUILD_DIR, 'char-glosses.v1.json'),
      stableStringify(
        Object.fromEntries([...chars].filter((c) => unihan.has(c)).map((c) => [c, unihan.get(c)])),
      ),
      'utf8',
    );
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
      sourceHashes: {
        tocfl: tocflHash,
        moe: moeHash,
        supplement: supplementHash,
        cedict: sha256OfFile(path.join(RAW_DIR, 'ivankra-tocfl-cedict.csv')),
        top2011: sha256OfFile(path.join(RAW_DIR, 'ivankra-top-20111208.csv')),
      },
      wordCount: words.length,
      missingLevels: MISSING_LEVELS,
      /** Levels actually present, in learning order (levels.config). */
      levels: LEVEL_IDS.filter((l) => words.some((w) => w.level === l)),
      glossStats,
      glossSourceFiles: [
        'ivankra-tocfl-cedict.csv',
        'ivankra-top-20111208.csv',
        'dict-revised-translated.json.xz',
        ...(wiktionary.size > 0 ? ['kaikki-chinese.jsonl'] : []),
      ],
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
    report.render({
      version: VERSION,
      buildDate,
      wordCount: words.length,
      missingLevels: MISSING_LEVELS,
    }),
    'utf8',
  );

  const changelogPath = path.join(BUILD_DIR, 'CHANGELOG.md');
  const changelogEntry = `## ${VERSION} — ${buildDate}\n\n- ${words.length} words (${words.filter((w) => w.source === 'tocfl').length} TOCFL, ${words.filter((w) => w.source === 'supplement').length} supplement).\n- Content hash: \`${contentHash.slice(0, 16)}\`.\n- ${report.mismatches.length} MOE/TOCFL reading mismatches, ${report.unverified.length} unverified readings, ${report.duplicates.length} cross-level duplicates dropped. See review-report.md.\n`;
  const existingChangelog = existsSync(changelogPath)
    ? readFileSync(changelogPath, 'utf8')
    : '# Lexicon build changelog\n\n';
  if (!existingChangelog.includes(`Content hash: \`${contentHash.slice(0, 16)}\``)) {
    writeFileSync(changelogPath, existingChangelog + '\n' + changelogEntry, 'utf8');
  }

  console.log(`Wrote ${words.length} words to ${outPath}`);
  console.log(`Review report: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
