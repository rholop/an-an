# Changelog

Notable changes that affect how An'an is run. Phase-by-phase features are in the
`CLAUDE.md` phase table.

## Phase 25 (2026-10-08)

- **OpenAI removed.** The app never calls OpenAI (a paid provider; the owner's
  decision). The `openai` package, `apps/proxy/src/providers/openai.ts` and the
  `OPENAI_*` settings are gone. Gemini (free tier) is the only provider: a failed
  request is retried once on the same model, then once on `GEMINI_MODEL_FALLBACK`;
  the independent checks run on `GEMINI_MODEL_CHECK`. Delete `OPENAI_API_KEY` from
  the server's environment. An architecture test keeps it out.
- Fixed: stories failed with a 502 because the paid provider rejected the request
  name it was sent.
