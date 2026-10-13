#!/usr/bin/env tsx
/**
 * Phase 38 Part D: `pnpm audit:data`. Fails if any word or grammar id referenced by a book.json, an
 * extras.yaml, a sentence bank, scenarios.json or id-map.json is missing from
 * data/build/lexicon.v2.json (such an id would be a review card the app can't show). Runs in CI.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDataIds, readDataAuditConfig, shippedIdRefs } from './lib/data-ids.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repo = process.argv[2] ? path.resolve(process.argv[2]) : REPO;

const lexicon = JSON.parse(readFileSync(path.join(repo, 'data/build/lexicon.v2.json'), 'utf8')) as {
  words: { id: string }[];
  grammar: { id: string }[];
};
const refs = shippedIdRefs(repo);
const { missing, staleRetired } = auditDataIds(refs, lexicon, readDataAuditConfig(repo));
console.log(`Checked ${refs.length} id references against ${lexicon.words.length} words and ${lexicon.grammar.length} grammar points.`);
for (const m of missing.slice(0, 50)) console.error(`  - ${m.kind} ${m.id} (${m.where})`);
for (const id of staleRetired) console.error(`  - stale entry in data/curriculum/data-audit.yaml (matches nothing): ${id}`);
if (missing.length > 0 || staleRetired.length > 0) {
  console.error(`\nData audit failed: ${missing.length} id(s) missing from data/build/lexicon.v2.json, ${staleRetired.length} stale entr(ies).`);
  process.exit(1);
}
console.log('Data audit passed: every referenced id is in the lexicon.');
