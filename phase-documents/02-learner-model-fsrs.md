# Phase 2 brief: Learner model + FSRS

> Paste into Claude Code with `CLAUDE.md` at the repo root. Phase 1 must be merged.

## Goal

Decide what "knows a word" means, persist it locally, schedule reviews with FSRS, and prove it with a simple review screen, a placement test and Anki import. At the end a learner can place themselves, import their Anki deck, and do daily reviews that schedule correctly.

## Scope

1. **Learner model** (`packages/core/learner`):
   - Per item, per skill (`recognition`, `production`) an FSRS card (`ts-fsrs` `Card`), plus an `ItemState` (`unseen → introduced → learning → review → mature`). Mature = stability ≥ 21 days (configurable).
   - `applyEvidence(model, evidence, now): ModelUpdate` is the **only** way the model changes. Map evidence to FSRS ratings and weights in one config table:

     | Evidence | Effect |
     |---|---|
     | `review_again/hard/good/easy` | FSRS rating directly |
     | `cloze_correct_nohint` | Good on production (typed) or recognition (choice) |
     | `cloze_correct_hint` | Hard |
     | `cloze_wrong` | Again |
     | `journal_correct_use` | Good on production (strongest positive; unprompted) |
     | `journal_misuse` | Hard on production (partial lapse), not Again |
     | `chat_read_no_lookup` | Weak positive: no FSRS review; nudge a `familiarity` counter, and only count as a Good if the card is due and it happens ≥ 2 times |
     | `chat_lookup_gloss` | Again on recognition if card is in review; otherwise introduce |
     | `chat_hover_reading` | Doesn't touch meaning; tracks a separate `readingDependence` score used for pinyin fading |
     | `anki_import_seen` | state `review` with a conservative initial stability, flagged `imported` |
     | `placement_known/unknown` | initial state + stability only |

     Weak signals must never cause a card to be scheduled as a full review. Keep the mapping in data, not scattered `if`s.
   - **Character stats**: per char, a derived strength = max/mean of known words containing it. Expose `transparency(word)` = share of its chars already strong. Used for pacing.
   - **Leech detection**: ≥ 4 lapses (configurable) marks `leech: true` and records which treatments were tried. `nextLeechTreatment(item)` returns one of `new_context | char_breakdown | mnemonic_prompt | contrast_confusable`. Phase 2 just shows the char breakdown; others are stubs.
   - **Pinyin fading**: `readingDisplay(item)` returns `'shown' | 'hover'` based on recognition strength and `readingDependence`. The `AnnotatedText` component respects this when the user's mode is `auto`.
2. **Frontier / unlock logic** (`core/curriculum`):
   - `nextNewItems(model, lexicon, n, context)`: picks new words from the current level, ordered by (freqRank, scenario tag match, transparency). When ≥ X% (default 70%) of the current level is in `review`+, start mixing in next-level words at a trickle (default 20% of new items). Levels are a frontier, not a gate.
   - Custom/supplement words enter the same queue with their own priority.
3. **Persistence** (`apps/web`, Dexie):
   - Tables: `items` (itemRef+skill → card, state, flags), `evidence` (append-only event log), `settings`, `meta` (lexicon version, schema version).
   - A `LearnerRepo` interface in `core`, Dexie implementation in `web`.
   - **Export/import** full JSON backup; import validates with zod and refuses a newer schema version.
   - **Lexicon migration**: on a new lexicon version, apply the ID-migration map from Phase 1 to saved items.
4. **Review screen**: due queue (interleaved across topics, never grouped), front = headword (recognition) or English + context (production), reveal, four buttons. Shows due counts and a forecast for the next 7 days.
5. **Placement test**: adaptive, ~40–60 taps. Sample words across levels, binary-search the level where "I know this" drops below ~50%, then confirm a few. Words well below the boundary → `review` flagged `probablyKnown` (first review is light verification); above → `unseen`. Also a manual "start at level X" option.
6. **Anki import**: accept an Anki **text export** (tsv/csv, user picks the column holding the headword) first. Match by headword against lexicon, including variants; report matched / ambiguous / unmatched. Unmatched words can be added as `custom`. `.apkg` import is a stretch goal (zip + SQLite via sql.js; newer `collection.anki21b` is zstd-compressed, so document the "export for older Anki versions" path if you don't support it).
7. **Hook up Phase 1 lookup events** in the reader page to `applyEvidence`.

## Non-goals

- No chat, cloze generation, journal or LLM calls.
- No server sync. Local-first only.
- No gamification.

## Data models (additions)

```ts
interface SkillCard {
  item: ItemRef; skill: Skill;
  card: import('ts-fsrs').Card;
  state: ItemState;
  lapses: number; leech: boolean; leechTreatmentsTried: string[];
  familiarity: number; readingDependence: number;
  flags: { imported?: boolean; probablyKnown?: boolean };
  updatedAt: Date;
}
interface LearnerRepo {
  getCard(item: ItemRef, skill: Skill): Promise<SkillCard | undefined>;
  putCards(cards: SkillCard[]): Promise<void>;
  appendEvidence(e: Evidence[]): Promise<void>;
  dueCards(now: Date, limit: number): Promise<SkillCard[]>;
  knownSet(minState: ItemState): Promise<Set<string>>; // used by Phase 3 validator
}
```

## Acceptance criteria

- `applyEvidence` is pure and fully unit-tested against the mapping table, with injected `now`. A simulated 60-day run of a synthetic learner shows retention within ±5 points of the target.
- Weak signals (`chat_read_no_lookup`) never produce a full FSRS review on their own.
- Leech flag triggers at the configured threshold and the review screen shows the char breakdown.
- Review screen works offline (PWA) and survives reload with no lost state.
- Export → wipe → import round-trips to identical DB content.
- Placement test finishes in under 60 taps and sets states; the result is visible in a level-by-level summary.
- Anki text import of a 3,000-row deck completes in seconds and shows a match report.
- `knownSet()` returns the right items; Phase 3 depends on it.

## Dependencies

Phase 1: `Lexicon`, stable IDs + migration map, `AnnotatedText` lookup events.
