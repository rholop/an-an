# Phase 4 brief: Cloze and review variety

> Paste into Claude Code with `CLAUDE.md` at the repo root. Phases 1–3 must be merged.

## Goal

Turn review into production practice: cloze exercises built preferentially from the learner's own chat history, with a difficulty ladder per word, plus an offline example-sentence bank so review never needs a live LLM call.

## Scope

1. **Sentence bank** (pipeline + proxy `POST /v1/sentences`, run offline in batches):
   - For each word, generate 3–5 example sentences using only words at or below its level (plus the word). Validate with `analyzeText` from Phase 3; drop failures. Store with `{ id, zh, en, targetWordId, level, tokens, source: 'generated' }`.
   - A second-pass check (a different model call or rules) for naturalness; flag doubtful ones. Export a sample of 100 to `data/build/sentence-sample.md` for manual spot-check.
   - Ship as `sentences.v{N}.json`, lazy-loaded per level. Start with N1–L2 only; add levels later.
2. **Cloze source selection** (`core/cloze/source.ts`): for a due item, prefer in order: a learner journal sentence (Phase 5, stub now) → an NPC or learner line from chat history containing the word → a sentence-bank sentence → none (fall back to plain card). The sentence must itself pass coverage for the learner's current known set, apart from the blank.
3. **Difficulty ladder** per item + skill, stored on the card as `clozeRung`:
   - Rung 1: **word bank** (choose from 4–6 chips incl. the answer)
   - Rung 2: **multiple choice** with confusable distractors (same level, shared character, similar meaning or same POS)
   - Rung 3: **typed from memory**
   - Promote after 2 consecutive correct at a rung with no hint; demote one rung on a lapse. Rungs 1–2 feed `recognition`, rung 3 feeds `production`.
4. **Typed answers**: support the learner's preferred input: system IME (typed characters compared directly), in-app **pinyin** input (numeric or tone-marked, tone-insensitive option), and in-app **zhuyin** input. Normalize: accept variants from the lexicon, strip punctuation/spacing, and give "right word, wrong tone" partial credit (→ `cloze_correct_hint`).
5. **Exercise variety** (small, reuse same infrastructure):
   - Sentence reordering (tokens shuffled; rebuild).
   - English → Chinese production (typed; graded by exact/variant match, with an optional LLM "is this acceptable?" check for near-misses, results cached).
   - "Which sounds more natural?" pairs, e.g. Taiwan vs. mainland phrasing, 了 placement.
6. **Session builder**: interleave items across topics and exercise types; cap new items per session; show the source ("from your chat with 阿美 on Tuesday") because personal context aids memory.
7. **Leech treatments** from Phase 2 get real implementations: `new_context` (pick a sentence not seen before), `contrast_confusable` (side-by-side MC with the word it's confused with).
8. Every exercise result emits the `cloze_*` evidence types.

## Non-goals

- No handwriting/stroke order (stretch, later).
- No audio exercises (the game is text-only).
- No live LLM generation during a review session (bank + history only; the optional acceptability check is the only exception).

## Acceptance criteria

- Sentence bank for N1–L2 builds, with ≥ 3 validated sentences for ≥ 95% of words, and a spot-check sample file.
- For a learner with chat history, ≥ 50% of cloze items in a session come from their own chats (test with seeded data).
- Ladder promotion/demotion is unit-tested; the rung is visible in the item detail view.
- Pinyin, zhuyin and IME input all grade correctly on a fixture set including heteronyms and variant forms.
- Distractors never include a correct alternative answer (test: sentence where two options would fit gets excluded or fixed).
- A full 20-item session works offline.

## Dependencies

Phase 1 lexicon/segmenter; Phase 2 learner model, ladder state on cards, leech flags; Phase 3 `analyzeText`, persisted chat turns, proxy.
