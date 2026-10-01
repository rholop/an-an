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
        theme_color: '#1b1b1b',
        icons: [],
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
