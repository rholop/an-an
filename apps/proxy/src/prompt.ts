import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DefineRequest,
  GlossAdjudicationRequest,
  ClozeCheckRequest,
  JournalCheckRequest,
  JournalExplainRequest,
  JournalReviewRequest,
  Scenario,
  SentenceGenRequest,
  TurnRequest,
} from '@anan/core';

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

const listOrNone = (items: string[], noneLabel: string) =>
  items.length > 0 ? items.join('、') : noneLabel;

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
  const goalSteps = scenario.goalSteps
    .map((g, i) => `${i + 1}. [${g.id}] ${g.description}`)
    .join('\n');

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
    sense_options:
      (req.vocab.senseOptions ?? []).length > 0
        ? (req.vocab.senseOptions ?? [])
            .map((o) => `- ${o.word}: ${o.senses.map((s) => `${s.id} = ${s.gloss}`).join(' | ')}`)
            .join('\n')
        : '(none this turn)',
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
    allowed_vocab: listOrNone(
      req.allowedVocab,
      '(none — compose using only the target word itself)',
    ),
    count: String(req.count),
  });
}

export interface JournalPrompts {
  review: string;
  check: string;
  explain: string;
  /** Phase 16: naturalness check of one full corrected sentence. */
  clozeCheck: string;
}

export function loadJournalPromptTemplates(version: string): JournalPrompts {
  return {
    review: loadPromptFile(`journal-review.${version}.md`),
    check: loadPromptFile(`journal-check.${version}.md`),
    explain: loadPromptFile(`journal-explain.${version}.md`),
    clozeCheck: loadPromptFile(`cloze-check.${version}.md`),
  };
}

export function buildJournalReviewPrompt(template: string, req: JournalReviewRequest): string {
  return fillPlaceholders(template, {
    learner_level: req.learnerLevel,
    max_issues: String(req.maxIssues),
    prompt_words: listOrNone(req.promptWords, '(none)'),
    recurring_patterns: listOrNone(req.recurringPatterns, '(none recorded yet)'),
  });
}

export interface GlossPrompts {
  adjudicate: string;
  define: string;
}

export function loadGlossPromptTemplates(version: string): GlossPrompts {
  return {
    adjudicate: loadPromptFile(`gloss-adjudicate.${version}.md`),
    define: loadPromptFile(`define.${version}.md`),
  };
}

export function glossAdjudicateUserMessage(req: GlossAdjudicationRequest): string {
  return JSON.stringify(req);
}

export function defineUserMessage(req: DefineRequest): string {
  return JSON.stringify({ word: req.word, sentence: req.context });
}

export function buildJournalCheckPrompt(template: string): string {
  return fillPlaceholders(template, {});
}

export function buildJournalExplainPrompt(template: string, req: JournalExplainRequest): string {
  return fillPlaceholders(template, { learner_level: req.learnerLevel });
}

/** The learner's free text goes in the *user* message inside a fenced block,
 * never into the system prompt — it is data to analyse, not instructions
 * (a journal entry reading "ignore your rules" must stay a journal entry). */
export function journalReviewUserMessage(req: JournalReviewRequest): string {
  return `Review this journal entry. Offsets are JavaScript string indices (0-based, end exclusive) into the text between the markers.\n<<<ENTRY\n${req.text}\nENTRY>>>`;
}

export function journalCheckUserMessage(req: JournalCheckRequest): string {
  return JSON.stringify({
    sentence: req.sentence,
    original_span: req.original,
    learner_attempt: req.attempt,
    suggested_correction: req.correction,
  });
}

export function journalExplainUserMessage(req: JournalExplainRequest): string {
  return JSON.stringify({
    sentence: req.sentence,
    original_span: req.original,
    correction: req.correction,
    earlier_explanation: req.explanationEn,
  });
}

export function buildClozeCheckPrompt(template: string): string {
  return fillPlaceholders(template, {});
}

/** The sentence is data inside a fenced block, never instructions. */
export function clozeCheckUserMessage(req: ClozeCheckRequest): string {
  return `Check this sentence.\n<<<SENTENCE\n${req.sentence}\nSENTENCE>>>`;
}
