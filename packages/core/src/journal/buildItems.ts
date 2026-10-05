import {
  checkJournalClozeRules,
  checkJournalSentenceRules,
} from '../cloze/check-journal-cloze.js';
import { emptyCard } from '../learner/fsrs-instance.js';
import type { Lexicon } from '../lexicon.js';
import { segment, type Token } from '../segment.js';
import { editShape, isPunctuationOnly, type ResolvedEdit } from './edits.js';
import { normaliseAnswer } from './normalize.js';
import type { ErrorExercise, ErrorItem, IssueType, Span } from './types.js';
import { verifySentenceText, type JournalLLM, type VerifiedSentence } from './verifyCorrected.js';
import type { Level } from '../types.js';

export const BLANK = '＿＿＿＿';
/** More tokens than this changed -> "Fix my sentence" instead of a cloze. */
export const MAX_BLANK_TOKENS = 2;
const REORDER_MIN_TOKENS = 3;
const REORDER_MAX_TOKENS = 10;
const MAX_SOLVER_ALTERNATIVES = 3;

const NUMERAL = /[0-9０-９零〇一二兩三四五六七八九十百千萬億]/;

export interface BuildItemsDeps {
  lexicon: Lexicon;
  llm: Pick<JournalLLM, 'solveJournalCloze' | 'verifyJournalSentence'>;
  protectedTerms: readonly string[];
  learnerLevel?: Level;
  now: Date;
}

export interface DroppedItem {
  sentenceId: string;
  /** Plan key, e.g. "e0". */
  plan: string;
  reason: string;
}

type PlanKind = ErrorExercise['kind'];

/** One exercise decided from the edits alone (no model call yet). */
export interface ItemPlan {
  key: string;
  kind: PlanKind;
  prompt: string;
  edits: ResolvedEdit[];
  /** cloze / choice: blank in `corrected`. */
  blank?: Span;
  /** extra_word / reorder. */
  tokens?: string[];
  extraTokenIndex?: number;
  /** cloze that falls back to a choice when the solver test can't decide it. */
  choiceFallback?: boolean;
}

/** Why a plan can't be built (and the sentence gets nothing or a fix item). */
interface Unbuildable {
  reason: string;
}

function occurrences(text: string, needle: string): Span[] {
  const found: Span[] = [];
  if (!needle) return found;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1))
    found.push([i, i + needle.length]);
  return found;
}

const overlaps = (a: Span, b: Span) => a[0] < b[1] && b[0] < a[1];

function tokensIn(tokens: readonly Token[], start: number, end: number): Token[] {
  return tokens.filter((t) =>
    start === end ? t.start < start && start < t.end : t.start < end && start < t.end,
  );
}

/** Part C's hard rules for a blank: 1-2 whole word tokens, never a protected
 * term, a name, a number or punctuation. Returns the reason it's not allowed. */
function blankProblem(
  corrected: string,
  span: Span,
  tokensC: readonly Token[],
  deps: Pick<BuildItemsDeps, 'lexicon' | 'protectedTerms'>,
): string | undefined {
  const toks = tokensC.filter((t) => t.start < span[1] && span[0] < t.end);
  if (toks.length === 0) return 'empty blank';
  if (toks.length > MAX_BLANK_TOKENS) return 'blank covers more than 2 tokens';
  if (toks[0]!.start !== span[0] || toks[toks.length - 1]!.end !== span[1])
    return 'the change does not line up with whole words';
  if (toks.some((t) => t.kind !== 'word')) return 'blank would cover punctuation or a number';
  const text = corrected.slice(span[0], span[1]);
  if (NUMERAL.test(text)) return 'blank would cover a number';
  for (const p of deps.protectedTerms)
    if (occurrences(corrected, p).some((o) => overlaps(o, span)))
      return 'blank would cover a protected name';
  if (toks.some((t) => deps.lexicon.lookup(t.text).some((w) => w.tags.includes('name'))))
    return 'blank would cover a name';
  return undefined;
}

