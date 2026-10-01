# Phase 5 brief: Journal mode and error bank

> Paste into Claude Code with `CLAUDE.md` at the repo root. Phases 1–4 must be merged.

## Goal

A journal where the learner writes freely, notices their own mistakes first, gets a small number of typed, explained corrections, and has every mistake flow back into review. This is the highest-value feature; correctness and tone matter more than breadth.

## Scope

1. **Writing prompts**: daily prompt with "try to use these 3 due words" (from the due queue, production skill preferred), plus free write. Show the prompt words; check them off as used.
2. **Gap capture**: learner can write English in brackets mid-sentence (`今天我去 [gym]`). On submit, each bracket gets a Taiwan-appropriate translation (lexicon first, then LLM), shown inline, and the word is added as a **high-priority new item** (existing word or `custom`).
3. **Proxy endpoint** `POST /v1/journal-review` and `TutorLLM.reviewJournal()`:
   ```ts
   interface JournalReview {
     issues: {
       span: [number, number];              // char offsets in the original
       type: 'error' | 'unnatural' | 'mainland_style';
       pattern?: string;                     // grammar item id or short label, e.g. "了-placement"
       itemRef?: ItemRef;                    // word/grammar the issue is about
       correction: string;
       explanationEn: string;
       confidence: 'high' | 'medium' | 'low';
     }[];
     natural_rewrite: string;
     brackets: { en: string; zh: string; wordId?: string }[];
     used_well: { itemRef: ItemRef; span: [number, number] }[]; // correct, unprompted uses
   }
   ```
   - Prompt asks for **at most 3 issues**, prioritizing errors over style, and recurring patterns (pass the learner's top recent error patterns in the request).
   - Validate in code: spans in range, corrections pass `checkTaiwanness`, rewrite is traditional-only, `used_well` items actually appear in the text (re-segment to confirm).
4. **Self-correction flow**:
   1. Submit → highlight suspicious spans only (no answers), coloured by type: red = error, amber = unnatural, blue = mainland vs. Taiwan.
   2. Learner edits the highlighted spans. Re-check just those spans (local compare with `correction`, plus an LLM check for alternatives, cached).
   3. Reveal corrections, explanations and the natural rewrite. Self-fixed issues are marked as such.
5. **Trust controls**: "flag this correction" (stores a flag, excludes it from the error bank, and counts in a dev metric) and "explain more" (follow-up call). Copy in the UI must not present corrections as infallible.
6. **Evidence**:
   - `used_well` → `journal_correct_use` (production).
   - An issue with an `itemRef` → `journal_misuse` (production). Self-fixed issues get a milder effect (config).
   - Prompt words used correctly count as `journal_correct_use`.
7. **Error bank**: each non-flagged issue becomes an `ErrorItem` scheduled with FSRS, reviewed as a cloze of the corrected sentence (blank on the corrected span), sourced into Phase 4's session builder with priority for recurring patterns.
   ```ts
   interface ErrorItem {
     id: string; journalEntryId: string;
     original: string; corrected: string; span: [number, number];
     type: 'error' | 'unnatural' | 'mainland_style';
     pattern?: string; itemRef?: ItemRef;
     card: import('ts-fsrs').Card; flagged: boolean; createdAt: Date;
   }
   ```
8. **Entry summary**: level analysis via `analyzeText` ("mostly Level 2 words, 3 L3 words"), words used, patterns to watch. A simple chart over time of errors per 100 chars and pattern recurrence.
9. Journal sentences become a cloze source (fill the Phase 4 stub).
10. Dexie tables: `journalEntries`, `journalReviews`, `errorItems`.

## Non-goals

- No handwriting input.
- No sharing, social or teacher review.
- No grading score/percentage for an entry.

## Acceptance criteria

- Never more than 3 issues shown per entry; errors outrank style when capped (test with fixtures).
- Bracket gaps become high-priority items that appear in the next review session.
- Self-correction step comes before any reveal and correctly credits self-fixes.
- Flagged corrections never enter the error bank.
- Error-bank items appear as clozes in review sessions, and repeated patterns are prioritized.
- Response validation rejects out-of-range spans, simplified output and mainland-style "corrections" (fixtures).
- A 10-entry fixture set run through the real model is saved in `docs/journal-eval.md` with a human-readable verdict per correction, as a baseline for prompt changes.

## Dependencies

Phase 1 segmenter/`checkTaiwanness`; Phase 2 learner model and evidence; Phase 3 proxy, `TutorLLM`, `analyzeText`; Phase 4 cloze engine and session builder.
