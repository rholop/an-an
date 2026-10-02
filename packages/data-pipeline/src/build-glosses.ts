#!/usr/bin/env tsx
/**
 * Phase 7 §B2: offline gloss adjudication. For each word with several
 * candidate senses, asks the proxy's POST /v1/gloss (Gemini first, OpenAI
 * fallback, cached) to CHOOSE and CONDENSE from the candidates. Results are
 * appended to data/build/gloss-adjudication.jsonl; `pnpm build:lexicon`
 * validates and applies them (invalid ones are rejected and flagged).
 *
 * Resumable and rate-limit aware: re-run after a stop and finished words are
 * skipped. N1–L2 first, then by frequency.
 *
 *   pnpm --filter @anan/proxy dev                      # real key in apps/proxy/.env
 *   pnpm --filter @anan/data-pipeline build:glosses [--limit 200] [--levels N1,N2,L1,L2] [--dry-run]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { LEVEL_IDS, isLevel, type Level, type SentenceBankFile, type Word } from '@anan/core';
import { AdjudicationStore, proxyCall, runAdjudication } from './lib/gloss/adjudicate.js';
import { buildInventory } from './lib/gloss/inventory.js';
import { loadGlossOverrides, findOverride } from './lib/gloss/overrides.js';
import { pinyinKey } from './lib/gloss/normalize.js';
import { buildAdjudicationRequest } from './lib/gloss/request.js';
import { MoeDictionary } from './lib/moe.js';
import { loadTocflCedict, loadTop2011, loadWiktionary } from './lib/gloss/sources.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BUILD = path.join(root, 'data/build');
const RAW = path.join(root, 'data/raw');

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const proxyUrl = arg('proxy') ?? process.env.PROXY_URL ?? 'http://localhost:3002';
  const limit = arg('limit') ? Number(arg('limit')) : Infinity;
  const levels = (arg('levels')?.split(',') ?? ['N1', 'N2', 'L1', 'L2']).filter(isLevel) as Level[];

  const lexicon = JSON.parse(readFileSync(path.join(BUILD, 'lexicon.v2.json'), 'utf8')) as {
    words: Word[];
  };
  const cache = path.join(RAW, '.cache/dict-revised-translated.json');
  if (!existsSync(cache))
    execFileSync('sh', [
      '-c',
      `mkdir -p ${path.dirname(cache)} && unxz -c ${path.join(RAW, 'dict-revised-translated.json.xz')} > ${cache}`,
    ]);
  const moe = MoeDictionary.loadFromJsonFile(cache);
  const wiktionary = await loadWiktionary(
    path.join(RAW, 'kaikki-chinese.jsonl'),
    new Set(lexicon.words.flatMap((w) => [w.headword, ...w.variants])),
  );
  const sources = {
    cedict: loadTocflCedict(path.join(RAW, 'ivankra-tocfl-cedict.csv')),
    top2011: loadTop2011(path.join(RAW, 'ivankra-top-20111208.csv')),
    moe,
    wiktionary,
  };
  const overrides = loadGlossOverrides(path.join(root, 'data/supplement/gloss-overrides.yaml'));

  const examples = new Map<string, { zh: string; en: string }[]>();
  for (const f of readdirSync(BUILD).filter((n) => /^sentences\.v\d+\.[A-Z0-9]+\.json$/.test(n))) {
    for (const s of (JSON.parse(readFileSync(path.join(BUILD, f), 'utf8')) as SentenceBankFile)
      .sentences) {
      const list = examples.get(s.targetWordId) ?? [];
      if (list.length < 2) list.push({ zh: s.zh, en: s.en });
      examples.set(s.targetWordId, list);
    }
  }

  // Priority: the chosen levels first (N1 → L2), then everything else by frequency.
  const rank = (w: Word) =>
    w.level && levels.includes(w.level) ? LEVEL_IDS.indexOf(w.level) : 100 + (w.freqRank ?? 1e6);
  const queue = lexicon.words
    .filter((w) => w.source === 'tocfl' && !findOverride(overrides, w, pinyinKey))
    .sort((a, b) => rank(a) - rank(b));

  const requests = [];
  for (const w of queue) {
    const inv = buildInventory(w, sources);
    const english = new Set(
      inv.candidates
        .filter((c) => c.glossEn && c.source !== 'top2011')
        .map((c) => c.glossEn!.toLowerCase()),
    );
    if (english.size < 2) continue; // nothing to choose between: the heuristic result stands
    requests.push(buildAdjudicationRequest(w, inv, examples.get(w.id)));
  }

  const store = new AdjudicationStore(path.join(BUILD, 'gloss-adjudication.jsonl'));
  const pending = requests.filter((r) => !store.all().some((x) => x.wordId === r.word.id));
  const approxChars = pending
    .slice(0, Math.min(pending.length, limit))
    .reduce((n, r) => n + JSON.stringify(r).length, 0);
  console.log(
    `${requests.length} words have ≥2 candidate senses; ${pending.length} not yet adjudicated; ≈${Math.round(approxChars / 4).toLocaleString()} input tokens for this run (+ output).`,
  );
  if (flag('dry-run')) return;

  const started = Date.now();
  const summary = await runAdjudication({
    store,
    requests,
    call: proxyCall(proxyUrl),
    limit,
    log: (l) => console.log(l),
  });
  console.log(
    `calls=${summary.calls} cached=${summary.cached} failed=${summary.failed} tokens=${summary.tokens.toLocaleString()} ` +
      `elapsed=${Math.round((Date.now() - started) / 1000)}s${summary.rateLimitedStop ? ' — STOPPED by rate limit; re-run to resume' : ''}`,
  );
  console.log(
    'Next: pnpm --filter @anan/data-pipeline build:lexicon  (validates + applies; see data/build/gloss-review.md)',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
