#!/usr/bin/env node
// First-load timing on a throttled phone connection (phase 11).
//   pnpm --filter @anan/web build && node apps/web/scripts/measure-load.mjs
// Serves dist/ at /an-an/ with Brotli (as holop.dev's Cloudflare does), emulates
// Chrome's "Fast 4G" (9 Mbps, 170 ms) and reports the time until each screen has
// real content, with and without a 4x CPU slowdown. Chromium only (CDP throttling).
// Timings vary by machine: compare runs on the same machine, ~3 s is the target.
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const brCache = {};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]).replace(/^\/an-an\/?/, '/');
  let file = path.join(DIST, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const ext = path.extname(file);
  const body = fs.readFileSync(file);
  const comp = /\.(html|js|css|json|webmanifest)$/.test(ext);
  const ae = req.headers['accept-encoding'] || '';
  res.setHeader('content-type', types[ext] || 'application/octet-stream');
  if (comp && /br/.test(ae)) { res.setHeader('content-encoding', 'br'); const key = file; brCache[key] ??= zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }); res.end(brCache[key]); }
  else if (comp && /gzip/.test(ae)) { res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync(body, { level: 6 })); }
  else res.end(body);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

async function measure(label, route, selector, { cpu = 4 } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  await ctx.addInitScript(() => { localStorage.setItem('anan.siteCode', 'tofu'); localStorage.setItem('anan.profile', 'ron'); localStorage.setItem('anan.sync.disabled', '1'); });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8, latency: 170 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/an-an/?page=${route}`, { waitUntil: 'commit' });
  await page.waitForSelector(selector, { timeout: 60000 });
  const t1 = Date.now();
  const shell = await page.evaluate(() => performance.getEntriesByType('paint').map((e) => `${e.name}=${Math.round(e.startTime)}`).join(' '));
  console.log(`${label}: ${t1 - t0} ms to ${selector}   (${shell})`);
  await browser.close();
}
for (let i = 0; i < 3; i++) await measure('garden (home), cold, Fast 4G, normal CPU, run '+(i+1), 'garden', 'h1:has-text("Word garden")', { cpu: 1 });
await measure('garden (home), cold, Fast 4G + 4x CPU slowdown', 'garden', 'h1:has-text("Word garden")');
await measure('chat list, cold', 'chat', '.chat-scenario-card');
await measure('review, cold', 'review', 'h1, .review-page');
await measure('garden, no CPU throttle', 'garden', 'h1:has-text("Word garden")', { cpu: 1 });
server.close();
