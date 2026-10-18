import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 21 Part K: guard rails so the app stays cohesive. Each rule below names the one place a
 * meaning lives; a new file that re-derives it by hand fails here instead of drifting.
 * Phase 29: only labels, My class (labels and visibility) and colours stay here. Progress (due,
 * new, Learned, Mastered, sessions, days) is guarded by the compiler (core no longer exports the
 * low-level predicates) and the `anan/progress-from-ledger` lint rule (eslint-rules/).
 */

const REPO = path.resolve(__dirname, '../../..');
const ROOTS = ['packages/core/src', 'apps/web/src', 'apps/proxy/src'];

function sources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === 'test-fixtures') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push({ rel: path.relative(REPO, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const r of ROOTS) walk(path.join(REPO, r));
  return out;
}

const FILES = sources();

function offenders(re: RegExp, allowed: (rel: string) => boolean): string[] {
  const hits: string[] = [];
  for (const f of FILES) {
    if (allowed(f.rel)) continue;
    f.text.split('\n').forEach((line, i) => {
      if (re.test(line)) hits.push(`${f.rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

describe('Phase 21 architecture', () => {
  it('scans the real source tree', () => {
    expect(FILES.some((f) => f.rel === 'packages/core/src/progress/terms.ts')).toBe(true);
    expect(FILES.some((f) => f.rel === 'apps/web/src/pages/ClozePage.tsx')).toBe(true);
  });

  it('lesson, book and level labels are only built in the label modules', () => {
    const handLabel =
      /`(Lesson|Book|Level|TOCFL|L|第)\s?\$\{|['"](Lesson|Book|Level|TOCFL) ['"]\s*\+|\$\{[^}]*\}課|`來學華語\s?\$\{/;
    const allowed = (rel: string) =>
      [
        'apps/web/src/lib/labels.ts',
        'packages/core/src/textbook/course.ts',
        'packages/core/src/levels.config.ts',
      ].includes(rel);
    expect(offenders(handLabel, allowed)).toEqual([]);
  });

  it('no page reads My class to decide priority (only getStudyFocus does; My class is labels + visibility)', () => {
    // Pages may show the class (labels, the settings editor, the "Your class" section) and limit what
    // is visible, but never order or pick study items from it.
    const classPriority = /(order|rank|priorit|pick|sort|nextNew)\w*\([^)]*\bmyClass\b/i;
    expect(offenders(classPriority, () => false)).toEqual([]);
    // Class-scoped priority used to live in nextNewItems' class mode; it is visibility only now.
    expect(offenders(/classMode|mode:\s*['"]class['"]/, () => false)).toEqual([]);
    // Every page that reads My class at all is listed here, so a new one gets reviewed.
    const readers = FILES.filter(
      (f) => /^apps\/web\/src\/(pages|components|App\.tsx)/.test(f.rel) && /\buseMyClass\(|\bloadMyClass\(|\bgetMyClass\(/.test(f.text),
    ).map((f) => f.rel);
    expect(readers.sort()).toEqual(
      [
        'apps/web/src/App.tsx', // nav label "Textbook · Lesson N"
        'apps/web/src/pages/ChatPage.tsx', // "Your class" section header and unlocks (visibility)
        'apps/web/src/pages/JournalPage.tsx', // "Your class" prompt group label
        'apps/web/src/pages/ReaderPage.tsx', // prefetch cache key only
        'apps/web/src/pages/TextbookPage.tsx', // the My class editor and "this week" chip
      ],
    );
  });

  it('no .mjs file is fetched by URL (Phase 39): the live nginx serves .mjs as application/octet-stream', () => {
    // A `?url` import keeps the .mjs name in the build, and browsers refuse it as a module script.
    // Bundle it instead (e.g. `new Worker(new URL('./x.ts', import.meta.url))`), so it ships as .js.
    const bad = sources().filter((f) => /\.mjs\?url['"]/.test(f.text)).map((f) => f.rel);
    expect(bad).toEqual([]);
  });

  it('the simplified hint is on flashcards only (Phase 41): never in Cloze, chat, the Reader, stories, journal or lessons', () => {
    const users = FILES.filter((f) => /\bWithSimplified\b|components\/SimplifiedHint\.js/.test(f.text)).map((f) => f.rel);
    expect(users.sort()).toEqual(
      [
        'apps/web/src/components/SimplifiedHint.tsx',
        'apps/web/src/pages/ReviewCard.tsx', // Review and Water all
        'apps/web/src/pages/ReviewSettingsPage.tsx', // the setting only
      ].sort(),
    );
    // the settings page only reads the setting key, it never renders the hint
    const settings = FILES.find((f) => f.rel === 'apps/web/src/pages/ReviewSettingsPage.tsx')!;
    expect(settings.text).not.toMatch(/<WithSimplified/);
    // and nothing else converts to simplified
    expect(offenders(/\bloadSimplifier\b|opencc-js\/t2cn/, (rel) => ['apps/web/src/lib/opencc.ts', 'apps/web/src/components/SimplifiedHint.tsx'].includes(rel))).toEqual([]);
  });

  it('no grammar exercise shows its pattern before the answer (Phase 46): only GrammarPrompt, masked until answered', () => {
    const file = (rel: string) => FILES.find((f) => f.rel === rel)!.text;
    /** A function's source, from its declaration to the next top-level function. */
    const body = (text: string, name: string) => {
      const at = text.search(new RegExp(`\\nfunction ${name}\\b|\\nexport function ${name}\\b`));
      expect(at, name).toBeGreaterThanOrEqual(0);
      const rest = text.slice(at + 1);
      const end = rest.search(/\n(export )?function /);
      return end >= 0 ? rest.slice(0, end) : rest;
    };
    const PATTERN = /\.pattern\b(?!\.match)|\bpattern\(/;
    const steps = file('apps/web/src/pages/GrammarStep.tsx');
    for (const fn of ['GrammarExerciseCard', 'GrammarRound', 'FillView', 'PickView', 'TileView'])
      expect(body(steps, fn), fn).not.toMatch(PATTERN);
    // the lesson step: the exercise part (the outcome list after the step may name the points)
    const lesson = body(steps, 'GrammarStep');
    expect(lesson.slice(lesson.indexOf('const next = () =>')), 'GrammarStep').not.toMatch(PATTERN);
    expect(body(file('apps/web/src/pages/TutoringPage.tsx'), 'TutorGrammarStep'), 'TutorGrammarStep').not.toMatch(PATTERN);
    // Review: the exercise goes through GrammarPrompt; the flip card shows the pattern only once revealed
    const review = file('apps/web/src/pages/ReviewCard.tsx');
    expect(body(review, 'ReviewCard'), 'ReviewCard').not.toMatch(PATTERN);
    const flip = body(review, 'FlipFace');
    const revealedAt = flip.indexOf('{revealed ? (');
    flip.split('\n').forEach((line, i, lines) => {
      if (PATTERN.test(line)) expect(lines.slice(0, i).join('\n').length, `FlipFace: ${line.trim()}`).toBeGreaterThan(revealedAt);
    });
    // GrammarPrompt: the full pattern only when answered
    const prompt = file('apps/web/src/components/GrammarPrompt.tsx');
    expect(prompt.match(/item\.pattern/g)).toEqual(['item.pattern', 'item.pattern']);
    expect(prompt).toMatch(/answered \? item\.pattern : maskPatternFor\(item\.pattern, ex\)/);
  });

  it('every colour is a theme token (Phase 22): none written outside src/theme.css', () => {
    const colour = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(Canvas|CanvasText|ButtonFace|ButtonText|GrayText)\b/;
    const css: { rel: string; text: string }[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.css')) css.push({ rel: path.relative(REPO, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') });
      }
    };
    walk(path.join(REPO, 'apps/web/src'));
    expect(css.some((f) => f.rel === 'apps/web/src/theme.css')).toBe(true);
    const hits: string[] = [];
    for (const f of css) {
      if (f.rel === 'apps/web/src/theme.css') continue;
      f.text.split('\n').forEach((line, i) => {
        if (colour.test(line.replace(/\/\*.*?\*\//g, ''))) hits.push(`${f.rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
    // inline styles and SVG fills in components use tokens too (HTML entities like &#x… aside)
    expect(
      offenders(/(color|fill|stroke|background)\s*[:=]\s*['"{]?\s*(#[0-9a-fA-F]{3,8}\b|rgba?\()/, (rel) => !rel.startsWith('apps/web/src/')),
    ).toEqual([]);
  });
});
