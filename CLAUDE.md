# An'an: Taiwan Mandarin learning game (project overview)

> Put this file at the repo root as `CLAUDE.md`. Every phase brief assumes it is present and does not repeat it.

## What we are building

A game for learning **Taiwan Mandarin** (traditional characters, Taiwan vocabulary and pronunciation). The core loop:

1. **Chat** with NPCs in goal-driven scenarios. Replies are kept to ~95–98% known words, plus a few due review words and 2–4 new targets.
2. **Review** words met in chat with a real spaced-repetition scheduler (FSRS).
3. **Cloze** exercises built from the learner's own chats and journal entries.
4. **Journal**: free writing, with limited, typed corrections that feed an error bank.

The game is **purely text-based: no audio, TTS, listening or speech features.** A light game layer comes after the loop works. It runs **only as a website** (installable PWA) on the owner's own site. There is no Steam or desktop build.

## Decisions already made (do not re-litigate)

- **Sits alongside Anki, not replacing it.** An existing Anki deck can be imported to mark words as "seen". The game focuses on context, production and output. Its own scheduler still runs, for in-game items.
- **Seed vocabulary: SC-TOP TOCFL 8,000-word list** (Novice 1–2, Levels 1–6). The NAER/TBCL 14,425-word list is a possible later extension; don't build for it now, but don't make it impossible either.
- **Stack:** React + TypeScript PWA built with Vite. Progress stored **locally first** in IndexedDB via **Dexie**, with JSON export/import for backup. A **small backend LLM proxy** holds the API keys, rate-limits and caches. It deploys next to the site (e.g. as a serverless function on the same host).
- **LLM provider: Google Gemini (free tier) only** (Phase 25, owner's decision: no paid provider is ever called). Phase 33: each role (turn, journal, story, check) has a chain of free-tier models (`GEMINI_CHAIN_*`, env config) and a shared quota tracker skips models out of their per-model daily quota; independent checks are a fresh call on the checker chain, preferring a model other than the writer's. Scripts send `x-ai-priority: batch` and never use the live app's reserve. Keep costs near zero: cache aggressively and pre-generate content offline where possible.
- **Scheduler:** FSRS via `ts-fsrs`, target retention 0.85–0.90 (default 0.9, user-configurable).
- **Taiwan authority:** readings and zhuyin come from Ministry of Education (MOE) dictionary data. CC-CEDICT is only a gloss fallback, never the authority for readings.
- **Items are word + sense**, not bare headwords. Grammar patterns (了, 過, 把, 比, 會/能/可以 …) are items too.

## Repository layout (pnpm workspaces)

```
/packages/core           platform-agnostic TS: types, lexicon lookup, segmenter,
                         reading/zhuyin, learner model, scheduler, validators.
                         NO DOM, NO Dexie, NO fetch. Pure functions + interfaces.
/packages/data-pipeline  Node scripts: import official lists, normalize, verify
                         readings, build versioned lexicon, sentence bank.
/apps/web                React PWA (Vite). Dexie persistence, UI, service worker.
/apps/proxy              Small server (Hono, deployable as a serverless function)
                         in front of Gemini.
/data/raw                Downloaded source files (gitignored if licence requires).
/data/build              Generated lexicon + sentence bank (versioned).
```

`core` stays free of browser and server specifics so it is easy to test. Anything that touches storage or network goes behind an interface defined in `core` and implemented in `apps/*`.

## Conventions

- TypeScript strict mode everywhere. ESM. Node 20+.
- Tests: Vitest for `core` and `data-pipeline`; Playwright for a few web smoke tests.
- Every Chinese-processing function in `core` gets table-driven tests with real Taiwan examples (捷運, 機車, 便利商店, 垃圾車, 還/還, 長/長, 了/了).
- IDs are stable strings, never row numbers. Changing the source list must not break saved progress.
- Time is injected (`now: Date` parameter), never read from `Date.now()` inside `core`, so the scheduler is testable.
- Dexie schema changes always ship with a version bump and an upgrade function.
- No LLM API keys in the browser, ever. The web app talks only to `/apps/proxy`.
- LLM output is **data to validate**, never trusted: every LLM response is JSON, schema-checked (zod), then checked against the lexicon in code.
- Text shown to the learner: traditional characters only. A simplified-character or mainland-term check runs on all generated Chinese.

## Shared core types (the contract between phases)

```ts
// Seven levels, from packages/core/src/levels.config.ts (the single source of truth):
// N1 準備級一級, N2 準備級二級, L1 入門級 (A1), L2 基礎級 (A2), L3 進階級 (B1), L4 高階級 (B2), L5 流利級 (C1–C2).
type Level = 'N1' | 'N2' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
type Skill = 'recognition' | 'production' | 'listening' | 'reading';   // listening (Phase 15) and reading (Phase 23) are practice skills: never Learned / Mastered
type ItemState = 'unseen' | 'introduced' | 'learning' | 'review' | 'mature';

interface Word {                 // one lexicon entry = one word + sense
  id: string;                    // stable, e.g. "tocfl-3f9a2c"
  headword: string;              // traditional
  variants: string[];
  pos: string[];
  level: Level | null;           // null for supplementary words
  source: 'tocfl' | 'supplement' | 'custom';
  pinyin: string;                // tone-marked, MOE-verified
  pinyinNumeric: string;         // "ka1 fei1"
  zhuyin: string;
  glossEn: string;
  senseNote?: string;
  chars: string[];
  tags: string[];                // topic, register, particle, measure-word, name…
  freqRank?: number;
}

interface GrammarItem {
  id: string;                    // "gram-le-completion"
  pattern: string;               // "V + 了"
  level: Level | null;
  explanationEn: string;
  examples: string[];            // sentence-bank ids
}

type ItemRef = { kind: 'word' | 'grammar'; id: string };

interface Evidence {             // everything that updates the learner model
  item: ItemRef;
  skill: Skill;
  kind:
    | 'cloze_correct_nohint' | 'cloze_correct_hint' | 'cloze_wrong'
    | 'journal_correct_use' | 'journal_misuse'
    | 'chat_read_no_lookup' | 'chat_lookup_gloss' | 'chat_hover_reading'
    | 'story_read_no_lookup'   // Phase 24: a due/learning word read in a story without a lookup
    | 'review_again' | 'review_hard' | 'review_good' | 'review_easy'
    | 'anki_import_seen' | 'placement_known' | 'placement_unknown';
  at: Date;
  context?: { source: 'chat' | 'journal' | 'cloze' | 'review' | 'placement' | 'story'; refId?: string };
}
```

Phases may add fields but must not rename or remove these.

## Shared terms (Phase 21: one meaning everywhere)

Every screen uses these words with exactly these meanings. Phase 29: the app asks only the
progress ledger (`packages/core/src/progress/ledger.ts`, web `useLedger()` / `getLedgerNow()`);
the definitions behind it live in `progress/terms.ts` (thresholds in `progress.config.ts`), and
nothing else reads a card's scheduling fields (the compiler and the `anan/progress-from-ledger`
lint rule enforce this; see "Progress rule (Phase 29)" below).

