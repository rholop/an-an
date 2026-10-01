import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scenario, SentenceGenRequest, TurnRequest } from '@anan/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

function loadPromptFile(filename: string): string {
  return readFileSync(path.join(REPO_ROOT, 'data/prompts', filename), 'utf8');
}

export function loadPromptTemplate(version: string): string {
  return loadPromptFile(`tutor-system.${version}.md`);
}

export function loadSentenceGenPromptTemplate(version: string): string {
  return loadPromptFile(`sentence-gen.${version}.md`);
}

const listOrNone = (items: string[], noneLabel: string) => (items.length > 0 ? items.join('、') : noneLabel);

/** Strips the template file's leading HTML comment (editor-facing
 * documentation about the placeholder contract, e.g. "{{like_this}}" as a
 * literal illustrative example) — not meant for the model — then replaces
 * every {{placeholder}}. Plain string substitution, no templating engine or
 * conditionals, shared by both prompt builders below. */
function fillPlaceholders(template: string, replacements: Record<string, string>): string {
  let result = template.replace(/<!--[\s\S]*?-->/g, '').trim();
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/** Fills data/prompts/tutor-system.*.md's {{placeholders}} from the
 * scenario definition + this turn's request. */
export function buildSystemPrompt(template: string, scenario: Scenario, req: TurnRequest): string {
  const goalSteps = scenario.goalSteps.map((g, i) => `${i + 1}. [${g.id}] ${g.description}`).join('\n');

  return fillPlaceholders(template, {
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
  });
}

/** Fills data/prompts/sentence-gen.*.md's {{placeholders}} from a sentence
 * generation request (phase doc 04 §1). */
export function buildSentenceGenPrompt(template: string, req: SentenceGenRequest): string {
  return fillPlaceholders(template, {
    headword: req.word.headword,
    pinyin: req.word.pinyin,
    level: req.word.level,
    gloss_en: req.word.glossEn,
    allowed_vocab: listOrNone(req.allowedVocab, '(none — compose using only the target word itself)'),
    count: String(req.count),
  });
}
