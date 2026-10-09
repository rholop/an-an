# Related repos & deployment target

Not part of this repo, but relevant context for Phase 3+ (the LLM proxy) and
for deployment. Local paths are on the owner's machine; update if they move.

## `~/Documents/Code/holop-dev` — the host site

Rowan's personal site (`holop.dev`), a React + Vite SPA, deployed to a
DigitalOcean droplet behind nginx. An'an deploys **alongside** it, not
instead of it — nginx routes by path prefix to multiple independent apps on
one host:

```
Browser → Nginx (holop.dev)
            ├── /            → holop-dev SPA (static)
            ├── /resume      → holop-dev SPA (static, same build)
            ├── /chat        → shoyu-chat client (static, separate build)
            ├── /api         → shoyu-chat server (proxy_pass → :3001)
            ├── /an-an       → apps/web (static, THIS repo)
            └── /an-an/api   → apps/proxy (proxy_pass → :3002, THIS repo)
```

The nginx config lives in `holop-dev`'s own repo at `nginx/holop.dev.conf`
(checked in there, applied to the server manually/by whoever manages it —
editing it in that repo does not by itself reload nginx). The `/an-an` and
`/an-an/api` blocks were added there for this project.

**Body size (Phase 28, required):** a profile's progress save is several MB, and nginx's
default body limit is 1 MB. Without this line every save over 1 MB is refused with 413 and the
server keeps an old copy:

```nginx
location /an-an/api/ {
    client_max_body_size 40m;
    # … proxy_pass http://localhost:3002/; …
}
```

Then `sudo nginx -t && sudo systemctl reload nginx`. Every deploy checks this: it pushes a 5 MB
test body to `/an-an/api/v1/sync-selftest` through the public address and the deploy fails on 413.

**What this means for apps/web's build**: it's served from a subpath, not
domain root — `vite.config.ts` sets `base: '/an-an/'` for production builds
only (the dev server still serves from `/`), and any runtime code that
builds an absolute URL must prefix with `import.meta.env.BASE_URL` instead
of a bare leading slash (see `apps/web/src/lib/useLexicon.ts` for the
pattern) — a bare `/foo` request will 404 once this is live at
`holop.dev/an-an/`.

holop-dev does **not** currently have a `.github/workflows` CI/CD pipeline
(checked directly — there's no `.github` directory in that repo as of this
writing), despite deploying to production. If that's a surprise, it's worth
confirming how deploys there actually happen before assuming An'an can
piggyback on the same mechanism.

## `~/Documents/Code/shoyu-chat` — reference for the proxy

A single-user chat PWA served at `holop.dev/chat`, same droplet. Useful as
prior art for apps/proxy, specifically:

- **Gemini SDK usage**: `server/src/services/geminiService.ts` —
  `@google/generative-ai` (`^0.21.0`), `genAI.getGenerativeModel()` /
  `generateContent()` / `generateContentStream()`. Note: that code streams
  free-form text (no JSON-schema / structured-output mode) and has no
  model-fallback logic — An'an's proxy needs both, so treat this as
  "how to call the SDK" reference, not a drop-in adapter.
- **Provider routing pattern**: `server/src/services/aiRouter.ts` keeps an
  ordered list of `{ provider, model, label }` tiers per task and falls back
  down the list on failure/quota exhaustion — the same shape as this
  project's fallback from one Gemini model to another (Phase 25: Gemini only).
- **CI/CD**: `.github/workflows/ci.yml` (test+build on push/PR) and
  `.github/workflows/deploy.yml` (on push to `main`: SSH into the droplet
  via `appleboy/ssh-action` using `secrets.HOST`/`USERNAME`/`SSH_KEY`, `git
  pull`, rebuild, `pm2 restart`). An'an's own `.github/workflows/` mirrors
  this shape, adapted for a pnpm workspace; see `apps/proxy/README.md` for
  the An'an-specific deploy steps and the secrets that still need
  configuring in this repo's GitHub settings before `deploy.yml` does
  anything.
- **Process manager**: PM2, `ecosystem.config.cjs` per app, one port per app
  (shoyu-chat uses 3001; An'an's proxy uses 3002 — see
  `apps/proxy/ecosystem.config.cjs`).
- Both apps are single-user/no-accounts and keep API keys server-side only
  — the same constraint CLAUDE.md sets for An'an's proxy.
