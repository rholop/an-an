import type { Lexicon } from '../lexicon.js';
import type { Level } from '../types.js';
import { BLANK, buildSentenceItems, type DroppedItem } from './buildItems.js';
import { prepareSentences, type VerifiedSentenceRef } from './pipeline.js';
import type { ErrorItem, ModelSentenceReview, ProviderName } from './types.js';
import { verifyCorrected, type JournalLLM } from './verifyCorrected.js';

// Phase 17 Part F: run the real pipeline over a fixed set of learner sentences
// and report what came out, so every prompt change can be compared with the
// baseline and read by a human. Pure: callers supply the models and write the file.

export interface EvalFixture {
  id: string;
  category: string;
  original: string;
  /** A human-written correction, for the reader (never used to grade). */
  reference: { corrected: string; en: string };
  note?: string;
}

export interface EvalFixtureFile {
  learnerLevel: Level;
  protectedTerms: string[];
  entries: EvalFixture[];
}

/** One review call for a batch of sentences (the real thing is POST /v1/journal-review). */
export type EvalReviewer = (
  sentences: string[],
  protectedTerms: string[],
) => Promise<{ reviews: ModelSentenceReview[]; servedBy?: ProviderName }>;

export interface EvalResult {
  fixture: EvalFixture;
  modelReview?: ModelSentenceReview;
  verified?: VerifiedSentenceRef;
  items: ErrorItem[];
  dropped: DroppedItem[];
  /** Hard-rule breaches found by the harness itself. Must be empty. */
  violations: string[];
  error?: string;
}

const NUMERAL = /[0-9０-９零〇一二兩三四五六七八九十百千萬億]/;

/** The rules a built item must never break, checked independently of the builder. */
export function checkItemInvariants(
  item: ErrorItem,
  verified: Pick<VerifiedSentenceRef, 'corrected' | 'status'>,
  protectedTerms: readonly string[],
): string[] {
  const out: string[] = [];
  if (verified.status !== 'verified') out.push('item built from a sentence that failed the check');
  if (item.corrected !== verified.corrected) out.push('item sentence is not the verified corrected sentence');
  const ex = item.exercise;
  if (!ex) return [...out, 'no exercise'];
  if (ex.blankStart !== undefined && ex.blankEnd !== undefined) {
    const blanked = item.corrected.slice(ex.blankStart, ex.blankEnd);
    if (!blanked) out.push('empty blank');
    if (protectedTerms.some((p) => blanked.includes(p) || p.includes(blanked)))
      out.push(`blank covers a protected name (${blanked})`);
    if (NUMERAL.test(blanked)) out.push(`blank covers a number (${blanked})`);
    if (/[，。、！？,.!?；;：:]/.test(blanked)) out.push(`blank covers punctuation (${blanked})`);
    if ([...blanked].length > 4) out.push(`blank is long (${blanked})`);
    if (blanked !== ex.answer) out.push('answer is not the blanked text');
    if (!ex.accepted.includes(ex.answer ?? '')) out.push('the answer is not accepted');
  }
  if (ex.kind === 'extra_word' && ex.extraTokenIndex !== undefined) {
    const tok = ex.tokens?.[ex.extraTokenIndex] ?? '';
    if (protectedTerms.some((p) => tok.includes(p))) out.push('tap target is a protected name');
    if (NUMERAL.test(tok)) out.push('tap target is a number');
  }
  return out;
}

export async function runJournalClozeEval(
  file: EvalFixtureFile,
  deps: { lexicon: Lexicon; llm: JournalLLM; review: EvalReviewer; now: Date; batchSize?: number },
): Promise<EvalResult[]> {
  const { entries, protectedTerms, learnerLevel } = file;
  const results: EvalResult[] = [];
  const batch = deps.batchSize ?? 8;
  for (let i = 0; i < entries.length; i += batch) {
    const group = entries.slice(i, i + batch);
    let reviews: ModelSentenceReview[] = [];
    let servedBy: ProviderName | undefined;
    let reviewError: string | undefined;
    try {
      const res = await deps.review(
        group.map((f) => f.original),
        protectedTerms,
      );
      reviews = res.reviews;
      servedBy = res.servedBy;
    } catch (err) {
      reviewError = String(err);
    }
    for (const [k, fixture] of group.entries()) {
      const result: EvalResult = { fixture, items: [], dropped: [], violations: [] };
      results.push(result);
      const prepared = prepareSentences(fixture.original)[0];
      const modelReview = reviews.find((r) => r.index === k);
      if (reviewError || !prepared || !modelReview) {
        result.error = reviewError ?? (prepared ? 'the model returned nothing for this sentence' : 'sentence is not reviewable');
        continue;
      }
      result.modelReview = modelReview;
      try {
        const sentenceDeps = {
          lexicon: deps.lexicon,
          llm: deps.llm,
          protectedTerms,
          learnerLevel,
          now: deps.now,
        };
        const verified = await verifyCorrected(sentenceDeps, {
          original: fixture.original,
          start: 0,
          end: fixture.original.length,
          review: modelReview,
          servedBy,
          now: deps.now,
        });
        result.verified = { ...verified, index: 0 };
        const built = await buildSentenceItems(sentenceDeps, fixture.id, 0, verified);
        result.items = built.items;
        result.dropped = built.dropped;
        for (const item of built.items)
          result.violations.push(...checkItemInvariants(item, verified, protectedTerms));
      } catch (err) {
        result.error = String(err);
      }
    }
  }
  return results;
}

