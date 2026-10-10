import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 22: every text colour passes WCAG AA on every background it sits on, in both themes.
 * Reads the real tokens from src/theme.css.
 */

const CSS = readFileSync(path.resolve(__dirname, 'theme.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const at = CSS.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no ${selector} block`);
  const body = CSS.slice(at, CSS.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}

const LIGHT = block(':root');
const DARK = block(":root[data-theme='dark']");
const DARK_AUTO = block(":root:not([data-theme='light'])");

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const BACKGROUNDS = ['--bg', '--surface', '--surface-2'];
/** Small text: 4.5:1. */
const TEXT = [
  '--text',
  '--text-muted',
  '--accent',
  '--info-text',
  '--warn-text',
  '--danger-text',
  '--bloom-text',
  '--seed-text',
];
/** Icons, bars, borders that carry meaning, large text: 3:1. */
const GRAPHICS = ['--accent-soft', '--water', '--bloom', '--focus', '--danger'];

describe.each([
  ['light', LIGHT],
  ['dark', DARK],
])('theme tokens (%s)', (_name, t) => {
  it('defines every token the app uses', () => {
    for (const k of [
      ...BACKGROUNDS,
      ...TEXT,
      ...GRAPHICS,
      '--on-accent',
      '--border',
      '--popover-bg',
      '--popover-fg',
    ])
      expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it.each(TEXT)('%s passes AA (4.5:1) on every background', (fg) => {
    for (const bg of BACKGROUNDS)
      expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(GRAPHICS)('%s passes 3:1 for icons and bars on every background', (fg) => {
    for (const bg of BACKGROUNDS)
      expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  it('text on a filled accent button, and in the popover, passes AA', () => {
    expect(contrast(t['--on-accent']!, t['--accent']!)).toBeGreaterThanOrEqual(4.5);
    // the Review tab's due badge
    expect(contrast(t['--on-accent']!, t['--info-text']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--popover-fg']!, t['--popover-bg']!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('theme blocks', () => {
  it('"Auto" in a dark system uses exactly the Dark tokens', () => {
    expect(DARK_AUTO).toEqual(DARK);
  });
  it('light uses the Solarized-green values from the brief', () => {
    expect(LIGHT['--bg']).toBe('#f3f4e3');
    expect(LIGHT['--surface']).toBe('#fbfbf1');
    expect(LIGHT['--text']).toBe('#073642');
    expect(DARK['--bg']).toBe('#002b36');
    expect(DARK['--text']).toBe('#93a1a1');
  });
});

/**
 * Phase 30: Chinese text has its own size tokens (--zh-hero, --zh-body, --zh-small, multiplied by
 * Settings → Chinese text size). A Chinese text class never sets a fixed size.
 */
const ZH_CLASSES = [
  'an-text',
  'an-text--inline',
  'review-card-front',
  'review-pick-zh',
  'leech-char-glyph',
  'cloze-sentence',
  'cloze-answered-sentence',
  'cloze-chip',
  'pinyin-front',
  'pinyin-syllable-char',
  'pinyin-match-zh',
  'pinyin-sort-word',
  'placement-word',
  'story-words-zh',
  'stories-item-title',
  'journal-text',
  'listen-diff',
  'listen-reveal',
  'audio-review-text',
  'textbook-cloze',
  'chat-reply-preview',
  'settings-zh-sample',
];

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return cssFiles(p);
    return name.endsWith('.css') && name !== 'theme.css' ? [p] : [];
  });
}

/** Every `selector { … font-size: … }` (nested @media blocks included), with comments removed. */
function fontSizeRules(css: string): { selector: string; value: string }[] {
  const out: { selector: string; value: string }[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const size = /(?:^|;|\s)font-size:\s*([^;]+)/.exec(m[2]!);
    if (size) out.push({ selector: m[1]!.trim(), value: size[1]!.trim() });
  }
  return out;
}

/** The class names in the last compound of each selector in a list (the element being styled). */
function styledClasses(selector: string): string[] {
  return selector.split(',').flatMap((one) => {
    const last = one.trim().split(/[\s>+~]+/).pop() ?? '';
    return [...last.matchAll(/\.([\w-]+)/g)].map((c) => c[1]!);
  });
}

describe('Chinese text size tokens (Phase 30)', () => {
  it('theme.css defines --zh-hero (never below 44 px at Normal), --zh-body and --zh-small from --zh-scale', () => {
    expect(CSS).toMatch(/--zh-scale:\s*1;/);
    expect(CSS).toMatch(/--zh-hero:\s*calc\(clamp\(2\.75rem,[^;]*\*\s*var\(--zh-scale\)\)/);
    expect(CSS).toMatch(/--zh-body:\s*calc\([^;]*var\(--zh-scale\)\)/);
    expect(CSS).toMatch(/--zh-small:\s*calc\([^;]*var\(--zh-scale\)\)/);
  });

  it('Chinese text classes size their text only with --zh-* tokens', () => {
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const file of cssFiles(path.resolve(__dirname))) {
      for (const { selector, value } of fontSizeRules(readFileSync(file, 'utf8'))) {
        const zh = styledClasses(selector).filter((c) => ZH_CLASSES.includes(c) || /(^|-)zh($|-)/.test(c));
        if (zh.length === 0) continue;
        zh.forEach((c) => seen.add(c));
        // an English front of the review card keeps its own size; its Chinese form is [lang|='zh']
        if (/review-card-front(--small)?$/.test(selector)) continue;
        if (!/var\(--zh-(hero|body|small)\)/.test(value) && value !== 'inherit')
          bad.push(`${path.basename(file)}: ${selector} { font-size: ${value} }`);
      }
    }
    expect(bad).toEqual([]);
    // the check really sees the main Chinese classes
    for (const c of ['an-text', 'review-card-front', 'cloze-sentence', 'pinyin-front', 'placement-word']) expect(seen).toContain(c);
  });
});
