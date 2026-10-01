import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
        // The built lexicon (data/build/lexicon.v1.json, served from
        // public/lexicon/) is a few MB and rarely changes — too big/dynamic
        // for the precache manifest, but every page that needs it
        // (reader/review/placement/anki-import) calls fetch() for it, so a
        // CacheFirst runtime rule is what actually makes "works offline"
        // true after the first visit, not just the app shell.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/lexicon/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'lexicon-cache',
              expiration: { maxEntries: 5 },
            },
          },
        ],
      },
    }),
  ],
});
