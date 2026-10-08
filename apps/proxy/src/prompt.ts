import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  StoryCheckRequest,
  StoryRequest,
  DefineRequest,
  GlossAdjudicationRequest,
  ClozeCheckRequest,
  JournalCheckRequest,
  JournalSentenceFixRequest,
  JournalSolveRequest,
  JournalVerifyRequest,
  JournalExplainRequest,
  JournalReviewRequest,
  OpenChatPersona,
  OpenTurnRequest,
  Scenario,
  SentenceGenRequest,
  TopicWordsRequest,
  TurnRequest,
} from '@anan/core';
import { OPEN_CHAT_CONFIG } from '@anan/core';

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
  /** Phase 17: retry of one corrected sentence, the independent checker, the solver. */
  sentenceFix: string;
  verify: string;
  solve: string;
}

export function loadJournalPromptTemplates(version: string): JournalPrompts {
  return {
    review: loadPromptFile(`journal-review.${version}.md`),
    check: loadPromptFile(`journal-check.${version}.md`),
    explain: loadPromptFile(`journal-explain.${version}.md`),
    clozeCheck: loadPromptFile(`cloze-check.${version}.md`),
    sentenceFix: loadPromptFile(`journal-sentence-fix.${version}.md`),
    verify: loadPromptFile(`journal-verify.${version}.md`),
    solve: loadPromptFile(`journal-solve.${version}.md`),
  };
}

