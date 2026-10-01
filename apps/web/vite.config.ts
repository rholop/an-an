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
    }),
  ],
});
