# @anan/proxy

Small Hono server that sits in front of Google Gemini (free tier, the only
AI provider since Phase 25) so the browser never sees an API key. See CLAUDE.md §"LLM
providers" and `phase-documents/03-validated-chat.md` for the design this
implements.

## What it does

- `POST /v1/turn` — the endpoint the chat UI calls. Builds the system
  prompt for the requested scenario (`data/build/scenarios.json`, compiled
  from `data/scenarios/*.yaml` — run `pnpm pipeline:build` first), calls
  Gemini. A retryable failure (429, 5xx, timeout, invalid JSON) is retried
  once on the same model after a short wait (a 429's retry-after is
  honoured), then once on `GEMINI_MODEL_FALLBACK`. Authentication errors
  are never retried. Logs which model actually served the request.
- `POST /v1/sentences` — called by `packages/data-pipeline`'s offline batch
  sentence-bank build (phase doc 04 §1), never during a live review
  session. Same retry/fallback-model/cache/rate-limit machinery
  as `/v1/turn`, just a different prompt (`data/prompts/sentence-gen.*.md`)
  and response shape (`SentenceGenResponse`) — see `scripts/scripted-run.ts`
  for a Phase-3-style harness pattern, or `data-pipeline`'s
  `build-sentences.ts` for the real caller. The pipeline is responsible for
  validating candidates against the lexicon (`analyzeText`) and dropping
  failures — this endpoint only schema-validates the LLM's JSON.
- `GET /v1/health` — liveness check, no auth.
- Per-client (`X-Install-Id` header) rate limiting and a daily token
  budget, both in-memory (see the caveat below).
- Response caching keyed by a hash of the full prompt (scenario openers and
  repeated hints are the common case).
- `POST /v1/journal-review` (phase doc 05 §3) — reviews a journal entry
  (`JournalReview`: at most 3 issues, a natural rewrite, `[English]` gap
  translations, correct unprompted uses). The learner's text goes in the
  *user* message, never the system prompt. The proxy only schema-checks the
  JSON; spans, Taiwan-ness and `used_well` are validated in the web app
  (`validateJournalReview` in `@anan/core`).
- `POST /v1/journal-check` — is the learner's own alternative fix of a
  flagged span acceptable? `POST /v1/journal-explain` — the "explain more"
  follow-up. All three journal routes share one generic
  `JsonTaskAdapter`/`createJsonOrchestrator` (task model, then the fallback
  Gemini model, cached by task + prompt + message). Prompts:
  `data/prompts/journal-*.md`; model: `GEMINI_MODEL_JOURNAL`. The
  independent checkers (`/v1/journal-verify`, `/v1/story-check`) are a fresh
  call on `GEMINI_MODEL_CHECK` that never sees the writer's prompt.
- `POST /v1/gloss` (phase doc 07 §B2) — offline gloss adjudication, called by
  `packages/data-pipeline`'s `build:glosses` (never at runtime): given a word,
  its TOCFL POS, MOE definitions and candidate senses, the model CHOOSES and
  CONDENSES (≤ 6 words, citing candidate ids); the pipeline validates every
  answer. Returns an `x-total-tokens` header so the batch can log its cost.
  `POST /v1/define` — runtime fallback for a word that is not in the lexicon
  (the web app labels it "AI-generated" and queues it for review). Both reuse
  the journal JSON orchestrator (cached).
- `pnpm --filter @anan/proxy journal-eval` runs the fixture entries in
  `data/journal-eval/` through a live proxy and writes `docs/journal-eval.md`.

## Household code (`SITE_CODE`)

Every route except `GET /v1/health` — **sync and every AI request** — needs the
header `X-Site-Code` to equal the server's `SITE_CODE` (e.g. `tofu`); otherwise
the answer is `401`. The code lives only in the server's environment (`.env` /
PM2); the web app asks for it once per browser, checks it with
`GET /v1/auth/check`, and just sends what was typed. **The server refuses to
start without `SITE_CODE`**, so the AI keys can never be left open by accident.
Changing it makes every browser ask once more (a 401 clears the remembered
code). This is deliberately light: no accounts, hashing or lockouts.

