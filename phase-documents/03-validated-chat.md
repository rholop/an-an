# Phase 3 brief: Chat with validated vocabulary

> Paste into Claude Code with `CLAUDE.md` at the repo root. Phases 1–2 must be merged.

## Goal

Goal-driven conversations with an NPC whose replies stay at the learner's level, verified in code, with tap-to-lookup feeding the learner model. Ship **two scenarios** end to end: ordering a drink at a tea shop (less ice, less sugar) and buying/topping up an EasyCard at an MRT station.

## Scope

1. **LLM proxy** (`apps/proxy`):
   - Small Node server (Hono or Fastify). Endpoints: `POST /v1/turn`, `POST /v1/health`. Later phases add `/v1/journal-review` and `/v1/sentences`.
   - Holds the API keys from env. Model names per task come from env config, not code.
   - **One provider adapter: Gemini (free tier).** (Phase 25 replaced the original second, paid provider: a failure now retries on a second Gemini model; see CHANGELOG.md.) Use the structured-output / JSON-schema mode so replies come back as JSON. Log which model served each request.
   - Gemini's free tier has low per-minute limits: queue requests and show a friendly "busy, retrying" state rather than an error.
   - Don't send anything personal beyond the conversation itself (free-tier prompts may be used by the provider for training).
   - Per-client rate limit and a daily token budget (config). Log token usage per request.
   - Request/response validated with zod schemas that live in `core` and are shared with the web app.
   - Response caching keyed by a hash of the full prompt, for scenario openers and hints.
   - CORS locked to the site's origin. No user accounts; an install ID header is enough for rate limiting.
   - Deploy as a serverless function next to the site (document the deploy steps and env vars in `apps/proxy/README.md`).
2. **LLM interface in `core`**:
   ```ts
   interface TutorLLM {
     generateTurn(req: TurnRequest): Promise<TurnResponse>;
     // Phase 5 adds reviewJournal(); Phase 4 may add generateSentences()
   }
   ```
   `apps/web` implements it via fetch to the proxy. Tests use a fake.
3. **Turn contract**:
   ```ts
   interface TurnRequest {
     scenarioId: string; npcId: string;
     history: { role: 'npc' | 'learner'; zh: string; en?: string }[];
     learnerLevel: Level;
     vocab: { knownSample: string[]; due: string[]; targets: string[]; allowedExtras: string[] };
     scaffolding: 'high' | 'medium' | 'low';
     englishFallback: boolean;
   }
   interface TurnResponse {
     reply_zh: string;
     reply_en: string;                        // hidden unless requested
     tokens: { text: string; lemma?: string }[];
     targets_used: string[];
     suggested_replies: { zh: string; en: string }[];
     goal_progress: { step: string; done: boolean }[];
     recast_zh?: string;                      // Chinese recast of learner's English
   }
   ```
4. **Validator** (`core/validate/turn.ts`), the key piece:
   - Re-segment `reply_zh` with the Phase 1 segmenter, using `tokens` as hints only.
   - Classify each token: `known` (state ≥ review), `due`, `target`, `learning`, `allowed` (names, numbers, punctuation, supplement whitelist, scenario extras), `out_of_level`, `unlisted`.
   - Compute coverage = (known + due + learning + allowed) / content tokens. Pass if coverage ≥ threshold (default 0.95, config 0.90–0.98), new/unknown tokens ≤ 4, and no simplified chars or mainland terms (`checkTaiwanness`).
   - On fail: regenerate once with a feedback message naming the offending words and suggested simpler replacements; after max attempts (default 2 regenerations), pick the best attempt and mark the unknown words as "introduced" with a gloss shown inline.
   - Report `{ coverage, maxLevel, unknown[], attempts }` to the UI.
   - Also exposed as `analyzeText(text)` for reuse (journal feedback, sentence bank).
5. **Scenario definitions** as data (`data/scenarios/*.yaml`): id, title, level range, NPC (name, personality, speech style, particles they use), setting, goal steps with completion checks, scenario vocab list (extras allowed), opener, success line. Scenario unlock by level lives in data.
6. **System prompt** (stored as a versioned template file, not inline strings):
   - Taiwan Mandarin only: traditional characters, Taiwan vocab (捷運, 機車, 便利商店, 悠遊卡, 少冰, 微糖), natural particles (喔, 啦, 欸, 耶) used in moderation.
   - Short turns (1–2 sentences at low levels). Stay in character. Push the goal forward.
   - Use the provided due and target words naturally; prefer the known sample.
   - Return only the JSON shape above.
7. **Chat UI**:
   - Messages rendered with `AnnotatedText`, respecting per-word pinyin fading from Phase 2.
   - Tap token → gloss popover → `chat_lookup_gloss` evidence. Hover for reading → `chat_hover_reading`. When a learner turn is sent, every due/learning token in the previous NPC message that was *not* looked up → `chat_read_no_lookup`.
   - Suggested reply chips (count fades with `scaffolding`), "I'm stuck" (first a hint, then a model answer), English fallback toggle at low levels (bot shows `recast_zh`).
   - Goal checklist visible; scenario ends with a summary: new words met, words looked up, coverage, "add to review" for chosen words.
   - Debug drawer (dev only) showing validator report per turn.
8. **Persist chat history** in Dexie (`conversations`, `turns` with tokens + validator report). Phase 4 builds cloze from these.

## Non-goals

- No open-ended free chat mode yet (scenarios only).
- No journal or cloze. No audio ever (text-only game).
- No user accounts or payments.

## Acceptance criteria

- API key never reaches the browser (check built bundle and network tab).
- Validator unit tests: fixtures of replies that pass, fail on coverage, fail on mainland terms, fail on simplified chars, and pass with names/numbers.
- In a scripted run of 20 turns per scenario at L1, ≥ 90% of final replies meet the coverage threshold; the rest are shown with inline glosses. Report attempts and cost per turn in the dev drawer.
- Every tap/hover/no-lookup produces the right evidence in the log, and the review queue reflects it.
- Both scenarios can be completed, have a clear end, and produce a summary.
- Proxy rate limit and daily budget enforced (tests).
- The adapter passes the contract tests; forcing a 429 on the primary Gemini model in a test makes the turn succeed on the fallback Gemini model (Phase 25).

## Dependencies

Phase 1: segmenter, lexicon, `checkTaiwanness`, `AnnotatedText`. Phase 2: `LearnerRepo.knownSet()`, due cards, `applyEvidence`, pinyin fading.
