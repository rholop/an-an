import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** Width × height from a PNG's IHDR chunk. */
function pngSize(rel: string): [number, number] {
  const buf = readFileSync(path.join(ROOT, rel));
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // a real PNG
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('installable on an iPhone / Android home screen (phase 11)', () => {
  const config = read('vite.config.ts');
  const html = read('index.html');

  it('manifest: standalone, portrait, named, with the 192 / 512 / maskable icons', () => {
    expect(config).toMatch(/display:\s*'standalone'/);
    expect(config).toMatch(/orientation:\s*'portrait'/);
    expect(config).toMatch(/short_name:\s*"An'an"/);
    expect(config).toMatch(/purpose:\s*'maskable'/);
  });

  it('every icon the manifest names exists at the size it claims', () => {
    const icons = [...config.matchAll(/src:\s*'(icons\/[^']+)',\s*sizes:\s*'(\d+)x(\d+)'/g)];
    expect(icons.length).toBeGreaterThanOrEqual(3);
    for (const [, src, w, h] of icons) {
      expect(pngSize(`public/${src}`)).toEqual([Number(w), Number(h)]);
    }
  });

  it('has an Apple touch icon (180×180) and the web-app meta tags', () => {
    expect(html).toMatch(/rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
    expect(pngSize('public/icons/apple-touch-icon.png')).toEqual([180, 180]);
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
    expect(html).toContain('name="apple-mobile-web-app-title"');
  });

  it('has a theme colour for light AND dark, and covers the notch', () => {
    expect(html).toMatch(/name="theme-color" media="\(prefers-color-scheme: light\)"/);
    expect(html).toMatch(/name="theme-color" media="\(prefers-color-scheme: dark\)"/);
    expect(html).toContain('viewport-fit=cover');
  });

  it('starts downloading the lexicon immediately, and every screen is its own chunk', () => {
    expect(html).toMatch(/rel="preload" href="\/lexicon\/lexicon\.v2\.json" as="fetch" crossorigin/);
    const app = read('src/App.tsx');
    expect(app).toMatch(/const ChatPage = lazy\(/);
    expect(app).not.toMatch(/^import \{ ChatPage \}/m);
  });
});