| Term | Meaning | Where it is computed |
|---|---|---|
| **New** | Introduced, never answered (`state === 'introduced'`, `reps === 0`). In a session only as one of its new cards (Phase 43: the session's share of the day's limits, `session().fresh`); never read credit | `ledger.item`, `ledger.newCards` |
| **Due / needs water** | Phase 29: in the current review session (recognition, production and reading cards due before the session cutoff, minus cards finished this session, after Nope). Listening is its own practice queue. "Due now" is not a concept | `ledger.session`, `ledger.needsWater`, `ledger.thirstyWords` |
| **Review session** | Phase 23: two a day in the profile's time zone (default America/New_York): morning 04:00–10:00 holds cards due before 16:00, evening 16:00–04:00 holds cards due before 10:00 tomorrow. Phase 43: at most the **ceiling** (`capPerSession`, 40) cards, the lowest recall chance first, tutoring cards first among equals; the rest **wait** for the next session ("12 more are waiting for this evening", Home/Garden "Backlog: N cards …"). The session is **fixed at its first answer** (`reviewSessions/<key>` settings rows, synced): no new card or face joins after that. Between sessions: "Morning review done · Evening review opens at 4 pm (31 cards)" + Review early | `ledger.status`, `ledger.session()`, `ledger.sessionToFix()` (`core/progress/review-status.ts` `planSession`) |
| **Due now / this session** | The only counts shown for review: this session's cards (never more than the ceiling), the next session (opens at …, count), distinct cards done this session, cards waiting, the new-word state. Home, Review, Garden and the nav badge all show these | `ledger.status` / `ledger.session()` (`useLedger`); new words `ledger.newAllowance(queue)` |
| **New per day** | Phase 43 (owner, 2026-10-16): **15 new words + 25 new card types a day** (Settings → Review, 5–50 each; `PROGRESS_CONFIG.newPerDay`), counted per session day (from the morning's opening). At most half (rounded up) in the morning, the rest in the evening. Tutoring words first (oldest class first), then the study order. A skipped session's share is never made; after two undone sessions in a row no new cards until that session's reviews are done. "I already know it" doesn't count. Cloze takes from the same share; pinyin and listening keep their own limits | `ledger.newToday()`, `status.newAllowed`, `planSession` |
| **Review face** | Phase 23: recognition = Meaning, production = Pick the Mandarin (4 same-length look-alikes from `core/confusables`, Unihan radical/strokes/phonetic) then Recall after 2 right picks in a row once the card is consistently known and ≥ 7 days stable (Phase 43; a lapse goes back to Pick), reading = Say it. Phase 43: a session runs in **blocks** Meaning → Pick → Say it → Recall → grammar ("Meaning · 12"); Again goes back to the end of its block; the third Again in a session puts the card aside until the next one | `reviewFace` (`core/review/faces.ts`), `orderInBlocks`, `requeueInBlock` (`core/review/blocks.ts`) |
| **Pinyin %** | Phase 23: Learned words whose reading card is Learned too, shown as "Learned X% · Mastered Y% · Pinyin Z%". Reading never changes Learned or Mastered | `ledger.pinyinShare` |
| **Learned** | Recognition in review after an answer in this app, or passed "I already know this". Grammar: one correct use. Leeches count as Learned | `ledger.item` / `ledger.summary` |
| **Mastered** | Phase 42 (owner, 2026-10-14): Meaning and production (Pick/Recall) each rated **Easy 3 times** (`flags.easyCount`: Easy adds one, Again resets, Hard/Good leave it; Say it stays practice). About 14 days after earning them each card comes back **once** in review (`recheckDue`, in the session like a tutoring card): Easy keeps it Mastered, anything else un-masters it. Words Mastered under the old stability rule (recognition ≥ 21 d and production ≥ 7 d) stay Mastered and are never sent back. Grammar: 3 correct uses, last one correct and on a later day than the first (●●● means exactly this). Leeches and imports never count | `ledger.item` / `ledger.summary`, `core/progress/easy-ratings.ts` |
| **Face order** | Phase 42/43: a word's cards enter Review as Meaning → Pick → Say it → Recall; a face's New card waits until the face before it is **consistently known**: Good or Easy **2 times in a row, in two different sessions** (`flags.goodRun`; Again/Hard reset it; Rate your words counts as one, Not yet resets), and it enters from the **next** session, never the one that released it (`flags.faceReleasedAt`). A new face never sits beside another card of its word in a session. One-time migration per profile (`faceHoldMigratedAt`) replays every card's run from its history | `core/progress/face-order.ts`, `core/progress/good-run.ts`, `ledger.reviewNewCards`, `ledger.tutorToIntroduce`, web `lib/calm-review.ts` |
| **Rate your words** | Phase 42: a page under More for a one-time pass through every seen card (Meaning, production, Say it): Not yet / Good / Easy. Good and Easy set `knownFace`, Easy also counts as one Easy; Not yet clears both. Never moves a card's due date (`face_rating_*` evidence) | `ledger.faceRatingQueue`, `pages/RateWordsPage.tsx` |
| **Imported** | Seeded by Anki or placement, no answer here yet | `ledger.item` |
| **Tricky** | A leech: counts as Learned, never Mastered | `ledger.item` |
| **Comprehensible** | Learned ∪ in session ∪ learning (answered at least once): chat, open chat, Reader, Cloze coverage and stories. Read credit (`ledger.creditsRead`): answered, not removed, in session or learning | `ledger.comprehensible` |
| **Tutoring words** | Phase 43 (replaces Phase 40 Part E's uncapped version): a saved class's ticked words get their Meaning card at Save and lead the day's new words (oldest class first) **inside** the daily limit and the ceiling; later faces follow the face order. The latest 3 classes' words are ladder rung 2 and lead open chat, story, Cloze and journal targets. A class's "Learned X% · Mastered Y%" is its ticked words and matched grammar | `ledger.tutorToIntroduce`, `ledger.tutorNewCards`, `ledger.tutorClassNow`, `ledger.wordFaces`, `ledger.recentTutorWordIds`, `ledger.tutorSession` |
| **Current lesson** | The study focus's active lesson, which follows My class. A lesson is done at the learner's lesson share; "still to master" is empty exactly then | `ledger.focus`, `ledger.lesson` |
| **Vocabulary ladder** | Rung 1 learned/in session/learning · 2 active lesson and catch-up words never introduced · 3 next lesson · 4 the lesson after · 5 current level · 6 everything else. Stories and open chat both rank words with it | `ledger.ladder` |
| **Your class** | The My class setting. Labels and visibility only, never priority | `useClassScope` / `currentClassScope` |
| **Active day / streak** | Phase 32: a profile-zone day with an answer (review, cloze, lesson step, listening, pinyin, grammar), a finished journal entry or story, a completed scenario or an open-chat turn; passive reads, lookups, imports and placement never count. Stored in the synced append-only `activeDays` table (back-filled once from history, Dexie v12); the streak (Home bar and Progress) comes only from it | `ledger.activeDays`, `ledger.streak`, `ledger.streakWeek` (`core/progress/active-days.ts`) |
| **Days** | Phase 29: always the profile's time zone; weeks start on Monday (streak, This week, story week, forecast, journal prompt) | `ledger.dayKey`, `ledger.weekRange`, `ledger.streak` |
| **Held (waiting for the word list)** | Phase 38: a card whose word or grammar point the loaded word list can't show (a stale cache, a custom word not merged yet). In no count, session or new-word pick; never shown, deleted or rescheduled. Review: "N cards are waiting for the latest word list · Reload"; still missing after a fresh list: Settings → Your progress → "Cards with missing words" | `ledger.unresolved()`, `ledger.resolves` (study input `resolves`) |
| **Practice** | Phase 45 (owner, 2026-10-17): "Practise these words (N)" on every lesson and tutoring class page, and in their Vocab step when its session part is empty or done. Only answered, unremoved cards of the words (no New card, no new face, no new word; words with no card yet: "N words from this lesson start in the next sessions"), in blocks, weakest first, 20 a round. A card's **first answer of the profile-zone day** (Review or practice) counts: a practice one is a `review_*` with `context.practice` ("counted ✓"); later practice answers that day are `practice_*`, in no count, and only Again sets `flags.priority` (cleared by its next real review). Practice answers never start, fix or finish a session, and count as done in it only for its own cards | `ledger.practiceCards`, `ledger.practiceCounts`, `ledger.notStartedWords`, `pages/PracticePage.tsx` |

**Colours (Phase 22):** every colour is a token in `apps/web/src/theme.css` (light = Solarized
Light nudged green, dark = Solarized Dark); components use only `var(--…)`. `src/theme.test.ts`
checks AA contrast and the architecture test fails on a colour written anywhere else. The five
shared-term icons (seed, sprout, leaf, flower, droplet) are `components/PlantIcons.tsx`.
Phase 30: Chinese text sizes are the `--zh-hero` / `--zh-body` / `--zh-small` tokens only (scaled by
Settings → Chinese text size, `lib/zh-size.ts`; `theme.test.ts` fails on a fixed size); the laptop
header is one 48 px row whose nav moves items into More when they don't fit (`TopNav`).

Progress is always shown as "Learned X% · Mastered Y%" (`LearnedMastered` component).
New items for any session come from one rule, `pickNewForSession` in `study/queue.ts`, under the
ledger's one allowance (`ledger.newAllowance(queue)`, `ledger.pickNew`).

**Labels rule:** lesson, book and level names are built only in `apps/web/src/lib/labels.ts`,
`packages/core/src/textbook/course.ts`, `packages/core/src/levels.config.ts` and core's
`stepName`. Never write `` `Lesson ${n}` ``, `` `L${n}` `` or `` `TOCFL ${level}` `` by hand in a page:
add a helper to `labels.ts` instead. User-facing words for actions and feedback (Next, Undo,
Report, "✓ Correct", "Nothing due right now") also come from `labels.ts`.

## Progress rule (Phase 29)

- **All progress comes from the ledger.** Every progress number or decision (due, needs water,
  new words, Learned, Mastered, lessons, levels, comprehensible words, read credit, days) comes
  from `buildLedger` (`packages/core/src/progress/ledger.ts`); in the web app from `useLedger()`
  or `getLedgerNow()` (`apps/web/src/lib/ledger.ts`). Nothing else reads a card's `due`,
  `stability`, `state`, `reps`, `lapses` or `last_review`, or builds its own count.
- Core no longer exports the low-level predicates (`isDueCard`, `isNewCard`, `ProgressIndex`,
  `summarize`, `sessionCards`, …): `apps/web/src/__type-fixtures__/no-progress-predicates.ts`
  fails typecheck if one comes back. The typed lint rule `anan/progress-from-ledger`
  (`eslint-rules/`, CI and the pre-commit hook) fails on scheduling-field reads, device-time-zone
  day maths and threshold numbers outside `core/progress`. Persistence and the scheduler may store
  cards, one line at a time, with `// eslint-disable-next-line anan/progress-from-ledger -- <why>`.
- **Changing a definition** means changing `ledger.ts`, the Shared terms table above and the
  property test (`progress/ledger.property.test.ts`) together, in one commit.
- **A feature that needs a number the ledger lacks adds it to the ledger first.**
- The invariants are tested: the property test (garden thirsty = Water all = session words, badge
  = session size, one Review early size, lesson done ⇔ nothing still to master, level-up ⇔
  Learned % ≥ threshold, ●●● ⇔ Mastered, New in a session only as its share of the day's limits (Phase 43; no day starts more than them, `progress/calm-review.test.ts`), no read credit for New or removed
  cards, a pause stops every queue), the owner's three reports (`progress/owner-cases.test.ts`) and
  the Playwright `e2e/numbers-agree.spec.ts` at 08:00, 12:00 and 18:00 New York time.
- Checklist line for every change: **"Shows or uses progress? Got it from the ledger."**

## Build phases

| # | Phase | Brief |
|---|---|---|
| 1 | Data layer: lexicon, TOCFL import, segmenter, reading/zhuyin renderer | `01-data-layer.md` |
| 2 | Learner model + FSRS + review screen + placement + Anki import | `02-learner-model-fsrs.md` |
| 3 | Validated chat with tap-to-lookup, 1–2 scenarios, LLM proxy | `03-validated-chat.md` |
| 4 | Cloze ladder from chat history + sentence bank | `04-cloze.md` |
| 5 | Journal mode + error bank | `05-journal-error-bank.md` |
| 6 | Game layer | `06-game-layer.md` |
| 12 | Class textbook curriculum (來學華語 1) | `docs/textbook.md` |
| 16 | Report a bad cloze; check journal clozes before they are shown | `docs/cloze-reports.md` |
| 17 | Journal clozes rebuilt from fully corrected, independently checked sentences | `docs/journal-cloze.md` |
| 18 | Open chat about any topic, words weighted to what you know and the next three lessons | `docs/open-chat.md` |
| 19 | Flashcards always mixed: one shared session order, a word's cards never side by side | `docs/flashcard-order.md` |
| 20 | Nope a review card; daily cap, spread bulk cards, lookups and new words kept in bounds | `docs/review-pile.md` |
| 21 | Now studying follows your class; one meaning for progress, due, new and labels everywhere | Shared terms above |
| 22 | Home "💧 Water all" and "Review all", matching due counts, Garden light/dark theme tokens (`apps/web/src/theme.css`), plant icons, nav with More | `22-home-buttons-and-garden-theme.md` |
| 23 | Morning and evening review sessions (profile time zone, cap per session), Review faces (Meaning, Pick, Recall, Say it) with look-alike options, "Pinyin & tones" tab (7 tap exercises on the `reading` skill, tone confusion table on Progress) | `23-review-sessions-and-pinyin-practice.md` |
| 24 | Graded stories from known words (vocabulary ladder, Stories in the Reader, Home "Today's story", optional lesson story step) | `24-graded-stories.md`, eval in `docs/stories-eval.md` |
| 25 | Gemini only; lesson grammar step (3 exercises per point, ≥2 types, tiles from `core/textbook/grammar-step.ts` + `lesson-grammar-step.ts`); lesson senses (`glossFor(w, {lesson})`); names out of vocab; curriculum data fixes via `data/supplement/lexicon-overrides.yaml`; `pnpm audit:curriculum` in CI (config `data/curriculum/audit-config.yaml`, report `docs/curriculum-audit.md`); naturalness pass `pnpm --filter @anan/proxy naturalness` | `25-lessons-grammar-and-story-fix.md` |
| 26 | Stories you can read: grouped glossed word lists (`storyPromptLists`), `GEMINI_MODEL_STORY` writer, sentence repair (`/v1/story-repair`, max 3 calls + 1 check), mini lesson ("Words in this story") above the floors, real retries (variant + topic rotation, no cache), lesson stories made ahead (`pnpm stories:build`) | `26-stories-that-pass.md`, eval in `docs/stories-eval.md` |
| 28 | Progress never lost: gzipped saves (`content-encoding: gzip`), 5 s push + session-end push, retry with backoff, a status per failure (header cloud "Saved / Saving… / Not saved for N" + Save now), fresh browser never opens empty (restore screen), Settings → Your progress (server vs browser counts, saved versions: Restore / Replace), server keeps the last 10 versions (Phase 31), shrink guard (409 over 20%), `/v1/sync-selftest` deploy check (fails on 413), `sync:inspect` | `28-progress-never-lost.md` |
| 34 | Lesson extras: vocabulary from a lesson's other pages (word boxes, tables, picture labels) is taught with the lesson. `pnpm curriculum:extras <book\|--all>` scans (text, `pdftotext -layout`, plus words read from page images in `private/image-words.tsv`) into `data/curriculum/<book>/extras.yaml` (`proposed`/`keep`/`drop`, hand lines allowed) and `extras-report.md`; `pnpm curriculum:import <book> --extras-only` merges it into `book.json` (`Lesson.extra`, `extra` word notes with `page`) without re-deriving other ids. Extras (with 補充生詞) follow a lesson's core words in `getStudyFocus.newItemsAllowed`, earlier lessons first (catch-up); mastery still counts only the book's list unless `PRIORITY_CONFIG.extrasCountForLessonMastery`; Settings → Study → "Teach extra words with lessons" (`StudySettings.teachExtras`); audit checks `extra-repeat`, `extra-page` | Phase 34 brief |
| 29 | One progress rule: the progress ledger is the only source of progress numbers (`core/progress/ledger.ts`, web `useLedger`); predicates no longer exported; typed lint rule `anan/progress-from-ledger` in CI and pre-commit; property test, owner's three cases, `e2e/numbers-agree.spec.ts`. Replaces Phase 27 | `29-one-progress-rule.md`, findings closed in `docs/progress-rule.md` |
| 31 | Journal corrections you can question: a checked "Why?" per correction (`core/journal/explain.ts`, `/v1/journal-explain-check` on the checker model, one regeneration via `/v1/journal-why`, else "We're not sure" and never practised), legend explains itself, alternatives shown with their meaning, "Ask about this" (`/v1/journal-ask`, 5 turns, saved), "What did you mean?" / "Read as", "I think mine is right" (independent check; undoes items and evidence), gap fills in context (`/v1/journal-gap`, up to 3 checked options, nothing added without "Add to review"; old gap words listed on Reported), error-bank items keep the "Why?", Chinese-keyboard gap brackets 【】〖〗〔〕, server keeps the last 10 saves | `31-journal-explanations.md` |
| 32 | Home streak bar: synced `activeDays` table (one row per active profile-zone day, back-filled once from past history), 7 plant icons + "🌱 N-day streak · best M" under the Home buttons, tap opens Progress at the streak; streak on by default | `32-home-streak-bar.md` |
| 33 | Live within the Gemini free tier: a model chain per role (`GEMINI_CHAIN_TURN/JOURNAL/STORY/CHECK`, writer and checker start on different models), quota tracker `apps/proxy/src/quota.ts` (reads the 429's QuotaFailure/RetryInfo, skips exhausted models until the retry delay or midnight Pacific, persisted in `QUOTA_FILE`), 503 `quota_exhausted` + `resetsAt` (app: "used up until about 3 am", background stories wait), batch reserve (`x-ai-priority: batch`), scripts stop cleanly and resume (naturalness 50 lines/request via `geminiForScript()`, `stories:build`, evals; `--model`, `--max-calls`, `--status`), `pnpm ai:quota` and Settings → AI usage (`GET /v1/ai-usage`) | `33-free-quota-aware.md` |
| 36 | Chats that listen: one chat engine for scenario and open chat (`apps/web/src/lib/chat-engine.ts`, core `chat/listen.ts` `runChatTurn`); "Read as" fixable via "What did you mean?" (reply regenerated); facts list per conversation (`learner_facts`, `mergeFacts`), meaning check in code then `/v1/chat-meaning-check` on the checker chain, one regeneration then "⚠ This reply may have misunderstood you" + Try again; budget rewrites keep the meaning (up to 2 glossed `kept_words`); the journal corrector runs on every chat message with chat context (Why?, Ask about this, I think mine is right, ✓; error bank, evidence, clozes; Settings → Chat → Show corrections; "Corrections paused (free AI quota)"); gap options with Add to review; 📚 "Words from this chat" panel (never auto-adds typed words); `pnpm eval:chat` → `docs/chat-eval.md` | `36-chat-that-listens.md` |
| 37 | One cloze per word: `buildSession` groups a word's cards (shown card = most overdue, production on a tie), the answer is recorded for each of the word's cards in session (`clozeAnswerEvidence`, `CLOZE_CONFIG.creditAllFacesOfWord`), no sentence twice in a session (`usedZh`; a word with no fresh sentence is left out, `clozeSessionMeta`), start button counts words, retries labelled Again | `37-cloze-no-duplicates.md` |
| 38 | No "(unknown item)" review cards: data files under content-hashed names from `public/data-manifest.json` (sync scripts, `apps/web/scripts/data-manifest.mjs`; manifest Network First, hashed files Cache First, cache pruned to current + previous build, `lib/data-files.ts`), new builds load while the app is open; the ledger holds cards the word list can't show (`ledger.unresolved()`), Review's "waiting for the latest word list · Reload", one fresh reload at start-up then Settings → Your progress → "Cards with missing words" + `/v1/client-log`; custom words rebuild the lexicon at once; `pnpm audit:data` in CI (retired id-map ids in `data/curriculum/data-audit.yaml`) | `38-no-unknown-review-cards.md` |
| 39 | Tutoring sessions: upload a tutor's class summary PDF (pdf.js legacy build renders pages in the browser; only the images go to `/v1/tutor-extract`, once, cached by their hash), OpenCC s2twp, lexicon links (MOE reading wins, "your notes said …"), mainland swaps (`mainland-terms.yaml` `also`), gloss cleanup, examples checked once on the checker chain (`/v1/tutor-check`), grammar matched by `TUTOR_GRAMMAR_RULES` (supplement items in `data/supplement/grammar-supplement.yaml`, added to the built lexicon with `pnpm --filter @anan/data-pipeline patch:grammar`) or kept as notes; check screen (nothing stored before Save); synced `tutorSessions` (Dexie v13, never the PDF); words introduced at Save outside the allowance, 20 a session; class page under Tutoring (Textbook page + More): Vocab, Grammar, Story, Chat (scenario made at Save by `/v1/tutor-scenario`, sent inline on `/v1/turn`); kept sentences in Cloze "from your class with Carl" | `39-tutoring-sessions.md` |
| 40 | Tutoring words in full: level estimates for every word (`estimatedLevel`/`levelSource`, `displayLevel`; TBCL from an optional `data/raw/tbcl-words.*`, else characters, else one checked call at Save `/v1/tutor-classify`; `pnpm pipeline:levels` → `docs/level-estimates.md`; the TOCFL gate and level mastery read `level` only), "≈ L1" shown; "mainland" only for Taiwanness-table terms (variants corrected silently, OpenCC + `replaceSimplifiedChars`, never AI; "The notes wrote 普通话 (mainland usage) · Taiwan: 國語 / 中文"; per-tutor "This tutor is from Taiwan" in Settings → Tutoring); topic tags (`core/topics.ts`, scenario extras via `withTutorExtras`, Garden "Tutoring only"); audio at Save (`/v1/tutor-audio`, Azure, `TUTOR_AUDIO_DIR`, shared `packages/audio-build`, `audio:build --tutor`); 6 class steps (Vocab, Grammar, Listening, Chat, Journal, Story); words in review at once with every face, first, outside the cap and allowance; Home "From your class with …" for 3 days; Settings → Tutoring → "Re-check levels and topics" (also run once per profile) | `40-tutoring-words-full-depth.md` |
| 41 | Simplified hint on flashcards: small simplified characters above the traditional word on Review and Water all only (`components/SimplifiedHint.tsx`, `WithSimplified`; the architecture test fails anywhere else), only when they differ; Meaning, Say it and grammar from the start, Pick and Recall only with the answer; OpenCC `tw → cn` characters only, loaded lazily from `lib/opencc.ts` (moved from `lib/tutoring/`), cached per text; `--zh-hint` token (0.4× `--zh-hero`, ≥ 12 px, muted), `aria-hidden`; Settings → Review → "Show simplified characters on flashcards" (`flashcardSimplified`, per profile, synced, on by default) | `41-simplified-hint-on-flashcards.md` |
| 42 | Face order and mastery: faces enter Meaning → Pick → Say it → Recall; Mastered = 3 Easy ratings on Meaning and production with one re-check after 14 days; "Rate your words" page | Shared terms above |
| 43 | Calm review sessions: 15 new words + 25 new card types a day (half in the morning, tutoring first, Settings → Review), a face released by Good/Easy in 2 different sessions and entering from the next one, sessions fixed at the first answer (`reviewSessions/<key>`), skipped sessions hold, a 40-card ceiling (lowest recall chance first; "N more are waiting"), blocks by card type, Again at the end of its block and parked after the third, one-time migration (Good runs from history, 80 → 40, "We spread out your backlog") | `phase-briefs/43-calm-review-sessions.md` |
| 44 | Character breakdown on every card: after the answer (every face, Water all too), a word of 2+ characters shows each character, its reading in this word and a short meaning ("Characters"; leeches keep their own panel); meanings from the character's own lexicon entry (first 1–2 senses) else the Unihan gloss shortened in the pipeline (`shortCharGloss`, `data/build/char-glosses.brief.v1.json`, `build:char-glosses`) shipped as hashed `lexicon/char-glosses.v1.json`; collapsed to "Characters ▸" when it would not fit a laptop; Settings → Review → "Show what each character means" (`flashcardCharMeanings`, on by default) | `phase-briefs/44-character-breakdown-on-every-card.md` |
| 45 | Practise a lesson's or class's words any time: "Practise these words (N)" (lesson page, class page, empty/done Vocab steps), the Review card for faces each word already has, 20 a round, the first answer per card per day is a real review, later ones are `practice_*` (Again sets priority) | `phase-briefs/45-practice-lesson-words-any-time.md` |

Ship each phase small and working before starting the next. Scope creep is the main project risk.

## How we'll know it works

Log enough locally to compute: review retention vs. target, journal errors per 100 characters over time, % of chat turns completed without "I'm stuck", and time-to-complete a scenario unassisted. Phase 2 adds the event log these rely on.

## Related repos & deployment

See `docs/related-repos.md`: An'an deploys to `holop.dev/an-an` alongside
Rowan's other projects (`holop-dev`, `shoyu-chat`), same droplet, nginx
path-routed. `shoyu-chat` is useful prior art for the Phase 3 LLM proxy
(Gemini SDK usage, provider-fallback pattern, CI/CD deploy shape).

## Open items to verify, not assume

- SC-TOP list terms of use before bundling it into a hosted app. Level 6 coverage in whatever file we download.
- MOE dictionary data licence (some editions are CC BY-ND); CC-CEDICT is CC BY-SA 4.0.
- Current official TOCFL band/level structure before hardcoding level thresholds (keep them in config).