## Sync (phase 8)

Two fixed profiles (`ron`, `guanyu` — see `packages/core/src/profiles.ts`; the
server accepts exactly those ids) each have one saved copy: the web app's
per-profile export JSON, gzipped, plus `{ rev, updatedAt }`.

- `GET /v1/sync/:profileId` → `{ rev, updatedAt, data }` (`rev: 0, data: null`
  when nothing is saved yet).
- `PUT /v1/sync/:profileId` with `{ baseRev, data }` → `{ rev, updatedAt }`, or
  **`409`** with the server copy (`{ rev, updatedAt, data }`) when `baseRev` is
  stale; the client merges it in and retries. Unknown profile ids → `404`.

**Storage choice:** a directory of files on the proxy's own disk
(`FileSyncStore`, `SYNC_DIR`, default `apps/proxy/sync-data/`, git-ignored),
because this proxy already runs as a long-lived PM2 process on the droplet — no
extra service, no free-tier quota. Layout: `<dir>/<profileId>/<rev>.<epochMs>.json.gz`,
written to a temp file and renamed, with a per-profile lock so two simultaneous
pushes can't both win. It sits behind the tiny `SyncStore` interface
(`get`, `put(profileId, blob, baseRev)`), so moving to a KV/blob store later
means writing one class.

