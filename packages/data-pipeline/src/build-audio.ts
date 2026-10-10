#!/usr/bin/env tsx
// Phase 10: build the verified-audio clips offline with Azure Speech (zh-TW).
//   pnpm --filter @anan/data-pipeline audio:build [--levels=N1,N2,L1,L2]
//        [--voice=female|male] [--only-flagged] [--fix-suspect [--again]]
//        [--retry-suspect] [--accept-medium] [--max-chars=N] [--sync-dir=DIR] [--dry-run]
// Textbook words (any book) and lesson practice sentences are always included, whatever their level.
// --fix-suspect: 3 different tries (other voice, explicit readings, both) per suspect clip;
//   a failed fix keeps the current clip and is not retried unless --again.
// --retry-suspect: a plain re-roll of suspect clips with the same voice and SSML
//   (Azure usually returns the same audio; prefer --fix-suspect).
// Needs AZURE_SPEECH_KEY (+ AZURE_SPEECH_REGION, default eastus) from this
// package's .env or the environment — the key never goes to the proxy or web app.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIO_VOICES, Lexicon, AudioMarkSchema, type AudioMark, type Level } from '@anan/core';
import { z } from 'zod';
import { AzureSpeechClient, billableChars } from './lib/audio/azure.js';
import { buildAudio, fixFlagged, fixSuspect, FIX_ATTEMPTS, loadManifest, suspectsToFix } from './lib/audio/build.js';
import {
  DEFAULT_LEVELS,
  loadBankSentences,
  loadLessonSentences,
  loadLiveSentences,
  sentenceJobs,
  wordJobs,
  type AudioJob,
} from './lib/audio/inputs.js';
import { renderReviewReport } from './lib/audio/report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const envFile = path.join(__dirname, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const BUILD_DIR = path.join(ROOT, 'data/build');
const OUT_DIR = arg('out') ? path.resolve(arg('out')!) : path.join(BUILD_DIR, 'audio');
const FLAGS_FILE = path.join(BUILD_DIR, 'audio-flags.json');
const levels = (arg('levels')?.split(',') ?? DEFAULT_LEVELS) as Level[];
const voice = arg('voice') === 'male' ? AUDIO_VOICES.male : AUDIO_VOICES.female;
const syncDir = arg('sync-dir') ?? path.join(ROOT, 'apps/proxy/sync-data');

const raw = JSON.parse(readFileSync(path.join(BUILD_DIR, 'lexicon.v2.json'), 'utf8'));
const lexicon = new Lexicon(raw.words, raw.grammar);

const words = wordJobs(lexicon, levels);
// Phase 35: lesson practice sentences come first and at any level (never private/ text)
const lessonSentences = sentenceJobs(lexicon, loadLessonSentences(BUILD_DIR), { acceptMedium: flag('accept-medium') });
const lessonIds = new Set([...lessonSentences.jobs, ...lessonSentences.skipped].map((j) => j.id));
const otherSentences = sentenceJobs(
  lexicon,
  [...loadBankSentences(BUILD_DIR, levels), ...loadLiveSentences(syncDir, levels)].filter((s) => !lessonIds.has(s.id)),
  { acceptMedium: flag('accept-medium') },
);
const sentences = {
  jobs: [...lessonSentences.jobs, ...otherSentences.jobs],
  skipped: [...lessonSentences.skipped, ...otherSentences.skipped],
};
const sampleN = arg('sample') ? Number(arg('sample')) : undefined;
// --sample=N: N evenly spaced words only (the voice comparison); never combine with the real output dir
const pick = <T,>(xs: T[]): T[] =>
  sampleN && xs.length > sampleN ? Array.from({ length: sampleN }, (_, i) => xs[Math.floor((i * xs.length) / sampleN)]!) : xs;
const jobs: AudioJob[] = sampleN ? pick(words.jobs) : [...words.jobs, ...sentences.jobs];
const skipped = [...words.skipped, ...sentences.skipped];
console.log(
  `audio:build ${levels.join(',')}: ${words.jobs.length} words (${words.textbook} of them textbook words, any level), ${sentences.jobs.length} sentences (${lessonSentences.jobs.length} of them lesson sentences, any level; ${lessonSentences.skipped.length} lesson sentences skipped), ${skipped.length} skipped (uncertain reading)`,
);

const fixingSuspects = flag('fix-suspect');
if (flag('dry-run')) {
  if (fixingSuspects) {
    const todo = suspectsToFix(jobs, loadManifest(path.join(OUT_DIR, 'manifest.json'), new Date(), voice), flag('again'));
    const chars = todo.reduce((n, { job }) => n + FIX_ATTEMPTS.length * billableChars(job.text), 0);
    console.log(`dry run: ${todo.length} suspect clips would be tried, at most ~${chars} billed characters (${FIX_ATTEMPTS.length} attempts each; double that without ffmpeg).`);
  } else {
    const chars = jobs.reduce((n, j) => n + billableChars(j.text), 0);
    console.log(`dry run: at most ~${chars} billed characters if every clip were new.`);
  }
  process.exit(0);
}

const key = process.env.AZURE_SPEECH_KEY;
if (!key) {
  console.error('AZURE_SPEECH_KEY is not set (put it in packages/data-pipeline/.env). See docs/audio.md.');
  process.exit(1);
}
const client = new AzureSpeechClient({ key, region: process.env.AZURE_SPEECH_REGION ?? 'eastus' });
const opts = {
  outDir: OUT_DIR,
  client,
  voice,
  now: new Date(),
  maxChars: arg('max-chars') ? Number(arg('max-chars')) : undefined,
  retrySuspect: flag('retry-suspect'),
  log: (m: string) => console.log(m),
};

const flagsFile = z.record(AudioMarkSchema);
const marks: Record<string, AudioMark> = existsSync(FLAGS_FILE)
  ? flagsFile.parse(JSON.parse(readFileSync(FLAGS_FILE, 'utf8')))
  : {};

if (flag('only-flagged')) {
  if (!existsSync(FLAGS_FILE)) {
    console.error(`No ${FLAGS_FILE}. Fetch it first: pnpm --filter @anan/data-pipeline audio:pull-flags`);
    process.exit(1);
  }
  const res = await fixFlagged(jobs, marks, opts);
  console.log(`fixed ${res.fixed.length}, still bad ${res.stillBad.length}, no longer in inputs ${res.missing.length}`);
  if (res.stoppedEarly) console.log(`stopped: ${res.stoppedEarly}`);
} else if (fixingSuspects) {
  const res = await fixSuspect(jobs, { ...opts, again: flag('again') });
  console.log(
    `fixed ${res.fixed.length} of ${res.tried.length} suspects, ${res.stillSuspect.length} still suspect`,
  );
  if (res.stoppedEarly) console.log(`stopped: ${res.stoppedEarly}`);
} else {
  const res = await buildAudio(jobs, opts);
  console.log(`made ${res.made}, unchanged ${res.unchanged}, suspect ${res.suspect}, failed ${res.failed}`);
  if (res.stoppedEarly) console.log(`stopped: ${res.stoppedEarly}`);
}

console.log(
  `Azure usage this run: ${client.usage.ttsCalls} TTS + ${client.usage.sttCalls} STT calls, ${client.usage.billedChars} billed characters (free tier: 500,000/month).`,
);

mkdirSync(BUILD_DIR, { recursive: true });
if (!sampleN) writeFileSync(
  path.join(BUILD_DIR, 'audio-review.md'),
  renderReviewReport(loadManifest(path.join(OUT_DIR, 'manifest.json'), new Date(), voice), skipped, marks),
);
if (!sampleN) console.log('Wrote data/build/audio-review.md');
