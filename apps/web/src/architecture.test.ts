import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 21 Part K: guard rails so the app stays cohesive. Each rule below names the one place a
 * meaning lives; a new file that re-derives it by hand fails here instead of drifting.
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

  it("only core/progress decides Learned / Mastered from a card's state or stability", () => {
    const stateCmp =
      /\.state\s*[!=]==?\s*['"](review|mature)['"]|['"](review|mature)['"]\s*[!=]==?\s*[\w.]*\.state\b|\[\s*['"](review|mature)['"][^\]]*\]\s*\.includes/;
    const stabilityCmp = /\bstability\s*[<>]=?\s*[\w.]+|[\w.)]+\s*[<>]=?\s*[\w.]*\.stability\b/;
    const allowed = (rel: string) =>
      rel.startsWith('packages/core/src/progress/') ||
      // where the item state itself is computed from FSRS (the definition, not a reading of it)
      rel === 'packages/core/src/learner/fsrs-instance.ts' ||
      // which listening exercise types a word has unlocked (a difficulty ladder, not a progress number)
      rel === 'packages/core/src/listening/exercises.ts';
    expect(offenders(stateCmp, allowed)).toEqual([]);
    expect(offenders(stabilityCmp, allowed)).toEqual([]);
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
});