**Phase 28:** saves may be gzipped (`content-encoding: gzip`; the 40 MB cap applies to the
body and to what it unpacks to) and pulls are gzipped when the client sends
`accept-encoding: gzip`. A push that would drop more than 20% of the saved copy's cards or
evidence is refused with 409 (and the server copy, so the client merges and pushes the union)
unless the body says `confirmReplace: true`. `GET /v1/sync/:profile/versions` lists the saved
versions with their counts; `GET /v1/sync/:profile/versions/:rev` returns one.
`PUT /v1/sync-selftest` takes a large body and discards it (the deploy's nginx check).

To see what the server holds for each profile (read-only):

```sh
pnpm --filter @anan/proxy sync:inspect         # every profile
pnpm --filter @anan/proxy sync:inspect ron     # one
```

**Versions:** every revision is kept; the server never deletes a saved copy (a retention policy
comes later as its own step). To list them or roll a profile back on the server (the old version becomes
the newest revision; devices merge it in like any update). In the app, Settings → Your progress
→ Saved versions does the same per profile (Restore merges; Replace overwrites, after a confirm):

```sh
pnpm --filter @anan/proxy sync-rollback ron        # list
pnpm --filter @anan/proxy sync-rollback ron 7      # make rev 7 current
```

Set-up on the server: add `SITE_CODE=…` (and optionally `SYNC_DIR=/home/an-an/sync-data`
outside the deploy directory so deploys can't touch it) to `apps/proxy/.env`,
and raise nginx's body limit for the API location — a profile with a long
history is several MB and nginx's default is 1 MB:

```nginx
location /an-an/api/ { client_max_body_size 40m; … }
```

Back up `SYNC_DIR` like any other data directory.

## Environment variables

See `.env.example` for the full list with defaults. The two that matter
most:

| Var | Required | Notes |
|---|---|---|
| `GEMINI_API_KEY` | **yes** (server won't start without it) | Free tier. Get one at [aistudio.google.com](https://aistudio.google.com/apikey). |
| `GEMINI_MODEL_TURN` / `GEMINI_MODEL_JOURNAL` | no | The model per task. |
| `GEMINI_MODEL_FALLBACK` | no | A different free-tier Gemini model, tried once after the task model fails twice. |
| `GEMINI_MODEL_CHECK` | no | The independent checker (journal verify, story check). |
| `GEMINI_MODEL_STORY` | no | Phase 26: writes and repairs stories (default `gemini-2.5-flash`, the stronger free model). |
| `SITE_CODE` | **yes** (server won't start without it) | The household code; see below. |
| `SYNC_DIR` | no | Where per-profile saved copies go (default `apps/proxy/sync-data`). |

A 502 names each model that was tried and why, never a key or a prompt:
`{"error":"story_check_failed","attempts":[{"model":"gemini-…","reason":"rate_limited"}]}`.
`pnpm smoke:proxy` (with `GEMINI_API_KEY` set) sends one tiny request per route
to each configured model and fails if Gemini rejects one; it is skipped without a key.

## Local development

```bash
pnpm pipeline:build          # builds data/build/{lexicon,scenarios,open-chat}.json (the proxy needs open-chat.json at startup)
cp apps/proxy/.env.example apps/proxy/.env   # fill in at least one API key
pnpm --filter @anan/proxy dev                 # tsx watch, http://localhost:3002
```

```bash
curl http://localhost:3002/v1/health
```

### Scripted quality run (phase doc §"acceptance criteria")

`scripts/scripted-run.ts` drives the real orchestrator + validator for 20
simulated turns per scenario at L1 and reports attempts/tokens/coverage per
turn — the "scripted run of 20 turns per scenario" acceptance check:

```bash
pnpm --filter @anan/proxy scripted-run             # needs a real API key configured
pnpm --filter @anan/proxy scripted-run -- --fake   # no key needed; canned replies, proves the harness only
```

`--fake` is for exercising the harness without burning a real key (or when
none is configured) — its pass rate is an artifact of the hand-picked canned
replies (one bad reply in four, by design), not a signal about model
quality. Only a real-key run's pass rate is evidence for the ≥90% threshold.

## Known limitation: in-memory state

The response cache (`cache.ts`) and rate limiter (`rate-limit.ts`) are
plain `Map`s in process memory. That's correct for this project's actual
deploy target (a single long-lived PM2-managed Node process — see below),
but:

- A process restart clears the cache and resets everyone's rate-limit
  window (not the daily budget counter's *correctness*, since that's keyed
  by UTC day and recomputed from zero — just that the day's prior usage is
  forgotten).
- It would **not** work correctly if this were ever deployed across
  multiple instances/regions, or to a cold-start-per-request serverless
  platform (every cold start = a fresh empty cache/limiter). If that ever
  changes, swap both for a shared store (Redis, a KV service) — not
  implemented here, flagged as a real gap, not an oversight.

## Deployment

This project deploys alongside Rowan's other projects on one DigitalOcean
droplet, behind the same nginx instance as `holop-dev` and `shoyu-chat` —
see `../../docs/related-repos.md` for the full picture. Layout:

```
Browser → Nginx (holop.dev)
            ├── /an-an      → apps/web static build (/var/www/an-an/dist)
            └── /an-an/api  → this server (proxy_pass → localhost:3002)
```

### One-time server setup

```bash
# On the droplet:
git clone <this-repo-url> /home/an-an
cd /home/an-an
corepack enable
pnpm install --frozen-lockfile
cp apps/proxy/.env.example apps/proxy/.env   # fill in real keys (loaded at startup; gitignored)
pm2 start apps/proxy/ecosystem.config.cjs --env production
pm2 save
```

Then add the `/an-an` and `/an-an/api` blocks from `holop-dev`'s
`nginx/holop.dev.conf` to the server's actual nginx config and reload
nginx (`sudo nginx -t && sudo systemctl reload nginx`) — editing the file
in the `holop-dev` repo does not, by itself, change what's running.

### Ongoing deploys

`.github/workflows/deploy.yml` (repo root) runs on every push to `main`:
installs, builds, and restarts the PM2 process over SSH — the same shape as
`shoyu-chat`'s `deploy.yml`. It needs three GitHub Actions secrets set on
this repo (Settings → Secrets and variables → Actions) before it does
anything:

| Secret | Value |
|---|---|
| `HOST` | the droplet's IP/hostname |
| `USERNAME` | SSH user |
| `SSH_KEY` | private key with access to that user |

Without those secrets configured, the workflow's deploy step simply fails
(SSH connection refused) — it does not deploy somewhere wrong, so it's safe
to leave `deploy.yml` committed before the secrets exist.

The production `.env` file (with real API keys) is **not** managed by CI —
it's created once on the server (above) and left alone; `deploy.yml` only
pulls code and restarts the process, never touches `.env`.
