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
          {
            urlPattern: ({ url }) => /\/(lexicon|scenarios|sentences)\//.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'anan-data-cache',
              expiration: { maxEntries: 20 },
            },
          },
        ],
      },
    }),
  ],
}));
