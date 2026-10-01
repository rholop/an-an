import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScenarioFileSchema, type Scenario } from '@anan/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Deploy layout note: this walks up from dist/src (or src in dev) to the
// repo root to find data/build/scenarios.json. If apps/proxy is ever
// deployed as a standalone artifact without the rest of the monorepo
// (e.g. a zipped serverless bundle), this file needs to be copied alongside
// the build output instead — see apps/proxy/README.md.
const REPO_ROOT = path.resolve(__dirname, '../../..');

export interface ScenarioStore {
  get(id: string): Scenario | undefined;
  all(): Scenario[];
}

export function loadScenarioStore(scenariosJsonPath?: string): ScenarioStore {
  const filePath = scenariosJsonPath ?? path.join(REPO_ROOT, 'data/build/scenarios.json');
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const parsed = ScenarioFileSchema.parse(raw);
  const byId = new Map(parsed.scenarios.map((s) => [s.id, s]));
  return {
    get: (id) => byId.get(id),
    all: () => parsed.scenarios,
  };
}
