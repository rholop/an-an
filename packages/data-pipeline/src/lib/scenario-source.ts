import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ScenarioSchema, type Scenario } from '@anan/core';

/** Reads and validates every data/scenarios/*.yaml file (ScenarioSchema is
 * the single source of truth for the shape — see packages/core/src/chat/scenario.ts).
 * Throws with the offending filename on a validation error or a duplicate id. */
export function loadScenarios(scenariosDir: string): Scenario[] {
  const files = readdirSync(scenariosDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const scenarios: Scenario[] = [];
  const seenIds = new Set<string>();

  for (const file of files) {
    const raw = yaml.load(readFileSync(path.join(scenariosDir, file), 'utf8'));
    let scenario: Scenario;
    try {
      scenario = ScenarioSchema.parse(raw);
    } catch (err) {
      throw new Error(`${file} failed validation: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (seenIds.has(scenario.id)) {
      throw new Error(`Duplicate scenario id "${scenario.id}" (in ${file})`);
    }
    seenIds.add(scenario.id);
    scenarios.push(scenario);
  }

  scenarios.sort((a, b) => a.id.localeCompare(b.id));
  return scenarios;
}