const clip = (s: string) => s.replace(/\|/g, '\\|');

/** The report a human reads: one block per sentence, a blank verdict for each item. */
export function renderEvalReport(
  results: readonly EvalResult[],
  meta: { generatedAt: string; source: string; promptVersion: string },
): string {
  const lines: string[] = [
    '# Journal cloze eval',
    '',
    `Generated ${meta.generatedAt} against ${meta.source} (prompts ${meta.promptVersion}).`,
    '',
    'Baseline for prompt changes (phase doc 17 Part F). Read every block and replace each `_pending_`',
    'with **✅ good**, **⚠️ acceptable but could be better**, or **❌ wrong** (a wrong sentence shown,',
    'or a correct fix rejected). Ship only when no item is ❌.',
    '',
  ];
  const verified = results.filter((r) => r.verified?.status === 'verified').length;
  const rejected = results.filter((r) => r.verified?.status === 'rejected').length;
  const errored = results.filter((r) => r.error).length;
  const items = results.reduce((n, r) => n + r.items.length, 0);
  const violations = results.reduce((n, r) => n + r.violations.length, 0);
  lines.push(
    '## Summary',
    '',
    `- sentences: ${results.length} (verified ${verified}, rejected ${rejected}, errors ${errored})`,
    `- items built: ${items}`,
    `- hard-rule violations found by the harness: **${violations}** (must be 0)`,
    '',
  );
  for (const r of results) {
    const f = r.fixture;
    lines.push(`## ${f.id} (${f.category})`, '', `- You wrote: ${f.original}`);
    lines.push(`- Reference (human): ${f.reference.corrected} — ${f.reference.en}`);
    if (f.note) lines.push(`- Note: ${f.note}`);
    if (r.error) {
      lines.push(`- **Error:** ${r.error}`, '');
      continue;
    }
    const v = r.verified!;
    lines.push(
      `- Model corrected: ${r.modelReview?.corrected ?? '—'}`,
      `- Check: **${v.status}**${v.reason ? ` — ${v.reason}` : ''}${v.status === 'verified' ? ` → ${v.corrected} (${v.en})` : ''}`,
    );
    if (v.status === 'verified') {
      lines.push(
        `- Edits: ${v.edits.length === 0 ? '_none (already correct)_' : v.edits.map((e) => `\`${e.before || '∅'}\`→\`${e.after || '∅'}\` ${e.kind}${v.modelEditsUsable ? '' : ' (from diff)'}`).join('; ')}`,
      );
    }
    for (const it of r.items) {
      const ex = it.exercise!;
      const shown =
        ex.blankStart !== undefined
          ? it.corrected.slice(0, ex.blankStart) + BLANK + it.corrected.slice(ex.blankEnd)
          : ex.kind === 'extra_word'
            ? it.original
            : ex.kind === 'fix'
              ? it.original
              : (ex.tokens ?? []).join(' / ');
      lines.push(
        `- Item **${ex.kind}** — “${ex.prompt}” → ${clip(shown)}`,
        `  - answer: ${ex.answer ?? ex.tokens?.[ex.extraTokenIndex ?? -1] ?? it.corrected}; accepted: ${ex.accepted.join(' | ') || '—'}${ex.options ? `; options: ${ex.options.join(' / ')}` : ''}${ex.solver ? `; solver: ${ex.solver.answers.join(' / ') || '—'} (${ex.solver.confident ? 'confident' : 'not confident'})` : ''}`,
        `  - Verdict: _pending_`,
      );
    }
    for (const d of r.dropped) lines.push(`- Dropped (${d.plan}): ${d.reason}`);
    for (const x of r.violations) lines.push(`- ❌ **VIOLATION:** ${x}`);
    if (r.items.length === 0 && r.dropped.length === 0 && v.status === 'verified')
      lines.push('- _no items_ — verdict: _pending_');
    lines.push('');
  }
  return lines.join('\n');
}

/** An offline stand-in for the models, built from the fixtures' own reference
 * corrections: the reviewer returns the reference, the checker approves what the
 * rules allow, and the solver is a perfect one (it reads the answer off the
 * reference). Used to test the harness and the whole pipeline without keys. */
export function dryEvalModels(file: EvalFixtureFile): { llm: JournalLLM; review: EvalReviewer } {
  const byOriginal = new Map(file.entries.map((f) => [f.original, f]));
  const references = file.entries.map((f) => f.reference.corrected);
  return {
    review: async (sentences) => ({
      reviews: sentences.map((s, index) => {
        const f = byOriginal.get(s);
        return { index, corrected: f?.reference.corrected ?? s, en: f?.reference.en ?? '', edits: [] };
      }),
    }),
    llm: {
      async fixJournalSentence() {
        throw new Error('dry run: no retry');
      },
      async verifyJournalSentence() {
        return { ok: true, problem: '', meaningMatches: true };
      },
      async solveJournalCloze(req) {
        const at = req.sentence.indexOf(BLANK);
        const prefix = req.sentence.slice(0, at);
        const suffix = req.sentence.slice(at + BLANK.length);
        const ref = references.find((r) => r.startsWith(prefix) && r.endsWith(suffix) && r.length > prefix.length + suffix.length);
        const answer = ref?.slice(prefix.length, ref.length - suffix.length);
        return { answers: answer ? [answer] : [], confident: Boolean(answer) };
      },
    },
  };
}
