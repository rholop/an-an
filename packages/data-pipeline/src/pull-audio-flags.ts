#!/usr/bin/env tsx
// Download the household's audio marks (flags + OK's) from the proxy into
// data/build/audio-flags.json, for `audio:build --only-flagged` and the report.
//   pnpm --filter @anan/data-pipeline audio:pull-flags --url=https://holop.dev/an-an/api --code=<household code>
// (or AUDIO_PROXY_URL / SITE_CODE in the environment)
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const url = arg('url') ?? process.env.AUDIO_PROXY_URL ?? 'http://localhost:3002';
const code = arg('code') ?? process.env.SITE_CODE ?? '';

const res = await fetch(`${url.replace(/\/$/, '')}/v1/audio/marks`, { headers: { 'x-site-code': code } });
if (!res.ok) {
  console.error(`proxy answered ${res.status}`);
  process.exit(1);
}
const { marks } = (await res.json()) as { marks: Record<string, { status: string }> };
const out = path.resolve(__dirname, '../../../data/build/audio-flags.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(marks, null, 1));
const flagged = Object.values(marks).filter((m) => m.status === 'flagged').length;
console.log(`Saved ${Object.keys(marks).length} marks (${flagged} flagged) to ${out}`);