const MISSING_PROMPT: Partial<Record<ResolvedEdit['kind'], string>> = {
  particle: 'A small word (a particle) is missing here.',
  measure_word: 'A measure word is missing here.',
};
const REPLACE_PROMPT: Partial<Record<ResolvedEdit['kind'], string>> = {
  wrong_word: 'Use the right word here.',
  measure_word: 'Use the right measure word.',
  particle: 'Use the right particle.',
  other: 'Fix the wording here.',
};

/** Tokens for the reordering exercise: punctuation stays glued to the word
 * before it, so only words move. */
export function orderTokens(corrected: string, lexicon: Lexicon): string[] {
  const out: string[] = [];
  let pending = '';
  for (const t of segment(corrected, lexicon)) {
    if (t.kind === 'punct' && out.length > 0) out[out.length - 1] += t.text;
    else if (t.kind === 'punct') pending += t.text;
    else {
      out.push(pending + t.text);
      pending = '';
    }
  }
  return out;
}

function fixPlan(edits: ResolvedEdit[], prompt = 'Rewrite this sentence so it is correct.'): ItemPlan {
  return { key: 'fix', kind: 'fix', prompt, edits };
}

/** Part C: decide the exercise for every edit of a verified sentence, from
 * the edits alone. Larger rewrites become one "Fix my sentence" item. */
export function planSentenceItems(
  vs: Pick<VerifiedSentence, 'original' | 'corrected' | 'edits'>,
  deps: Pick<BuildItemsDeps, 'lexicon' | 'protectedTerms'>,
): { plans: ItemPlan[]; unbuildable: Unbuildable[] } {
  const { original, corrected } = vs;
  const edits = vs.edits.filter((e) => !isPunctuationOnly(e.before + e.after));
  if (edits.length === 0) return { plans: [], unbuildable: [] };

  const tokensO = segment(original, deps.lexicon);
  const tokensC = segment(corrected, deps.lexicon);
  const changedTokens = (e: ResolvedEdit) =>
    Math.max(tokensIn(tokensO, e.start, e.end).length, tokensIn(tokensC, e.cStart, e.cEnd).length);

  const ordering = edits.filter((e) => e.kind === 'word_order');
  const rest = edits.filter((e) => e.kind !== 'word_order');

  const plans: ItemPlan[] = [];
  if (ordering.length > 0) {
    const tokens = orderTokens(corrected, deps.lexicon);
    plans.push(
      tokens.length >= REORDER_MIN_TOKENS && tokens.length <= REORDER_MAX_TOKENS
        ? {
            key: 'order',
            kind: 'reorder',
            prompt: 'Put the words in the right order.',
            edits: ordering,
            tokens,
          }
        : fixPlan(ordering),
    );
  }

  // Any larger rewrite makes the whole sentence one "Fix my sentence" item.
  if (rest.some((e) => changedTokens(e) > MAX_BLANK_TOKENS)) return { plans: [fixPlan(edits)], unbuildable: [] };

  const unbuildable: Unbuildable[] = [];
  rest.forEach((e, i) => {
    const key = `e${i}`;
    const shape = editShape(e);
    if (shape === 'deletion') {
      const hit = tokensIn(tokensO, e.start, e.end);
      const idx = tokensO.indexOf(hit[0]!);
      const only = hit.length === 1 && hit[0]!.start === e.start && hit[0]!.end === e.end;
      const tok = hit[0];
      if (
        !only ||
        !tok ||
        tok.kind !== 'word' ||
        NUMERAL.test(tok.text) ||
        deps.protectedTerms.some((p) => occurrences(original, p).some((o) => overlaps(o, [e.start, e.end])))
      ) {
        unbuildable.push({ reason: `${key}: the extra text is not a single plain word` });
        return;
      }
      plans.push({
        key,
        kind: 'extra_word',
        prompt: "One word here doesn't belong. Tap it.",
        edits: [e],
        tokens: tokensO.map((t) => t.text),
        extraTokenIndex: idx,
      });
      return;
    }
    const blank: Span = [e.cStart, e.cEnd];
    const problem = blankProblem(corrected, blank, tokensC, deps);
    // the learner's side of a swap must be plain words too
    const beforeProblem =
      shape === 'replacement' && NUMERAL.test(e.before) ? 'the replaced text is a number' : undefined;
    if (problem || beforeProblem) {
      unbuildable.push({ reason: `${key}: ${problem ?? beforeProblem}` });
      return;
    }
    if (shape === 'insertion') {
      plans.push({
        key,
        kind: 'cloze',
        prompt: MISSING_PROMPT[e.kind] ?? 'A word is missing here.',
        edits: [e],
        blank,
      });
    } else if (e.kind === 'mainland_style') {
      plans.push({ key, kind: 'choice', prompt: 'Pick the Taiwan word.', edits: [e], blank });
    } else {
      plans.push({
        key,
        kind: 'cloze',
        prompt: REPLACE_PROMPT[e.kind] ?? 'Use the right word here.',
        edits: [e],
        blank,
        choiceFallback: true,
      });
    }
  });
  return { plans, unbuildable };
}

