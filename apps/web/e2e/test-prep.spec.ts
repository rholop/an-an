import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 49: with TOCFL test prep on, Home shows one quiet readiness line (test words, reading
 * accuracy, last result) that opens the timed drill; one drill round of five items runs to its
 * result at phone and short-laptop sizes.
 */

const SIZES = [
  { name: 'phone', viewport: { width: 390, height: 844 } },
  { name: 'laptop', viewport: { width: 1366, height: 620 } },
] as const;

type Db = {
  items: { bulkPut: (rows: unknown[]) => Promise<unknown> };
  settings: { put: (row: unknown) => Promise<unknown> };
  evidence: { toArray: () => Promise<Array<{ kind: string; context?: { source?: string } }>> };
};

const book = JSON.parse(readFileSync(fileURLToPath(new URL('../public/textbook/laixue-1/book.json', import.meta.url)), 'utf8')) as {
  lessons?: { n: number; vocab: string[]; properNouns: string[] }[];
  textbook?: { lessons: { n: number; vocab: string[]; properNouns: string[] }[] };
};
const lessons = (book.textbook ?? book).lessons!;
/** Every book-1 word the learner has answered (the drill only asks about answered test words). */
const ANSWERED = [...new Set(lessons.flatMap((l) => l.vocab.filter((id) => !l.properNouns.includes(id))))];

async function seed(page: Page) {
  await page.goto('/?page=garden');
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
  await page.evaluate(async (answered) => {
    const now = Date.now();
    const db = (window as unknown as { __anan: { db: Db } }).__anan.db;
    await db.items.bulkPut(
      answered.map((id, i) => ({
        pk: `word:${id}:recognition`,
        item: { kind: 'word', id },
        skill: 'recognition',
        state: 'review',
        lapses: 0,
        leech: false,
        leechTreatmentsTried: [],
        clozeRung: 1,
        clozeStreak: 0,
        familiarity: 0,
        readingDependence: 0,
        flags: {},
        updatedAt: new Date(now),
        card: {
          due: new Date(now + 5 * 86_400_000),
          stability: 4 + (i % 5),
          difficulty: 5,
          elapsed_days: 2,
          scheduled_days: 7,
          learning_steps: 0,
          reps: 3,
          lapses: 0,
          state: 2,
          last_review: new Date(now - 2 * 86_400_000),
        },
      })),
    );
    await db.settings.put({
      key: 'studyOrder',
      value: { enabled: true, testPrep: { on: true, target: 'L2', startedAt: new Date(now).toISOString() } },
    });
  }, ANSWERED);
  await page.reload();
}

for (const size of SIZES) {
  test(`test prep: Home readiness line and one drill round at ${size.name} size`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    await seed(page);

    const line = page.getByTestId('readiness-line');
    await expect(line).toBeVisible();
    await expect(line).toContainText(/Level 1 words \d[\d,]*\/\d[\d,]*/);
    await expect(line).toContainText(/Level 2 words/);
    // no countdown on Home
    await expect(page.getByText(/days to (the|your) test/i)).toHaveCount(0);
    const box = await line.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.viewport.width);

    await line.click();
    await expect(page.getByTestId('drill-page')).toBeVisible();
    await expect(page.getByTestId('drill-timer')).toBeVisible();
    for (let i = 0; i < 5; i++) {
      const options = page.getByTestId('drill-option');
      await expect(options.first()).toBeVisible();
      expect(await options.count()).toBeGreaterThanOrEqual(3);
      // the last option row fits the window without horizontal scroll
      const last = await options.last().boundingBox();
      expect(last!.x + last!.width).toBeLessThanOrEqual(size.viewport.width);
      await (i % 2 === 0 ? page.locator('[data-testid="drill-option"][data-right="true"]') : options.first()).click();
      await page.getByTestId('drill-next').click();
    }
    await expect(page.getByTestId('drill-result')).toContainText(/ \/ 5 right/);

    // every answer is a drill result; answers on answered cards count like practice (the first of the day is a review)
    const drillKinds = () =>
      page.evaluate(async () =>
        (await (window as unknown as { __anan: { db: Db } }).__anan.db.evidence.toArray()).filter((e) => e.context?.source === 'drill').map((e) => e.kind),
      );
    await expect.poll(async () => (await drillKinds()).filter((k) => k.startsWith('drill_')).length).toBe(5);
    expect((await drillKinds()).filter((k) => k.startsWith('review_')).length).toBeGreaterThan(0);
  });
}
