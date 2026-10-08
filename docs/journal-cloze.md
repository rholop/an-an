# Journal review items (Phase 17)

A journal review item is only ever built from a sentence that is fully correct,
natural Taiwan Mandarin, and it tests only the smallest change between what the
learner wrote and that sentence. If that can't be guaranteed, no item is made.

## The flow

1. **Review (`reviewJournal`, `POST /v1/journal-review`).** Code splits the entry
   into sentences (`prepareSentences`: 。！？ and line breaks, a 「quotation」 stays
   whole) and sends the numbered list plus the learner's protected names. Next to the
   (still capped at 3) issues, the model returns one item per sentence: a fully
   corrected `corrected`, its English, and `edits`. The model gives no offsets; code
   finds an edit by searching for `contextBefore + before` (`edits.ts`). `original` is
   attached by code.
2. **Edits.** The model's edits are used only if applying them gives exactly
   `corrected`. Items are always built from the smallest token-level diff of the
   original against `corrected` (`diffHunks`), so an inserted 是 is an insertion of 是,
   never "印 → 是印". The model's kind, pattern and explanation ride along when its
   edits were usable; otherwise the notes are generic.
3. **Check (`verifyCorrected`, once per sentence, cached on the review row).**
   Rules (traditional only, `checkTaiwanness`, no brackets/Latin/emoji, one sentence,
   clean segmentation, protected names kept) → an independent checker
   (`POST /v1/journal-verify`: never sees the original, runs on the other provider
   from the one that corrected, also confirms the English) → one retry
   (`/v1/journal-sentence-fix`) → otherwise the sentence is rejected and makes no items.
4. **Exercise per edit (`planSentenceItems`).**

   | Edit | Exercise |
   |---|---|
   | missing word / particle / measure word | cloze on the corrected sentence, blank exactly where it goes |
   | wrong word | cloze; or a two-way choice when the solver can't decide it |
   | mainland wording | choice: the learner's word vs the Taiwan word |
   | extra word | tap the word that doesn't belong, on the learner's sentence |
   | word order | reorder the tokens of the corrected sentence |
   | more than 2 tokens changed | "Fix my sentence" (one item for the sentence) |

   Blanks are 1–2 whole word tokens and never a protected name, a name from the
   lexicon, a number or punctuation. Punctuation-only edits make no item.
5. **Solver test (`POST /v1/journal-solve`).** A model fills the blank from the
   sentence, the English and the prompt only. If it doesn't find the target, the item
   becomes a choice (replacements) or is dropped (insertions). Other fills it finds are
   added to `accepted` only after the whole sentence passes the check.
6. **Grading (`gradeErrorItem`).** `accepted` is compared after Phase 4's
   normalising; pinyin/zhuyin input gets tone-insensitive partial credit. A wrong
   answer shows **I think mine is right too**: one cached whole-sentence check; if it
   passes the answer is added to `accepted`, the item is rescheduled from the card it had
   before, and the wrong grade is undone. "Fix my sentence" answers are graded by exact
   match, else the same check plus "the specific mistake is gone".

Every card shows *You wrote* (mistake highlighted), *Correct* (change highlighted), one
line of explanation and the English, and the prompt line names the kind of fix.

## Protected names

Per profile (`protectedTerms` setting, edited under *Journal → Names to protect*),
defaulting to the profile's own name. They are sent to the model, must survive in the
corrected sentence, and are never a blank. The editor suggests unknown name-like
words that recur across entries.

## Existing data (Part E)

Dexie v8 marks every existing item `pending_rebuild` (never shown). The app calls
`JournalService.rebuildPending` when the Cloze page opens: each finished entry
without `itemsBuiltAt` is sent through steps 1–5; the old items of that entry are
replaced (the FSRS card is carried over to a rebuilt item that tests the same word)
or **blocked with a `rebuild:` reason**, and show on *Reported clozes*. Nothing is
written for an entry until all its sentences could be checked, so an unreachable
model just means "try again next time". Plain journal-sentence cloze sources are
now the verified sentences only: as written if there were no edits, otherwise the
verified corrected version.

## Evaluation (Part F)

`packages/core/test/fixtures/journal-cloze/sentences.v1.json` (47 Novice–A2 sentences:
the owner's example, 2–3 mistakes, missing 是/的/了, measure words, word order,
mainland words, names, numbers, particles, already-correct ones).

```
pnpm --filter @anan/proxy dev   # needs a Gemini key
pnpm eval:journal               # writes docs/journal-cloze-eval.md
```

The report lists, per sentence: what was written, the model's correction, the check
result, the edits, each item with the solver's answers, and a blank verdict. The harness
also checks the hard rules itself (no protected name, number or punctuation in a
blank; every item sits on a verified sentence) and exits non-zero on a breach.
`pnpm --filter @anan/proxy journal-cloze-eval --dry` runs the same harness with offline
stand-ins built from the fixtures' reference corrections (no keys): it proves the
harness and the pipeline, it is **not** model output.
`docs/journal-cloze-eval.dry-run.md` is such a run.

**Sign-off is still owed:** the live report has not been generated (no API keys in
the build environment) and the owner has not read it. Ship only when the owner has read
`docs/journal-cloze-eval.md` and no item shows an incorrect sentence or rejects a
correct fix; keep that report as the baseline for prompt changes.

## Known limits

* The check refuses a correction that uses a word the lexicon doesn't know (and isn't a
  protected name): "segments cleanly" is strict, so those sentences make no item. The
  dry run shows this for 視訊.
* The proxy's default 20 requests/minute can be tight for a long entry (one call per
  sentence to check, plus solver calls); `FetchTutorLLM` waits out short rate limits and
  anything unfinished is retried on the next Cloze visit.
* The learner's journal evidence (`planJournalEvidence`) still uses the capped issues,
  as before.
