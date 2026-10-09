# Progress rule (Phase 29): audit findings and how each was closed

The rule: **every progress number or decision comes from one object, the progress ledger**
(`packages/core/src/progress/ledger.ts`; web `useLedger()` / `getLedgerNow()` in
`apps/web/src/lib/ledger.ts`). See CLAUDE.md "Progress rule (Phase 29)".

The findings are those of `phase-briefs/29-audit-findings.md` (main at `91a65be`). Every one was
closed in commit **`f36f5c3`** ("Phase 29: one progress rule"), the single change that moved
every screen onto the ledger. "Deleted" means the code is gone.

## A. Due / needs water

| # | Finding | Closed by |
|---|---|---|
| A1 | `reviewStatus` users (badge, Home, forecast, Review, Water all) | All read `ledger.status` / `ledger.session()`; `useReviewStatus` and `lib/review-status.ts` deleted |
| A2 | Garden used due-now, included listening, level-filtered, uncapped plot button | `buildPlants(ledger, …)`: thirsty = `ledger.needsWater` (this session, listening never); the plot button is capped by `status.capLeft` |
| A3 | Lesson Vocab step used due-now and `maxDue` 40 | `ledger.session().cards` filtered to the lesson, the same set as the plot |
| A4 | Cloze used due-now and its own `newWordState` | `ledger.session()`, `ledger.newAllowance('cloze')` |
| A5 | Journal prompt words from due-now | The session's cards (`ledger.session()`, the next session's between sessions) |
| A6 | Pinyin & tones "Nothing due" used due-now | `ledger.practice('reading')`: this session's reading cards |
| A7 | Listening due rules in three places, no `reps > 0` | `ledger.practice('listening')`, its own queue, never in watering or the badge; `dueListeningCards` deleted |
| A8 | Reader and chat read-no-lookup rules differed; New and Nope'd words got credit | One predicate, `ledger.creditsRead(card)` (chat, Reader, stories) |
| A9 | Core `applyReadNoLookup` upgraded New cards | Ignores cards that are not scheduled (New or removed) |
| A10 | Learning steps "done" in Review, due in 10 min elsewhere | One sitting rule (`progress/sitting.ts`, `progressConfig.sittingStepMinutes`): requeued in the sitting; left early, parked at the next session start |
| A11 | `dueForecastOf` dead; false comment in `orderSession`; "(due today)" label | Deleted; comment fixed; label removed |

## B. New words

| # | Finding | Closed by |
|---|---|---|
| B1 | `isNewCard` ignored Nope | `ledger.newCards()` (active cards only) |
| B2 | `nextNewItems`, a second picker with no allowance | Deleted: chat targets and Reader "new" use `ledger.pickNew` (`pickNewForSession` under the allowance) |
| B3 | Pinyin & tones: 10 new with no pause | `ledger.newAllowance('pinyin')` |
| B4 | Cloze `maxNewItems` | Deleted; `progress.config` `newPerQueue.cloze` |
| B5 | Listening `maxNewPerSession` | Deleted; `newPerQueue.listening`, paused with the rest |
| B6 | `newItemAllowance` duplicated `newWordState` | Deleted |
| B7 | Review header counted differently from its status line | Header counts the capped session; Again repeats shown as "+N again" |
| B8 | Two Review early paths | One: Home, Garden and Review open `ReviewPage reviewEarly` (the capped next session) |

## C. Learned / Mastered / percentages

| # | Finding | Closed by |
|---|---|---|
| C1 | Level-up, Placement, Progress, `levelCoverage`, Water all used different inputs | `ledger.level()` / `ledger.summary()` / `ledger.item()` everywhere; removed and legacy known items handled inside |
| C2 | Lesson Vocab "still to master" built its own set | `ledger.lesson().stillToMaster`: same items and removed filter as the chip, empty exactly when the lesson is done |
| C3 | Grammar dots vs Mastered; no leech exclusion | Dots from `ledger.item().dots` (●●● only when Mastered); quick check and known items count; leeches never Mastered |
| C4 | `growthStage` dead | Deleted |
| C5 | Literal 7 in `productionRung` | `progress.config` `recallStabilityDays` |
| C6 | `lessonDone` default share | No default; the ledger passes the learner's share |
| C7 | `mature` from `LearnerConfig` | `progress.config` `matureStabilityDays`, `itemStateOf` |
| C8 | `isUnreviewedBulkCard` used `reps <= 1` | Uses the in-app answer count |

## D. Known / comprehensible / ladder

| # | Finding | Closed by |
|---|---|---|
| D1 | `wordSets` users | `ledger.comprehensible()`: Learned ∪ in session ∪ learning; `wordSets` deleted |
| D2 | Ladder rung 1 held catch-up words never introduced | Those are rung 2; `ledger.ladder()`; story "% words you know" is the comprehensible share |
| D3 | Cloze coverage stricter than Comprehensible | Cloze passes `comprehensible().ids` |
| D4 | Story read evidence rule differed from chat | `ledger.creditsRead` |
| D5 | Duplicate sets and lesson-core helpers | `COMPREHENSIBLE` (reader), `isOpenChatAllowedWord`, `lessonCoreWords`, `lessonCore` deleted for the shared ones |
| D6 | Stale "state ≥ review" comments | Fixed |
| D7 | `char-stats` "known" from any card | Characters of Learned words only |
| D8 | `build-stories.ts` `BOOK_LEVEL`, proper nouns on rungs | Level and gate from `course.ts`; ladder from the ledger; proper nouns kept off rungs |

## E. Days and time zones

| Finding | Closed by |
|---|---|
| Streak, This week, story week, done today, forecast used device-local days | `ledger.dayKey`, `ledger.weekRange` (Monday start), `ledger.streak`, forecast in the profile zone; the journal prompt of the day too. The lint rule fails on `getDay` / `getDate` / `setHours` / `getHours` / `toDateString` outside `core/progress` |

## F. Skills each counter includes

| Finding | Closed by |
|---|---|
| Garden included listening (core) but not reading (web); rewards gave nothing for Pinyin & tones | Every counter reads the session (recognition, production, reading; listening never); Pinyin & tones answers earn points like listening |

## G. What the architecture test missed

| # | Finding | Closed by |
|---|---|---|
| G1–G7 | Regex test covered only pages and components; missed `lib/`, `db/`, core features, `newWordState`, `ProgressIndex`, state and stability aliases, day maths | Replaced by (1) the compiler: core stops exporting the predicates, and `apps/web/src/__type-fixtures__/no-progress-predicates.ts` fails typecheck if one returns; (2) the typed lint rule `eslint-rules/progress-from-ledger.js` on all of `apps/web/src` and `packages/core/src` outside `progress/`, in CI and the pre-commit hook, with planted fixtures tested in `apps/web/src/progress-lint.test.ts`; (3) the property test, the owner's three cases and `e2e/numbers-agree.spec.ts`. The architecture test keeps only labels and colours |

## Found while building the tests

- A grammar point whose last use was wrong showed ●●● while not Mastered: the third dot now
  waits for Mastered.
- "I already know it" on a New card (no FSRS difficulty yet) left an invalid memory state that
  crashed the garden's retrievability: it now starts at difficulty 5, like other seeded cards.
- The cached ledger now also goes stale on any direct Dexie write to cards or evidence (not only
  on learner-service writes and sync merges).
