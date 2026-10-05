# Reported and garbled journal clozes (Phase 16)

## What was investigated

The brief asks for the cause to be found "with the real data in the owner's
IndexedDB". That data is not reachable from the build environment, so the
causes below were reproduced with fixtures that follow the shape of the real
code path (`JournalService.finish` → `buildErrorItems` → `buildErrorCloze`, and
`journalSentencesFromEntry` for journal sentences). Every reproduced example is
a passing test in
`packages/core/src/journal/garbled-cloze.test.ts`.

To check the owner's own data, open **Reported clozes** in a dev build and use
**Export journal + error bank as JSON** (dev-only), then open the app: the
migration runs on the Cloze page and lists everything it blocks.

## Findings

| Suspected cause | Reproduced? | What happened | Fix |
|---|---|---|---|
| **Several corrections in one sentence** (the main cause) | **Yes** | `buildErrorItems` made one item per issue and applied only *that* issue to the sentence. A sentence with 2–3 issues was shown as "corrected" with the other mistakes still in it, around the blank. | All issues in a sentence are applied at once, from the last span to the first, and each blank is moved by the length change of the earlier corrections. Test: `several corrections in one sentence`. |
| **Offset drift** | Not in the old code, but a hazard of the obvious fix | Each issue was applied alone, so spans never shifted. Applying several in order *would* shift them. | Built once, last span first; a test builds the same sentence with the issues in either order and gets the same result. |
| **Span that splits a word** | **Yes** | The blank was the model's span exactly, so a span ending inside 喜歡 gave a half-word blank. | The blank is widened to whole tokens (re-segmenting the corrected sentence); the check refuses any blank that doesn't line up with tokens. |
| **Span crossing a sentence boundary** | Partly | `sentenceAround` already widened to every sentence touched, but the result was a two-sentence "cloze". | The check requires a single sentence; such items are blocked with the reason. |
| **Learner's uncorrected text as a cloze source** | **Yes, in two ways** | Journal sentences were skipped only if they overlapped a *kept* issue. Issues the validator rejected, or dropped by the 3-issue cap, left no span, so a sentence with a real mistake could still be offered as written. | Journal sentences are only offered after the Part B check (rules plus one naturalness check, stored per sentence). Unchecked or failed sentences are never offered. |
| **Character vs UTF-16 offsets** | **Yes, for emoji / non-BMP text** | Model spans are character counts; they are sliced as JS string indexes. After an emoji or a rare character (two UTF-16 units) every later span is off by one. | Items built after such a character are blocked as "offsets unreliable"; any sentence containing one is refused by the check. |
| **Sentence splitting** | **Yes, inside quotes** | `splitSentences` cut on 。！？ even inside 「…」, leaving fragments such as `他說：「我去。`. | Review/source splitting (`splitReviewSentences`) keeps a quotation together; `sentenceAround` and `journalSentencesFromEntry` use it. |
| **Brackets** | No | Sentences holding `[gym]` were already skipped for error items, and issues inside brackets are rejected by the validator. | Kept as a regression test; the check now also refuses brackets and leftover markup anywhere, and a sentence that fails is a visible *blocked* item instead of being dropped silently. |

## How a journal cloze reaches the learner now

1. `buildErrorItems` builds the item (all corrections applied, blank on whole
   tokens) with status `pending_check`, or `blocked` with the reason when the
   rules already fail.
2. `checkErrorItem` / `checkJournalCloze` (`packages/core/src/cloze/check-journal-cloze.ts`) runs the
   rules, then one cached naturalness check (`POST /v1/cloze-check`, Gemini
   first, OpenAI as fallback). If the model can't be reached the item stays
   `pending_check` and is hidden until the next run.
3. Only `active` items are ever shown. `blocked` and `reported` items appear
   on the **Reported clozes** page.
4. Existing items: Dexie v7 moves every stored item to `pending_check`, and the
   Cloze page runs the check over them (and over journal sentences) on open.

## Reporting

* Every cloze card has a **Something's wrong** button (≥ 44px) opening a sheet
  with one tap per reason and an optional note.
* The card leaves the session at once. If it was already answered, the evidence
  event is removed and the card restored from before the answer, so a bad
  cloze never counts as a lapse (`LearnerService.recordUndoable`).
* A journal item gets `status: 'reported'` and a `report` record. Any other
  source (journal sentence, chat line, bank sentence) is excluded by its text
  and stored as a `settings` row (`clozeReport:<hash>`), so it syncs with the
  tables that already sync. Bank sentences are shared content and the report
  is also written to the other profile's database on the same device.
* The word stays in review and gets another sentence next time.
* **Undo** on the thank-you message reverses all of it for 8 seconds.

## Not done / limits

* The owner's real IndexedDB export was not available, so "the migration
  blocks the known bad clozes" is covered by fixtures, not by the real data.
* A reported ErrorItem is per profile (each profile has its own journal). A
  bank-sentence report is mirrored to the other profile on this device, not to
  another device's copy of it until that profile syncs.
* Points already awarded for an answer that is later reported (the Phase 6
  reward ledger) are not taken back.
