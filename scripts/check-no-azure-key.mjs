// Build check: the Azure Speech key never reaches the browser.
// Phase 10: the key lived only in the data-pipeline's environment. Phase 40: the proxy reads it
// too (AZURE_SPEECH_KEY in the server's .env, for tutoring audio), so the proxy may NAME the
// variable, but no key VALUE may be in its source, bundle or config files, and the web bundle and
// web source may not even mention it.
//   node scripts/check-no-azure-key.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'sync-data', 'audio-data', 'tutor-audio'].includes(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (!/\.(mp3|png|jpg|jpeg|ico|woff2?|gz)$/.test(name)) yield p;
  }
}

const key = process.env.AZURE_SPEECH_KEY;
const keyNeedle = key && key.length >= 16 ? [key] : []; // the real value, when this machine has one

/** Files where neither the name nor the value may appear (anything here is shipped to browsers). */
const webTargets = [path.join(root, 'apps/web/dist'), path.join(root, 'apps/web/src')];
/** Files that may name the variable but must never hold a key value. */
const proxyTargets = [
  path.join(root, 'apps/proxy/src'),
  path.join(root, 'apps/proxy/dist'),
  path.join(root, 'apps/proxy/.env.example'),
  path.join(root, 'apps/proxy/ecosystem.config.cjs'),
  path.join(root, 'packages/audio-build/src'),
];

function scan(targets, needles) {
  for (const t of targets) {
    const files = existsSync(t) && statSync(t).isFile() ? [t] : [...walk(t)];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const n of needles) {
        if (text.includes(n)) problems.push(`${path.relative(root, f)} contains ${n === key ? 'the Azure key value' : n}`);
      }
    }
  }
}
scan(webTargets, ['AZURE_SPEECH', ...keyNeedle]);
scan(proxyTargets, keyNeedle);

// A key-looking value written into a committed example or config file.
for (const name of ['apps/proxy/.env.example', 'apps/proxy/ecosystem.config.cjs']) {
  const f = path.join(root, name);
  if (existsSync(f) && /^\s*AZURE_SPEECH_KEY\s*[=:]\s*['"]?[A-Za-z0-9]{16,}/m.test(readFileSync(f, 'utf8')))
    problems.push(`${name} sets an Azure key value`);
}
if (Object.keys(process.env).some((k) => k.startsWith('VITE_') && /AZURE/.test(k))) {
  problems.push('a VITE_* variable mentions AZURE (it would be bundled into the web app)');
}

if (problems.length) {
  console.error('Azure key check FAILED:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('Azure key check passed: nothing in the web bundle or web source; no key value in the proxy.');
