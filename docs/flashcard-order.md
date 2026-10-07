# Phase 19: Mixed flashcard order (as built)

A defect fix: in "Study this lesson" a word's two flashcards came back to back, the second
giving away the first, in book order. Every flashcard-style session now goes through one
ordering function, so it can't come back in one screen while fixed in another.

## The cause

`buildQuickCheck` (the lesson's "I already know this lesson" check) pushed each word's
recognition question and then its production question, word by word in book order, and never
shuffled them. The review screen had the same weakness for newly started lessons: starting a
lesson introduces both cards of every word, due at once, and the review queue was a plain
shuffle with nothing keeping a word's cards apart.

## What changed

- `packages/core/src/session/orderSession.ts`: `orderSession(cards, describe, { seed, minSiblingGap = 5,
  maxSameDirectionRun = 3, recent })`. Builders choose the cards; this chooses only the order:
  - siblings (cards sharing a key: `word:id`, `grammar:id`, `zh:<text>`) have at least 5 cards between them;
    a sibling that can't fit is left for the next session (`sessionMeta(result).deferred`);
  - an unreviewed production card comes after its recognition card when both are in the session;
  - a seeded shuffle inside each priority band (Phase 14 textbook-first still holds overall);
  - at most 3 same-direction cards in a row while the rest of the session has both directions
    (the greedy pass retries with derived seeds and keeps the best order);
  - `recent` carries the last cards shown (any screen, last 30 min) so the gap runs across the
    boundary between the vocab and grammar parts of "Study this lesson".
  - The result carries a marker (`isOrderedSession`), checked for every builder in tests.
- `requeueAgain`: a card answered Again comes back at least 5 cards later, away from its siblings
  (review screen). `placeExtras`: listening exercises mixed into review and cloze keep the same gap.
- Builders using it: review screen (normal, study order, garden, lesson vocab:
  `apps/web/src/lib/review-session.ts`), cloze (`buildSession`, `buildMixedSession`), listening
  (`planListenSession`), lesson grammar step (`buildGrammarExercises`), lesson quick check.
- Every session logs `[session] <kind> seed=… cards=… deferred=…` to the console; dev builds show
  each review card's position and seed on the card.

Note: two exercises on the same grammar point are siblings too, so a lesson with few grammar
points shows fewer grammar exercises per session (the rest come next time).
