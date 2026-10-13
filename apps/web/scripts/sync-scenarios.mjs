// Copies the data-pipeline's scenario build output into public/, mirroring
// sync-lexicon.mjs, so the chat UI can fetch it as a static asset the same
// way it fetches the lexicon.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishDataFile } from './data-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(REPO_ROOT, 'data/build/scenarios.json');

if (!existsSync(SRC)) {
  console.error(`sync-scenarios: ${SRC} doesn't exist yet — run "pnpm pipeline:build" first.`);
  process.exit(1);
}
const hashed = publishDataFile(SRC, 'scenarios/scenarios.json');
console.log(`sync-scenarios: copied ${SRC} -> public/scenarios/scenarios.json and public/${hashed}`);
