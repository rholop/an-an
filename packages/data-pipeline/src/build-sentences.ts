#!/usr/bin/env tsx
// Phase 4 §1 sentence bank: for each N1-L2 word, generate example sentences
// via apps/proxy's POST /v1/sentences, validate with analyzeClozeCoverage
// (drop failures), flag doubtful ones (rules-based naturalness pass), write
// sentences.v1.<level>.json (lazy-loadable per level) and a spot-check
// sample. Needs a running proxy with a real API key to generate for real —
// run with `--fake` for a dry run of this script's own machinery (see
// lib/sentence-gen-client.ts's header comment for exactly what that proves
// and doesn't).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeClozeCoverage,
  Lexicon,
  SentenceBankFileSchema,
  type Level,
  type SentenceBankEntry,
  type SentenceGenRequest,
} from '@anan/core';
import {
  buildAnalyzeContext,
  isDoubtful,
  sampleAllowedVocab,
  shuffle,
} from './lib/sentence-bank.js';
import {
  createFakeSentenceGenClient,
  createHttpSentenceGenClient,
  type SentenceGenClient,
} from './lib/sentence-gen-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

// "Start with N1-L2 only; add levels later" (phase doc §1).
const LEVELS: Level[] = ['N1', 'N2', 'L1', 'L2'];
const SENTENCES_PER_WORD = 5;
const ALLOWED_VOCAB_SAMPLE_SIZE = 40;
// Always included in a word's allowedVocab when present at/below its level
// — matches lib/sentence-gen-client.ts's fake templates, so --fake runs
// validate for real rather than trivially.
const CORE_FILLERS = [
  '我',
  '你',
  '他',
  '很',
  '好',
  '去',
  '了',
  '喜歡',
  '的',
  '是',
  '不',
  '在',
  '有',
  '也',
  '要',
];

const FAKE = process.argv.includes('--fake');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT_PER_LEVEL = limitArg ? Number(limitArg.split('=')[1]) : undefined;
const proxyUrlArg = process.argv.find((a) => a.startsWith('--proxy-url='));
const PROXY_URL = proxyUrlArg
  ? proxyUrlArg.slice('--proxy-url='.length)
  : (process.env.ANAN_PROXY_URL ?? 'http://localhost:3002');

function loadLexicon(): Lexicon {
  const srcPath = path.join(REPO_ROOT, 'data/build/lexicon.v2.json');
  if (!existsSync(srcPath)) {
    console.error(
      `build-sentences: ${srcPath} doesn't exist yet — run "pnpm pipeline:build" first.`,
    );
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(srcPath, 'utf8'));
  return new Lexicon(raw.words, raw.grammar);
}

interface GenerateForLevelResult {
  entries: SentenceBankEntry[];
  wordsAttempted: number;
  wordsWithEnough: number;
}

async function generateForLevel(
  level: Level,
  lexicon: Lexicon,
  client: SentenceGenClient,
  rng: () => number,
): Promise<GenerateForLevelResult> {
  const atOrBelowLevels = LEVELS.slice(0, LEVELS.indexOf(level) + 1);
  const pool = lexicon.allWords().filter((w) => w.level && atOrBelowLevels.includes(w.level));
  const levelWords = lexicon.allWords().filter((w) => w.level === level);
  const words = LIMIT_PER_LEVEL ? levelWords.slice(0, LIMIT_PER_LEVEL) : levelWords;

  const entries: SentenceBankEntry[] = [];
  let wordsWithEnough = 0;

  for (const word of words) {
    const allowedVocab = sampleAllowedVocab(
      word,
      pool,
      CORE_FILLERS,
      ALLOWED_VOCAB_SAMPLE_SIZE,
      rng,
    );
    const allowedVocabIds = new Set(
      allowedVocab.flatMap((hw) => lexicon.lookup(hw).map((w) => w.id)),
    );

    const req: SentenceGenRequest = {
      word: { headword: word.headword, pinyin: word.pinyin, level, glossEn: word.glossEn },
      allowedVocab,
      count: SENTENCES_PER_WORD,
    };

    let response;
    try {
      response = await client.generate(req);
    } catch (err) {
      console.error(
        `  [${word.headword}] generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const ctx = buildAnalyzeContext(word, lexicon, allowedVocabIds);
    const seenZh = new Set<string>();
    let kept = 0;
    response.sentences.forEach((candidate, i) => {
      if (seenZh.has(candidate.zh)) return; // dedupe
      if (!analyzeClozeCoverage(candidate.zh, ctx, word.id).pass) return; // drop failures
      seenZh.add(candidate.zh);
      entries.push({
        id: `${word.id}-s${i}`,
        zh: candidate.zh,
        en: candidate.en,
        targetWordId: word.id,
        level,
        tokens: candidate.tokens,
        source: 'generated',
        doubtful: isDoubtful(candidate.zh),
      });
      kept++;
    });
    if (kept >= 3) wordsWithEnough++;
  }

  return { entries, wordsAttempted: words.length, wordsWithEnough };
}

function writeBankFile(level: Level, entries: SentenceBankEntry[]): void {
  const outPath = path.join(REPO_ROOT, 'data/build', `sentences.v1.${level}.json`);
  const file = {
    meta: { version: 'v1', buildDate: new Date().toISOString().slice(0, 10), level },
    sentences: entries,
  };
  SentenceBankFileSchema.parse(file); // self-check the shape before writing
  writeFileSync(outPath, JSON.stringify(file, null, 2), 'utf8');
  console.log(`Wrote ${entries.length} sentences to ${outPath}`);
}

function writeSpotCheckSample(
  all: { level: Level; entry: SentenceBankEntry }[],
  rng: () => number,
): void {
  const sample = shuffle(all, rng).slice(0, 100);
  const lines = [
    '# Sentence bank spot-check sample',
    '',
    `${sample.length} of ${all.length} generated sentences, randomly sampled for manual review (phase doc 04 §1).`,
    '',
  ];
  for (const { level, entry } of sample) {
    const flag = entry.doubtful ? ' _(flagged: doubtful)_' : '';
    lines.push(`- **[${level}]** ${entry.zh} — ${entry.en}${flag}`);
  }
  const outPath = path.join(REPO_ROOT, 'data/build/sentence-sample.md');
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote spot-check sample (${sample.length} sentences) to ${outPath}`);
}

async function main(): Promise<void> {
  if (FAKE) {
    console.log(
      "(--fake: using canned filler-word templates, not a real model — see lib/sentence-gen-client.ts's header comment)",
    );
  }
  const lexicon = loadLexicon();
  const client: SentenceGenClient = FAKE
    ? createFakeSentenceGenClient()
    : createHttpSentenceGenClient(PROXY_URL);
  const rng = Math.random;

  const allEntries: { level: Level; entry: SentenceBankEntry }[] = [];
  let totalWords = 0;
  let totalWithEnough = 0;

  for (const level of LEVELS) {
    console.log(`\n=== ${level} ===`);
    const { entries, wordsAttempted, wordsWithEnough } = await generateForLevel(
      level,
      lexicon,
      client,
      rng,
    );
    writeBankFile(level, entries);
    allEntries.push(...entries.map((entry) => ({ level, entry })));
    totalWords += wordsAttempted;
    totalWithEnough += wordsWithEnough;
  }

  writeSpotCheckSample(allEntries, rng);

  const pct = totalWords > 0 ? ((totalWithEnough / totalWords) * 100).toFixed(1) : '0.0';
  console.log(
    `\n${totalWithEnough}/${totalWords} words (${pct}%) have >= 3 validated sentences (acceptance target: >= 95%).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
