// Phase 10 build check: the Azure Speech key lives only in the data-pipeline's
// environment. Fails if it (or any AZURE_SPEECH reference) shows up in the web
// bundle or the proxy's source/config/environment.
//   node scripts/check-no-azure-key.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'sync-data' || name === 'audio-data') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (!/\.(mp3|png|jpg|jpeg|ico|woff2?|gz)$/.test(name)) yield p;
  }
}

const needles = ['AZURE_SPEECH'];
const key = process.env.AZURE_SPEECH_KEY;
if (key && key.length >= 16) needles.push(key); // the real value, when this machine has one

const targets = [
  path.join(root, 'apps/web/dist'),
  path.join(root, 'apps/web/src'),
  path.join(root, 'apps/proxy/src'),
  path.join(root, 'apps/proxy/dist'),
  path.join(root, 'apps/proxy/.env.example'),
  path.join(root, 'apps/proxy/ecosystem.config.cjs'),
];
for (const t of targets) {
  const files = existsSync(t) && statSync(t).isFile() ? [t] : [...walk(t)];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const n of needles) {
      // the .env.example comment that says "no Azure key belongs here" is allowed to say so in words only
      if (text.includes(n)) problems.push(`${path.relative(root, f)} contains ${n === key ? 'the Azure key value' : n}`);
    }
  }
}

for (const name of ['apps/proxy/.env']) {
  const f = path.join(root, name);
  if (existsSync(f) && /AZURE_SPEECH/.test(readFileSync(f, 'utf8'))) problems.push(`${name} sets an Azure variable`);
}
if (Object.keys(process.env).some((k) => k.startsWith('VITE_') && /AZURE/.test(k))) {
  problems.push('a VITE_* variable mentions AZURE (it would be bundled into the web app)');
}

if (problems.length) {
  console.error('Azure key check FAILED:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('Azure key check passed: nothing in the web bundle, web source or proxy.');
