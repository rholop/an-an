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
- **LLM providers: Google Gemini (free tier) as the default, OpenAI as the fallback.** Both sit behind one adapter interface in the proxy; which model handles which task (chat, journal review, sentence generation) is env config. Keep costs near zero: cache aggressively and pre-generate content offline where possible.
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
                         in front of Gemini / OpenAI.
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
type Skill = 'recognition' | 'production';
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
    | 'review_again' | 'review_hard' | 'review_good' | 'review_easy'
    | 'anki_import_seen' | 'placement_known' | 'placement_unknown';
  at: Date;
  context?: { source: 'chat' | 'journal' | 'cloze' | 'review' | 'placement'; refId?: string };
}
```

Phases may add fields but must not rename or remove these.

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
