# @anan/proxy

Small Hono server that sits in front of Gemini (default) and OpenAI
(fallback) so the browser never sees an API key. See CLAUDE.md §"LLM
providers" and `phase-documents/03-validated-chat.md` for the design this
implements.

## What it does

- `POST /v1/turn` — the endpoint the chat UI calls. Builds the system
  prompt for the requested scenario (`data/build/scenarios.json`, compiled
  from `data/scenarios/*.yaml` — run `pnpm pipeline:build` first), calls
  Gemini, and on a rate limit / quota error / invalid JSON falls back to
  OpenAI once. Logs which provider actually served the request.
- `POST /v1/sentences` — called by `packages/data-pipeline`'s offline batch
  sentence-bank build (phase doc 04 §1), never during a live review
  session. Same Gemini-primary/OpenAI-fallback/cache/rate-limit machinery
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
  `JsonTaskAdapter`/`createJsonOrchestrator` (Gemini first, OpenAI fallback,
  cached by task + prompt + message). Prompts: `data/prompts/journal-*.md`;
  models: `GEMINI_MODEL_JOURNAL` / `OPENAI_MODEL_JOURNAL`.
- `pnpm --filter @anan/proxy journal-eval` runs the fixture entries in
  `data/journal-eval/` through a live proxy and writes `docs/journal-eval.md`.

## Environment variables

See `.env.example` for the full list with defaults. The two that matter
most:

| Var | Required | Notes |
|---|---|---|
| `GEMINI_API_KEY` | one of these two | Free tier. Get one at [aistudio.google.com](https://aistudio.google.com/apikey). |
| `OPENAI_API_KEY` | one of these two | Fallback provider. |

With only one of the two set, the proxy runs single-provider (no
fallback) rather than refusing to start — a loud warning is logged instead.
With neither set, the server still starts (health checks still work) but
every `/v1/turn` call fails with a 502.

## Local development

```bash
pnpm pipeline:build          # builds data/build/{lexicon,scenarios}.json
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
