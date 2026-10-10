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
- **LLM provider: Google Gemini (free tier) only** (Phase 25, owner's decision: no paid provider is ever called). The proxy's fallback is a second Gemini model (`GEMINI_MODEL_FALLBACK`) and independent checks are a fresh call on `GEMINI_MODEL_CHECK`; which model handles which task (chat, journal review, sentence generation) is env config. Keep costs near zero: cache aggressively and pre-generate content offline where possible.
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
| **New** | Introduced, never answered (`state === 'introduced'`, `reps === 0`). Never in a session, never read credit | `ledger.item`, `ledger.newCards` |
| **Due / needs water** | Phase 29: in the current review session (recognition, production and reading cards due before the session cutoff, minus cards finished this session, after Nope). Listening is its own practice queue. "Due now" is not a concept | `ledger.session`, `ledger.needsWater`, `ledger.thirstyWords` |
| **Review session** | Phase 23: two a day in the profile's time zone (default America/New_York): morning 04:00–10:00 holds cards due before 16:00, evening 16:00–04:00 holds cards due before 10:00 tomorrow. A session nobody does rolls into the next. Cap per session (80) and up to 5 new words per session. Between sessions: "Morning review done · Evening review opens at 4 pm (31 cards)" + Review early | `ledger.status` (built on `core/progress/review-sessions.ts`) |
| **Due now / this session** | The only counts shown for review: this session's cards, the next session (opens at …, count), distinct cards done this session, cap left, the new-word state (open, reduced, backlog pause, session limit). Home, Review, Garden and the nav badge all show these | `ledger.status` / `ledger.session()` (`useLedger`); new words `ledger.newAllowance(queue)` |
| **Review face** | Phase 23: recognition = Meaning, production = Pick the Mandarin (4 same-length look-alikes from `core/confusables`, Unihan radical/strokes/phonetic) then Recall after 2 right picks in a row (a lapse goes back to Pick), reading = Say it. Mixed ~40/40/20 | `reviewFace`, `capMixedCards` (`core/review/faces.ts`) |
| **Pinyin %** | Phase 23: Learned words whose reading card is Learned too, shown as "Learned X% · Mastered Y% · Pinyin Z%". Reading never changes Learned or Mastered | `ledger.pinyinShare` |
| **Learned** | Recognition in review after an answer in this app, or passed "I already know this". Grammar: one correct use. Leeches count as Learned | `ledger.item` / `ledger.summary` |
| **Mastered** | Recognition stability ≥ 21 d and production ≥ 7 d (grammar: 3 correct uses, last one correct and on a later day than the first; ●●● means exactly this). Leeches and imports never count | `ledger.item` / `ledger.summary` |
| **Imported** | Seeded by Anki or placement, no answer here yet | `ledger.item` |
| **Tricky** | A leech: counts as Learned, never Mastered | `ledger.item` |
| **Comprehensible** | Learned ∪ in session ∪ learning (answered at least once): chat, open chat, Reader, Cloze coverage and stories. Read credit (`ledger.creditsRead`): answered, not removed, in session or learning | `ledger.comprehensible` |
| **Current lesson** | The study focus's active lesson, which follows My class. A lesson is done at the learner's lesson share; "still to master" is empty exactly then | `ledger.focus`, `ledger.lesson` |
| **Vocabulary ladder** | Rung 1 learned/in session/learning · 2 active lesson and catch-up words never introduced · 3 next lesson · 4 the lesson after · 5 current level · 6 everything else. Stories and open chat both rank words with it | `ledger.ladder` |
| **Your class** | The My class setting. Labels and visibility only, never priority | `useClassScope` / `currentClassScope` |
| **Active day / streak** | Phase 32: a profile-zone day with an answer (review, cloze, lesson step, listening, pinyin, grammar), a finished journal entry or story, a completed scenario or an open-chat turn; passive reads, lookups, imports and placement never count. Stored in the synced append-only `activeDays` table (back-filled once from history, Dexie v12); the streak (Home bar and Progress) comes only from it | `ledger.activeDays`, `ledger.streak`, `ledger.streakWeek` (`core/progress/active-days.ts`) |
| **Days** | Phase 29: always the profile's time zone; weeks start on Monday (streak, This week, story week, forecast, journal prompt) | `ledger.dayKey`, `ledger.weekRange`, `ledger.streak` |

**Colours (Phase 22):** every colour is a token in `apps/web/src/theme.css` (light = Solarized
Light nudged green, dark = Solarized Dark); components use only `var(--…)`. `src/theme.test.ts`
checks AA contrast and the architecture test fails on a colour written anywhere else. The five
shared-term icons (seed, sprout, leaf, flower, droplet) are `components/PlantIcons.tsx`.

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
  Learned % ≥ threshold, ●●● ⇔ Mastered, New never in session, no read credit for New or removed
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
| 29 | One progress rule: the progress ledger is the only source of progress numbers (`core/progress/ledger.ts`, web `useLedger`); predicates no longer exported; typed lint rule `anan/progress-from-ledger` in CI and pre-commit; property test, owner's three cases, `e2e/numbers-agree.spec.ts`. Replaces Phase 27 | `29-one-progress-rule.md`, findings closed in `docs/progress-rule.md` |
| 32 | Home streak bar: synced `activeDays` table (one row per active profile-zone day, back-filled once from past history), 7 plant icons + "🌱 N-day streak · best M" under the Home buttons, tap opens Progress at the streak; streak on by default | `32-home-streak-bar.md` |

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