const withFill = (corrected: string, blank: Span, fill: string) =>
  corrected.slice(0, blank[0]) + fill + corrected.slice(blank[1]);

/** Everything a lexicon says is an accepted spelling of `text`. */
function lexiconSpellings(text: string, lexicon: Lexicon): string[] {
  const out = new Set<string>();
  for (const w of lexicon.lookup(text)) {
    out.add(w.headword);
    for (const v of w.variants) out.add(v);
  }
  out.delete(text);
  return [...out];
}

type Built = { exercise: ErrorExercise } | { dropped: string };

async function wrongOptionIsWrong(
  deps: BuildItemsDeps,
  vs: VerifiedSentence,
  plan: ItemPlan,
): Promise<boolean> {
  const e = plan.edits[0]!;
  const probe = withFill(vs.corrected, plan.blank!, e.before);
  const res = await verifySentenceText(deps, probe, { avoidProvider: vs.servedBy });
  // a sentence the checker likes with the learner's wording means the "fix" is optional
  return !res.ok;
}

function choiceExercise(plan: ItemPlan): ErrorExercise {
  const e = plan.edits[0]!;
  return {
    kind: 'choice',
    prompt: plan.kind === 'choice' ? plan.prompt : 'Pick the right word.',
    blankStart: plan.blank![0],
    blankEnd: plan.blank![1],
    answer: e.after,
    accepted: [e.after],
    options: [e.before, e.after],
  };
}

async function finalizePlan(
  deps: BuildItemsDeps,
  vs: VerifiedSentence,
  plan: ItemPlan,
): Promise<Built> {
  const e = plan.edits[0]!;
  switch (plan.kind) {
    case 'fix':
      return { exercise: { kind: 'fix', prompt: plan.prompt, accepted: [vs.corrected] } };
    case 'reorder':
      return {
        exercise: {
          kind: 'reorder',
          prompt: plan.prompt,
          tokens: plan.tokens,
          accepted: [vs.corrected],
        },
      };
    case 'extra_word':
      return {
        exercise: {
          kind: 'extra_word',
          prompt: plan.prompt,
          tokens: plan.tokens,
          extraTokenIndex: plan.extraTokenIndex,
          accepted: [],
        },
      };
    case 'choice':
      return (await wrongOptionIsWrong(deps, vs, plan))
        ? { exercise: choiceExercise(plan) }
        : { dropped: "the learner's wording also reads fine, so the change isn't needed" };
    case 'cloze': {
      const blank = plan.blank!;
      const target = vs.corrected.slice(blank[0], blank[1]);
      const solved = await deps.llm.solveJournalCloze({
        sentence: withFill(vs.corrected, blank, BLANK),
        en: vs.en,
        hint: plan.prompt,
      });
      const targetKey = normaliseAnswer(target);
      const found = solved.answers.map(normaliseAnswer);
      const decidable = solved.confident && found.includes(targetKey);
      if (!decidable) {
        if (plan.choiceFallback && (await wrongOptionIsWrong(deps, vs, plan)))
          return { exercise: { ...choiceExercise(plan), solver: solved } };
        return { dropped: 'the answer cannot be decided from the sentence and the hint' };
      }
      const accepted = [target, ...lexiconSpellings(target, deps.lexicon)];
      // A different fill the solver found is accepted only if the whole sentence passes.
      let tried = 0;
      for (const alt of solved.answers) {
        const key = normaliseAnswer(alt);
        if (!key || key === targetKey || accepted.some((a) => normaliseAnswer(a) === key)) continue;
        if (tried++ >= MAX_SOLVER_ALTERNATIVES) break;
        const res = await verifySentenceText(deps, withFill(vs.corrected, blank, alt), {
          en: vs.en,
          avoidProvider: vs.servedBy,
        });
        if (res.ok) accepted.push(alt);
      }
      return {
        exercise: {
          kind: 'cloze',
          prompt: plan.prompt,
          blankStart: blank[0],
          blankEnd: blank[1],
          answer: e.after,
          accepted,
          solver: solved,
        },
      };
    }
  }
}

