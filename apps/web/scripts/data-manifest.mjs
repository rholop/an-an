// Phase 38 Part A: versioned data files. Each sync script copies its file into public/ twice: under
// its plain name (scripts, e2e and tools read that one) and under a content-hashed name
// (`lexicon.v2.3f9a2c1b04.json`), and records the hashed name in public/data-manifest.json. The app
// reads the manifest fresh on every visit (it is tiny) and then loads the hashed files, which the
// service worker may keep forever: a new build is a new URL, so a browser can never hold an old
// word list next to a new book.json again.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, '../public');
export const MANIFEST = path.join(PUBLIC_DIR, 'data-manifest.json');

/** `lexicon/lexicon.v2.json` + hash -> `lexicon/lexicon.v2.<hash>.json`. */
export function hashedName(logical, hash) {
  const ext = path.extname(logical);
  return `${logical.slice(0, -ext.length)}.${hash}${ext}`;
}

const HASH_RE = /\.[0-9a-f]{10}(\.[a-z]+)$/;

function readManifest() {
  if (!existsSync(MANIFEST)) return { version: 1, files: {} };
  try {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    return { version: 1, files: m.files ?? {} };
  } catch {
    return { version: 1, files: {} };
  }
}

/**
 * Copies `src` to public/<logical> and public/<logical with its content hash>, removes older hashed
 * copies of the same file, and records it in the manifest. Returns the hashed path.
 */
export function publishDataFile(src, logical) {
  const body = readFileSync(src);
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 10);
  const hashed = hashedName(logical, hash);
  const destPlain = path.join(PUBLIC_DIR, logical);
  const dir = path.dirname(destPlain);
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, destPlain);
  // older builds of this same file (the service worker keeps what a browser already has)
  const base = path.basename(logical, path.extname(logical));
  for (const f of readdirSync(dir)) {
    if (f.startsWith(`${base}.`) && HASH_RE.test(f) && f.replace(HASH_RE, '$1') === path.basename(logical))
      rmSync(path.join(dir, f));
  }
  copyFileSync(src, path.join(PUBLIC_DIR, hashed));
  const manifest = readManifest();
  manifest.files[logical] = hashed;
  manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  return hashed;
}

/** Drops manifest entries under `prefix` whose plain file is no longer published. */
export function pruneManifest(prefix) {
  const manifest = readManifest();
  for (const logical of Object.keys(manifest.files))
    if (logical.startsWith(prefix) && !existsSync(path.join(PUBLIC_DIR, logical))) delete manifest.files[logical];
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}
