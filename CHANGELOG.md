# Changelog

Notable changes that affect how An'an is run. Phase-by-phase features are in the
`CLAUDE.md` phase table.

## Phase 26 (2026-10-09)

- **Stories are repaired, not thrown away.** Only the sentences with a word outside
  the learner's lists go back to the writer (`POST /v1/story-repair`, never cached);
  a story that still misses the targets but is above the floors is shown with its new
  words taught first. At most 3 writing calls and 1 check per story.
- New optional env `GEMINI_MODEL_STORY` (default `gemini-2.5-flash`) writes stories.
- New `pnpm stories:build` writes 3 stories per textbook lesson ahead of time into
  `data/curriculum/<book>/private/stories.json` (run it where the proxy runs, with
  `SITE_CODE`); the proxy serves them at `/v1/textbook/<book>/stories`.

## Phase 25 (2026-10-08)

- **OpenAI removed.** The app never calls OpenAI (a paid provider; the owner's
  decision). The `openai` package, `apps/proxy/src/providers/openai.ts` and the
  `OPENAI_*` settings are gone. Gemini (free tier) is the only provider: a failed
  request is retried once on the same model, then once on `GEMINI_MODEL_FALLBACK`;
  the independent checks run on `GEMINI_MODEL_CHECK`. Delete `OPENAI_API_KEY` from
  the server's environment. An architecture test keeps it out.
- Fixed: stories failed with a 502 because the paid provider rejected the request
  name it was sent.
