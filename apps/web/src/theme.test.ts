import { readFileSync } from 'node:fs';
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
