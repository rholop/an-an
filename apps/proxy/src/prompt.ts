import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scenario, TurnRequest } from '@anan/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

export function loadPromptTemplate(version: string): string {
  const filePath = path.join(REPO_ROOT, 'data/prompts', `tutor-system.${version}.md`);
  return readFileSync(filePath, 'utf8');
}

const listOrNone = (items: string[], noneLabel: string) => (items.length > 0 ? items.join('、') : noneLabel);

/** Fills data/prompts/tutor-system.*.md's {{placeholders}} from the
 * scenario definition + this turn's request. Plain string substitution, no
 * templating engine or conditionals — see the template file's own header
 * comment for the contract. */
export function buildSystemPrompt(template: string, scenario: Scenario, req: TurnRequest): string {
  const goalSteps = scenario.goalSteps.map((g, i) => `${i + 1}. [${g.id}] ${g.description}`).join('\n');

  const replacements: Record<string, string> = {
    npc_name: scenario.npc.name,
    npc_personality: scenario.npc.personality,
    npc_speech_style: scenario.npc.speechStyle,
    npc_particles: listOrNone(scenario.npc.particles, '(none specified)'),
    setting: scenario.setting,
    goal_steps: goalSteps,
    learner_level: req.learnerLevel,
    known_sample: listOrNone(req.vocab.knownSample, '(none provided)'),
    due_words: listOrNone(req.vocab.due, '(none due)'),
    target_words: listOrNone(req.vocab.targets, '(none this turn)'),
    allowed_extras: listOrNone(req.vocab.allowedExtras, '(none)'),
    scaffolding: req.scaffolding,
    english_fallback: req.englishFallback ? 'true' : 'false',
  };

  // Strip the template file's leading HTML comment (editor-facing
  // documentation about the placeholder contract, e.g. "{{like_this}}" as
  // a literal illustrative example) — it's not meant for the model.
  let result = template.replace(/<!--[\s\S]*?-->/g, '').trim();
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}
