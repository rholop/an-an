# Changelog

Notable changes that affect how An'an is run. Phase-by-phase features are in the
`CLAUDE.md` phase table.

## Phase 28 (2026-10-09)

- **Required on the server:** nginx must accept large saves. Add `client_max_body_size 40m;`
  to the `location /an-an/api/` block (see `docs/related-repos.md`), then
  `sudo nginx -t && sudo systemctl reload nginx`. Every deploy now pushes a 5 MB test body
  to `/v1/sync-selftest` through the public address and **fails on 413**.
- Saves are gzipped (`content-encoding: gzip`, unpacked on the server with the same 40 MB cap)
  and pulls are gzipped when the browser accepts it. A push waits 5 s after a change (was 30 s),
  is retried after 30 s, 2 min and then every 10 min while it fails, and every session end
  pushes straight away.
- Every failure has its own words in the header cloud ("Not saved for 2 h", tap for the reason
  and **Save now**). Settings → Your progress shows what the server and this browser hold, and
  lists the saved versions (Restore merges one in; Replace, confirmed, overwrites).
- The server keeps the last 10 versions plus one per day for 30 days, and refuses (409) a push
  that would drop more than 20% of the cards or evidence unless it is a confirmed Replace.
- A fresh browser says what it found ("Restoring 羅恩's progress… found 1,240 cards") and never
  opens empty silently: no copy on the server or no server gives Try again / Start fresh.
- New `pnpm --filter @anan/proxy sync:inspect [profile]`: each saved version's date, size,
  cards, Learned, Mastered and newest evidence time, read from the server's `SYNC_DIR`.

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
