#!/usr/bin/env tsx
// Compiles data/scenarios/*.yaml into data/build/scenarios.json, validated
// against @anan/core's ScenarioSchema — the single source of truth for the
// shape, shared by apps/web (fetches the built JSON, like the lexicon) and
// apps/proxy (resolves scenario details server-side by id; never trusts a
// client-supplied NPC personality/setting).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenarios } from './lib/scenario-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCENARIOS_DIR = path.join(REPO_ROOT, 'data/scenarios');
const BUILD_DIR = path.join(REPO_ROOT, 'data/build');

function main(): void {
  const scenarios = loadScenarios(SCENARIOS_DIR);
  const contentHash = createHash('sha256').update(JSON.stringify(scenarios)).digest('hex');

  const outPath = path.join(BUILD_DIR, 'scenarios.json');
  let buildDate = new Date().toISOString().slice(0, 10);
  if (existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf8'));
      if (prev?.meta?.contentHash === contentHash) buildDate = prev.meta.buildDate;
    } catch {
      /* ignore unreadable previous build, just use today */
    }
  }

  const out = { meta: { version: 'v1', buildDate, contentHash }, scenarios };
  writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Wrote ${scenarios.length} scenarios to ${outPath}`);
}

main();
