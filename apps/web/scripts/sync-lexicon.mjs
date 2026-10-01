// Copies the data-pipeline's build output into public/ so the dev server
// and production build can fetch it as a static asset. Not a "real" deploy
// story (Phase 6 game layer / hosting is out of scope here) — just enough
// for the Phase 1 reader page to load real data.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(REPO_ROOT, 'data/build/lexicon.v1.json');
const DEST_DIR = path.join(__dirname, '../public/lexicon');
const DEST = path.join(DEST_DIR, 'lexicon.v1.json');

if (!existsSync(SRC)) {
  console.error(`sync-lexicon: ${SRC} doesn't exist yet — run "pnpm pipeline:build" first.`);
  process.exit(1);
}
mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(SRC, DEST);
console.log(`sync-lexicon: copied ${SRC} -> ${DEST}`);
