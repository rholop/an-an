import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => ({
  // Deployed at holop.dev/an-an (see docs/related-repos.md) — the dev
  // server still serves from root so local dev/e2e URLs are unaffected.
  base: command === 'build' ? '/an-an/' : '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: "An'an",
        short_name: "An'an",
        description: 'Taiwan Mandarin learning game',
        // Opens as its own app (no browser bar) from the home-screen icon. start_url
        // and scope default to the build base, i.e. /an-an/ in production.
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#f3f4e3',
        background_color: '#f3f4e3',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Built data files (lexicon, scenarios, per-level sentence banks —
        // all served as static JSON from public/) are too big/dynamic for
        // the precache manifest, but pages fetch() them directly, so a
        // CacheFirst runtime rule is what actually makes "works offline"
        // true after the first visit, not just the app shell. A cloze
        // session (phase doc 04) in particular needs the sentence bank
        // cached to build a session with no network at all.
        runtimeCaching: [
          // Phase 10 audio. Clips are fetched whole (no Range header) by the
          // player, so the full 200 response is cacheable: a clip works offline
          // after its first play. The URL carries ?v=<hash>, so a regenerated
          // clip is a new cache entry. The manifest is revalidated each visit.
          {
            urlPattern: ({ url }) => /\/audio\/(words|sentences)\/.+\.mp3$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'anan-audio-clips',
              expiration: { maxEntries: 3000 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.endsWith('/audio/manifest.json'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'anan-audio-manifest' },
          },
          // Phase 38: the data manifest maps each data file to its content-hashed name. It is
          // always asked for fresh (offline: the cached copy), so a new build is seen at once.
          {
            urlPattern: ({ url }) => url.pathname.endsWith('/data-manifest.json'),
            handler: 'NetworkFirst',
            options: { cacheName: 'anan-data-manifest', networkTimeoutSeconds: 5 },
          },
          // The hashed data files never change (a new build is a new name), so Cache First is safe.
          // The app prunes this cache to the current and previous builds (lib/data-files.ts); the
          // plain names (scripts, tests) are not cached here.
          {
            urlPattern: ({ url }) =>
              /\/(lexicon|scenarios|sentences|textbook)\/.+\.[0-9a-f]{10}\.json$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'anan-data-cache',
              expiration: { maxEntries: 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
}));
