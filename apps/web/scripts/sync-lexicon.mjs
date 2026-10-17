// Copies the data-pipeline's build output into public/ so the dev server
// and production build can fetch it as a static asset. Not a "real" deploy
// story (Phase 6 game layer / hosting is out of scope here) — just enough
// for the Phase 1 reader page to load real data.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishDataFile } from './data-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(REPO_ROOT, 'data/build/lexicon.v2.json');

if (!existsSync(SRC)) {
  console.error(`sync-lexicon: ${SRC} doesn't exist yet — run "pnpm pipeline:build" first.`);
  process.exit(1);
}
// Phase 38: also under a content-hashed name, listed in public/data-manifest.json.
const hashed = publishDataFile(SRC, 'lexicon/lexicon.v2.json');
console.log(`sync-lexicon: copied ${SRC} -> public/lexicon/lexicon.v2.json and public/${hashed}`);

// Phase 44: the shortened Unihan character glosses the review card's "Characters" row reads.
const GLOSSES = path.join(REPO_ROOT, 'data/build/char-glosses.brief.v1.json');
if (existsSync(GLOSSES)) {
  const g = publishDataFile(GLOSSES, 'lexicon/char-glosses.v1.json');
  console.log(`sync-lexicon: copied ${GLOSSES} -> public/${g}`);
} else {
  console.warn('sync-lexicon: no data/build/char-glosses.brief.v1.json (pnpm --filter @anan/data-pipeline build:char-glosses)');
}