const issueType = (kind: ResolvedEdit['kind']): IssueType =>
  kind === 'mainland_style' ? 'mainland_style' : 'error';

export interface SentenceItemsResult {
  items: ErrorItem[];
  dropped: DroppedItem[];
}

/**
 * Parts C + the solver test for one verified sentence. Only a sentence that
 * passed Part B ever reaches here; a rejected one yields nothing. Each edit
 * becomes its own item on the fully corrected sentence.
 */
export async function buildSentenceItems(
  deps: BuildItemsDeps,
  entryId: string,
  sentenceIndex: number,
  vs: VerifiedSentence,
): Promise<SentenceItemsResult> {
  if (vs.status !== 'verified') return { items: [], dropped: [] };
  const { plans, unbuildable } = planSentenceItems(vs, deps);
  const dropped: DroppedItem[] = unbuildable.map((u) => ({
    sentenceId: vs.id,
    plan: u.reason.split(':')[0]!,
    reason: u.reason,
  }));
  const items: ErrorItem[] = [];
  for (const plan of plans) {
    const built = await finalizePlan(deps, vs, plan);
    if ('dropped' in built) {
      dropped.push({ sentenceId: vs.id, plan: plan.key, reason: built.dropped });
      continue;
    }
    const first = plan.edits[0]!;
    const marksOriginal = plan.edits.map((e): Span => [e.start, e.end]);
    const ex = built.exercise;
    const hasBlank = ex.blankStart !== undefined && ex.blankEnd !== undefined;
    // Phase 16 rules on the exercise's own sentence: a failure is a visible
    // blocked item (with the reason), never a silently dropped one.
    const ruleReasons = hasBlank
      ? checkJournalClozeRules(
          {
            sentence: vs.corrected,
            blankStart: ex.blankStart!,
            blankEnd: ex.blankEnd!,
            answer: vs.corrected.slice(ex.blankStart!, ex.blankEnd!),
          },
          { lexicon: deps.lexicon, allowedNames: deps.protectedTerms.filter((t) => /[A-Za-z]/.test(t)) },
        )
      : checkJournalSentenceRules(vs.corrected, {
          lexicon: deps.lexicon,
          allowedNames: deps.protectedTerms.filter((t) => /[A-Za-z]/.test(t)),
        });
    items.push({
      id: `v2:${entryId}:${sentenceIndex}:${plan.key}`,
      journalEntryId: entryId,
      original: vs.original,
      corrected: vs.corrected,
      span: marksOriginal[0]!,
      type: issueType(first.kind),
      pattern: first.pattern,
      itemRef: first.itemRef,
      card: emptyCard(deps.now),
      flagged: false,
      createdAt: deps.now,
      version: 2,
      status: ruleReasons.length > 0 ? 'blocked' : 'active',
      ...(ruleReasons.length > 0 ? { blockedReason: ruleReasons.join('; ') } : {}),
      ...(hasBlank ? { blank: [ex.blankStart!, ex.blankEnd!] as Span } : {}),
      en: vs.en,
      explanationEn: plan.edits.map((e) => e.explanationEn).join(' '),
      editKind: first.kind,
      marks: { original: marksOriginal, corrected: plan.edits.map((e): Span => [e.cStart, e.cEnd]) },
      exercise: built.exercise,
    });
  }
  return { items, dropped };
}
