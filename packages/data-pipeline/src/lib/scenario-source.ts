import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { OpenChatPersonaSchema, ScenarioSchema, type OpenChatPersona, type Scenario } from '@anan/core';

/** YAML files in the scenarios folder that have their own schema (Phase 18's open-chat persona). */
export const NON_SCENARIO_FILES: ReadonlySet<string> = new Set(['open-chat.yaml']);

export function loadOpenChatPersona(scenariosDir: string): OpenChatPersona {
  const raw = yaml.load(readFileSync(path.join(scenariosDir, 'open-chat.yaml'), 'utf8'));
  return OpenChatPersonaSchema.parse(raw);
}

/** Reads and validates every data/scenarios/*.yaml file (ScenarioSchema is
 * the single source of truth for the shape — see packages/core/src/chat/scenario.ts).
 * Throws with the offending filename on a validation error or a duplicate id. */
export function loadScenarios(scenariosDir: string): Scenario[] {
  const files = readdirSync(scenariosDir).filter(
    (f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !NON_SCENARIO_FILES.has(f),
  );
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
