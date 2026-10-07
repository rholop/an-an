# Phase 20: Where the review pile came from (as built)

Ezra's report: review showed very obscure, difficult words, and one day had 224 cards due.

## Causes found in the code (all fixed)

1. **Bulk actions put every card on the same day.** Placement marked every word below the
   boundary as known with a 1.5-day first interval (`applyPlacement`), and an Anki import used
   3 days (`applyAnkiImportSeen`). Every card from one placement or import fell due on **one
   day**. A "start at N2" placement alone is ~424 words; even a partial one easily makes a
   200+ day. *Fix:* bulk-created cards get spread first due dates (`spreadBulkDue`): at least
   a 2–4 week window, widened so one action never puts more than half the daily cap on any
   day (a 3,000-card import spreads over ~75 days). The v9 migration re-spreads existing bulk
   cards that were never reviewed in the app.
2. **New words were picked from 17,033 level-less MOE compounds.** `nextNewItems` treated
   every `level: null` word as "in the current level" (`w.level === frontier || w.level ===
   null`). Those are the supplementary MOE compound entries (輕省, 料定, 討飯, 笑林…), which
   then reached chat targets and review. *Fix:* new picks come only from TOCFL, textbook and
   the learner's own words (`newItemInBounds`), never names.
3. **Every lookup created a card**, and so did every word a chat reply let through the
   validator (Phase 3 and 18 "leaked" words), including rare words several levels up.
   *Fix:* a lookup creates a card on its own only for TOCFL words up to the picked level + 1,
   textbook words and the learner's own words. Anything else shows **Add to review** in the
   popover instead. Validator leaks are tagged (`chat_leak`) and gated the same way.
4. **No daily cap, and new cards kept coming during a backlog.** *Fix:* a daily cap (default
   80, Settings → Review). Over the cap, the session takes the study order first, then the
   cards most likely forgotten; the rest stay due. No new cards when due is over the cap,
   half when it's over half the cap. Home shows a 7-day forecast and says when new words are
   paused.

## On Ezra's own data

The real counts need Ezra's data, which lives in the browser and the sync server. To produce
them: Settings → export a backup, then

```
pnpm --filter @anan/data-pipeline review-pile path/to/anan-ron-YYYY-MM-DD.json docs/review-pile-ron.md
```

It reports cards by source and level, the busiest due days and what fell due on each, the days
that created 50+ cards, and the obscure cards with their sources. The same counts are in the app
under **Review settings → Where your review pile comes from**.

A synthetic backup built with the old code (a 200-word placement plus 24 chat lookups of MOE
compounds) shows the pattern exactly: all 224 cards due on the day after the placement, and the
"not in any list" cards all from chat lookups.

## Nope

Every flashcard (review, lesson vocabulary, garden, cloze) has **Nope**: one tap takes the whole
word (all skills) out of review, with Undo and Change:

- **Not now** (default): back to the unstudied pool; returns when its level becomes the picked
  level or its lesson becomes the active study step (and wasn't when it was snoozed).
- **I already know it**: both skills scheduled 60 days out, counts as known; counts toward
  lesson mastery only after a later review passes.
- **Never show this**: out of review, new items, cloze, chat targets and journal prompts. It can
  still be looked up.

Logged as `review_nope` (never a lapse). Not now / Never show words drop out of lesson mastery
counts. **Review settings** has bulk clean-up (above my level, not in any list, by source, with a
preview and Undo) and the **Removed words** list with search, filter and Restore.
