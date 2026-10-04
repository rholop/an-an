#!/usr/bin/env node
// Draws the An'an app icons (a sprout on green) and writes PNGs to public/icons/.
// Rerun after changing the design:  node apps/web/scripts/make-icons.mjs
// Uses the Playwright browser that is already installed for the e2e tests.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(OUT, { recursive: true });

// Full-bleed background (iOS and Android mask it to a rounded shape themselves);
// the artwork stays inside the central 60%, which is also the maskable "safe zone".
const svg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2e7d32"/>
      <stop offset="1" stop-color="#66bb6a"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g fill="none" stroke="#fff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round">
    <path d="M256 372 V232"/>
    <path d="M256 262 C200 262 168 226 168 176 C222 176 256 208 256 262 Z" fill="#fff"/>
    <path d="M256 232 C256 182 292 148 344 148 C344 198 308 232 256 232 Z" fill="#fff"/>
    <path d="M206 372 H306" />
  </g>
</svg>`;

const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
for (const [file, size] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0">${svg(size)}</body>`);
  await page.screenshot({ path: path.join(OUT, file), clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', file);
}
await browser.close();
