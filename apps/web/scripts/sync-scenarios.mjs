// Copies the data-pipeline's scenario build output into public/, mirroring
// sync-lexicon.mjs, so the chat UI can fetch it as a static asset the same
// way it fetches the lexicon.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(REPO_ROOT, 'data/build/scenarios.json');
const DEST_DIR = path.join(__dirname, '../public/scenarios');
const DEST = path.join(DEST_DIR, 'scenarios.json');

if (!existsSync(SRC)) {
  console.error(`sync-scenarios: ${SRC} doesn't exist yet — run "pnpm pipeline:build" first.`);
  process.exit(1);
}
mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(SRC, DEST);
console.log(`sync-scenarios: copied ${SRC} -> ${DEST}`);
