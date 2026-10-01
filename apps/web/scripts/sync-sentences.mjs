// Copies data-pipeline's per-level sentence bank files into public/,
// mirroring sync-lexicon.mjs/sync-scenarios.mjs. Unlike those two, it's not
// an error for none to exist yet — the sentence bank (packages/data-pipeline
// build:sentences) needs a live proxy + API key to generate for real, so a
// fresh checkout legitimately has none; the cloze session just falls back
// to chat history/no-sentence cards for every word (phase doc 04 §2).
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC_DIR = path.join(REPO_ROOT, 'data/build');
const DEST_DIR = path.join(__dirname, '../public/sentences');

const files = existsSync(SRC_DIR) ? readdirSync(SRC_DIR).filter((f) => /^sentences\.v\d+\.[A-Z0-9]+\.json$/.test(f)) : [];

if (files.length === 0) {
  console.log('sync-sentences: no data/build/sentences.v*.*.json files yet (run "pnpm --filter @anan/data-pipeline build:sentences" to generate) — skipping.');
  process.exit(0);
}

mkdirSync(DEST_DIR, { recursive: true });
for (const file of files) {
  copyFileSync(path.join(SRC_DIR, file), path.join(DEST_DIR, file));
}
console.log(`sync-sentences: copied ${files.length} file(s) to ${DEST_DIR}`);
