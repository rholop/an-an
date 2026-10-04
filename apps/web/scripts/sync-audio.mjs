// Copies the built audio (data-pipeline `audio:build` -> data/build/audio) into
// public/audio, mirroring the other sync scripts. A fresh checkout has no audio:
// that's fine — the app then shows no speaker buttons at all.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../../../data/build/audio');
const DEST = path.resolve(__dirname, '../public/audio');

if (!existsSync(path.join(SRC, 'manifest.json'))) {
  console.log('sync-audio: no data/build/audio/manifest.json yet (run "pnpm --filter @anan/data-pipeline audio:build") — skipping.');
  process.exit(0);
}
rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });
console.log(`sync-audio: copied ${SRC} to ${DEST}`);