export function buildJournalReviewPrompt(template: string, req: JournalReviewRequest): string {
  return fillPlaceholders(template, {
    learner_level: req.learnerLevel,
    max_issues: String(req.maxIssues),
    prompt_words: listOrNone(req.promptWords, '(none)'),
    recurring_patterns: listOrNone(req.recurringPatterns, '(none recorded yet)'),
    protected_terms: listOrNone(req.protectedTerms ?? [], '(none)'),
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
  const sentences = req.sentences ?? [];
  const list =
    sentences.length > 0
      ? `\n\nThe entry split into numbered sentences (return one \`sentences\` item per number, using these numbers as \`index\`):\n<<<SENTENCES\n${sentences.map((s, i) => `[${i}] ${s}`).join('\n')}\nSENTENCES>>>`
      : '';
  const only = req.sentencesOnly
    ? '\n\nOnly the `sentences` list is wanted: return `issues`, `brackets` and `used_well` as empty lists and `natural_rewrite` as an empty string.'
    : '';
  return `Review this journal entry. Offsets are JavaScript string indices (0-based, end exclusive) into the text between the markers.\n<<<ENTRY\n${req.text}\nENTRY>>>${list}${only}`;
}

export function buildSentenceFixPrompt(template: string, req: JournalSentenceFixRequest): string {
  return fillPlaceholders(template, {
    learner_level: req.learnerLevel,
    protected_terms: listOrNone(req.protectedTerms, '(none)'),
  });
}

export function sentenceFixUserMessage(req: JournalSentenceFixRequest): string {
  return JSON.stringify({
    learner_sentence: req.original,
    rejected_correction: req.rejected,
    problem: req.problem,
  });
}

export function buildVerifyPrompt(template: string): string {
  return fillPlaceholders(template, {});
}

/** The checker never receives the learner's original sentence. */
export function verifyUserMessage(req: JournalVerifyRequest): string {
  return req.en
    ? `Sentence:\n<<<ZH\n${req.zh}\nZH>>>\nIntended English meaning: ${req.en}`
    : `Sentence:\n<<<ZH\n${req.zh}\nZH>>>`;
}

export function buildSolvePrompt(template: string): string {
  return fillPlaceholders(template, {});
}

export function solveUserMessage(req: JournalSolveRequest): string {
  return JSON.stringify({ sentence_with_blank: req.sentence, english: req.en, hint: req.hint });
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

// ---- Phase 18: open chat ------------------------------------------------------

export function loadOpenChatPromptTemplates(version: string): { turn: string; topicWords: string } {
  return {
    turn: loadPromptFile(`open-chat.${version}.md`),
    topicWords: loadPromptFile(`topic-words.${version}.md`),
  };
}

/** Fills data/prompts/open-chat.*.md from the persona (resolved server-side) and the request. */
export function buildOpenSystemPrompt(
  template: string,
  persona: OpenChatPersona,
  req: OpenTurnRequest,
): string {
  const compact = req.learnerLevel === 'N1' || req.learnerLevel === 'N2' || req.learnerLevel === 'L1';
  return fillPlaceholders(template, {
    npc_name: persona.name,
    npc_personality: persona.personality,
    npc_speech_style: persona.speechStyle,
    npc_particles: listOrNone(persona.particles, '(none specified)'),
    setting: persona.setting,
    learner_level: req.learnerLevel,
    topic: req.topic.trim() ? req.topic.trim() : '(none chosen: ask a simple question to start)',
    summary: req.summary?.trim() ? req.summary.trim() : '(nothing yet)',
    turn_length: compact ? '1–2 short sentences.' : '1–3 short sentences.',
    tier_a: listOrNone(req.tiers.a, '(none provided: use only very common words)'),
    tier_b: listOrNone(req.tiers.b, '(none)'),
    tier_c: listOrNone(req.tiers.cAllowed, '(none: do not introduce any new word)'),
    grammar: listOrNone(req.grammar ?? [], '(none)'),
    hard_topic: req.hardTopic
      ? '**This is a harder topic.** Keep it simple, introduce at most ONE new tier C word per reply, and you may say in easy Chinese that the topic is a bit hard.'
      : 'Introduce a new tier C word only when the topic really needs it, and then only one.',
    scaffolding: req.scaffolding,
    english_fallback: req.englishFallback ? 'true' : 'false',
  });
}

/** The topic is data inside a JSON message, never part of the instructions. Normalised so
 * "Food " and "food" share one cache entry. */
export function normalizeTopic(topic: string): string {
  return topic.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function topicWordsUserMessage(req: TopicWordsRequest): string {
  return JSON.stringify({
    topic: normalizeTopic(req.topic),
    level: req.level,
    count: OPEN_CHAT_CONFIG.topicWordCount,
  });
}

// ---- Phase 24: graded stories -------------------------------------------------------------

export function loadStoryPromptTemplates(version: string): { write: string; check: string } {
  return { write: loadPromptFile(`story.${version}.md`), check: loadPromptFile(`story-check.${version}.md`) };
}

const NOVICE = new Set(['N1', 'N2']);

export function buildStoryPrompt(template: string, req: StoryRequest): string {
  return fillPlaceholders(template, {
    learner_level: req.learnerLevel,
    rung1_share: `${Math.round(req.budget.rung1Share * 100)}%`,
    rung3: String(req.budget.rung3),
    rung4: String(req.budget.rung4),
    rung5: String(req.budget.rung5),
    grammar: listOrNone(req.grammar, '(basic sentence patterns only)'),
    grammar_next: listOrNone(req.grammarNext, '(none)'),
    length_min: String(req.length.min),
    length_max: String(req.length.max),
    sentence_style: NOVICE.has(req.learnerLevel)
      ? 'Very short, simple sentences (5–12 characters each).'
      : 'Short, clear sentences.',
  });
}

export function storyUserMessage(req: StoryRequest): string {
  const lines = [
    `Topic: ${req.topic}`,
    `Names: ${req.names.join('、') || '(none: use 小明 or 小美)'}`,
    `Rung 1 (known): ${req.rungs.r1.join('、') || '(none)'}`,
    `Rung 2 (this lesson): ${req.rungs.r2.join('、') || '(none)'}`,
    `Rung 3 (next lesson): ${req.rungs.r3.join('、') || '(none)'}`,
    `Rung 4 (the lesson after): ${req.rungs.r4.join('、') || '(none)'}`,
    `Rung 5 (current level): ${req.rungs.r5.join('、') || '(none)'}`,
  ];
  if (req.previous)
    lines.push(`Continue this story with the same characters. Previous episode "${req.previous.title}": ${req.previous.summaryEn}`);
  if (req.feedback) lines.push(`Your last version was rejected: ${req.feedback}`);
  return lines.join('\n');
}

export function storyCheckUserMessage(req: StoryCheckRequest): string {
  const story = req.paragraphs.join('\n\n');
  const qs = req.questions
    .map((q, i) => `${i + 1}. ${q.q}\n${q.options.map((o, j) => `   ${j}) ${o}`).join('\n')}`)
    .join('\n');
  return `Story:\n<<<ZH\n${story}\nZH>>>\nEnglish summary: ${req.summaryEn}\nQuestions:\n${qs || '(none)'}`;
}
