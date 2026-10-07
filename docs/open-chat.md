# Phase 18: Open chat (as built)

A friend, 安安, to talk to about anything. No goals, no script. What she says is weighted
towards words you know and the next three textbook lessons. Replaces Phase 3's non-goal
"no open-ended free chat".

## Where things are

| Piece | File |
|---|---|
| All numbers (limits, caps, chips, openers) | `packages/core/src/chat/openChat.config.ts` |
| Tiers, upcoming lessons, chips, validator, wire schemas | `packages/core/src/chat/openChat.ts` |
| Persona 安安 (compiled to `data/build/open-chat.json` by `pnpm pipeline:build`) | `data/scenarios/open-chat.yaml` |
| System prompt, topic-word prompt (versioned) | `data/prompts/open-chat.v1.md`, `topic-words.v1.md` |
| `POST /v1/turn` with `mode: 'open'`, `POST /v1/topic-words` | `apps/proxy/src/app.ts` |
| Turn loop, topic-word cache, summary | `apps/web/src/lib/open-chat-service.ts` |
| UI (entry card, topic picker, chat, summary) | `apps/web/src/pages/OpenChat.tsx` |

## How the tiers work

- **A**: known (`review`/`mature`), due and learning words, plus the core words and function
  words of the next three lessons (and obvious compounds of them).
- **B**: TOCFL words of the picked level (and the levels below it, `tierBIncludesLowerLevels`)
  that are not in A.
- **C**: everything else, including words outside the lexicon.
- Names, particles, numbers, punctuation and words the learner typed in this chat are
  `allowed` and are not counted at all.
- A reply passes when tier A ≥ 85% of content tokens, tier B ≤ 3, tier C ≤ 1 and
  `checkTaiwanness` is clean. On a fail it is regenerated once with feedback naming the words;
  then the best attempt is shown, with tier B/C words glossed inline and introduced as
  `chat_lookup_gloss` (same as Phase 3). A passing reply still glosses its tier C word.
- "Next three lessons": Phase 14 on = active lesson + next two in study order, minus lessons
  gated by an unmastered lower TOCFL level (`StudyFocus.gatedLessonIds`); a "rest of level"
  step uses that level's unmastered words instead; Phase 14 off = My class current lesson +
  next two; no textbook = nothing.

## Notes and deliberate choices

- Tier B includes the levels below the picked one (config flag). Read literally, an unseen N1
  word would be tier C for an L2 learner and the NPC could hardly speak.
- The 85% rule is strict on short replies: one tier B word in a five-word reply is 80%. In
  practice B is about one word per reply unless the sentence is longer.
- The running summary is built locally (a digest of recent lines), not by a model call, to
  stay inside the free Gemini tier. Every 6 turns once the chat is longer than 12 turns.
- The topic list is cached on the device (`meta.openChatTopicWords`, 60 newest topic+level
  pairs) and on the proxy (24 h, in memory).
- Open chats are saved with `kind: 'open'`, `scenarioId: 'open-chat'`, `topic`. They never
  count as scenario attempts (game stats) and appear in Phase 4's cloze source as "Open chat".

## Not yet measured

The acceptance run "20 turns on 5 topics at Novice and L1, ≥ 90% within tier limits, ≥ 50% with
an upcoming-lesson word" is covered in `open-chat-service.test.ts` with a fake that builds
replies from the tier lists: it proves the pipeline, not Gemini's behaviour. Run it against the
real proxy with keys before trusting the numbers.
