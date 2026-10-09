import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 29 Part C.3: "numbers agree". One seeded profile, read at 08:00 (morning session), 12:00
 * (between sessions) and 18:00 (evening session) in New York. Every count a screen renders for the
 * same thing is the same number: Home, Review, the nav badge, Garden, Water all, Review early,
 * Cloze, the Textbook lesson chip and Vocab step, and Progress. This is the test that would have
 * caught "Home says 3, Review shows 0", "lesson 100% but Now studying 17%" and "10 to water".
 */

type AnanHandle = {
  db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } };
  learnerService: { recordBulk: (evs: unknown[], now?: Date) => Promise<unknown> };
};

const TZ = 'America/New_York';
// Wednesday 14 October 2026 (EDT, UTC-4)
const at = (hour: number) => new Date(Date.UTC(2026, 9, 14, hour + 4));
const nyDate = (day: number, hour: number) => new Date(Date.UTC(2026, 9, day, hour + 4));

// N1 words outside the textbook: 年 老 國 姓名 我們 中午 書 台灣 媽 寫 電視機 美國
const W = [
  'tocfl-09b8af0618', 'tocfl-0c4cb5b280', 'tocfl-114c0d4299', 'tocfl-1697ecc50f', 'tocfl-1f6fbc0616', 'tocfl-20eacb253a',
  'tocfl-2580412342', 'tocfl-26430abbca', 'tocfl-365a49247d', 'tocfl-3cd12c2336', 'tocfl-5bd9d2eac5', 'tocfl-61f56a3169',
];
/** Due times: 3 overdue since last evening, 2 this morning, 4 at 1 pm (between sessions), 1 at
 * 7 am tomorrow (the evening session's), 2 next week. */
const DUE: [string[], Date][] = [
  [W.slice(0, 3), nyDate(13, 20)],
  [W.slice(3, 5), nyDate(14, 9)],
  [W.slice(5, 9), nyDate(14, 13)],
  [W.slice(9, 10), nyDate(15, 7)],
  [W.slice(10), nyDate(20, 12)],
];
/** The session each clock time opens, and what the next one holds. */
const EXPECT = {
  8: { session: 9, next: 10 }, // the morning holds everything due before 4 pm
  12: { session: 0, next: 10 }, // between: the morning's 9 roll into the evening, plus 7 am tomorrow
  18: { session: 10, next: 0 },
} as const;

async function open(page: Page, route: string) {
  await page.goto(`/?page=${route}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
}

async function seed(page: Page) {
  const book = (await (await page.request.get('/textbook/laixue-1/book.json')).json()) as {
    textbook: { lessons: { vocab: string[]; properNouns: string[]; grammarWords?: string[]; grammar: string[] }[] };
  };
  const l1 = book.textbook.lessons[0]!;
  const lessonWords = [...l1.vocab.filter((id) => !l1.properNouns.includes(id)), ...(l1.grammarWords ?? [])];
  await page.evaluate(
    async ({ due, lessonWords, grammar, lastWeek }) => {
      const anan = (window as unknown as { __anan: AnanHandle }).__anan;
      const when = new Date(lastWeek);
      // Lesson 1: passed "I already know this" (words both ways, its grammar points)
      await anan.learnerService.recordBulk(
        [
          ...lessonWords.flatMap((id) =>
            (['recognition', 'production'] as const).map((skill) => ({ item: { kind: 'word', id }, skill, kind: 'known_check_passed', at: when })),
          ),
          ...grammar.map((id) => ({ item: { kind: 'grammar', id }, skill: 'recognition', kind: 'known_check_passed', at: when })),
        ],
        when,
      );
      // Review cards answered before, due at the given times
      await anan.db.items.bulkPut(
        due.flatMap(([ids, at]) =>
          ids.map((id) => ({
            pk: `word:${id}:recognition`,
            item: { kind: 'word', id },
            skill: 'recognition',
            card: {
              due: new Date(at),
              stability: 4,
              difficulty: 5,
              elapsed_days: 2,
              scheduled_days: 4,
              learning_steps: 0,
              reps: 3,
              lapses: 0,
              state: 2,
              last_review: new Date(lastWeek),
            },
            state: 'review',
            lapses: 0,
            leech: false,
            leechTreatmentsTried: [],
            clozeRung: 1,
            clozeStreak: 0,
            familiarity: 0,
            readingDependence: 0,
            flags: {},
            updatedAt: new Date(lastWeek),
          })),
        ),
      );
    },
    { due: DUE.map(([ids, d]) => [ids, d.getTime()] as [string[], number]), lessonWords, grammar: l1.grammar, lastWeek: nyDate(7, 8).getTime() },
  );
}

const num = async (loc: Locator, re: RegExp): Promise<number> => {
  const m = re.exec(await loc.innerText());
  expect(m, `${re} in "${await loc.innerText()}"`).not.toBeNull();
  return Number(m![1]);
};

async function badge(page: Page): Promise<number> {
  const b = page.getByTestId('nav-due-badge').first();
  return (await b.count()) === 0 ? 0 : Number(await b.innerText());
}

test.describe('numbers agree (Phase 29)', () => {
  test.setTimeout(90_000);

  test('Home, Review, badge, Garden, Water all, Review early, Cloze, Textbook and Progress agree at 8 am, noon and 6 pm', async ({ page }) => {
    await page.clock.install({ time: at(8) });
    await page.addInitScript((zone) => localStorage.setItem('anan.sessions.defaultZone', zone), TZ);
    await open(page, 'garden');
    await seed(page);

    const progressLines: string[] = [];
    for (const hour of [8, 12, 18] as const) {
      await page.clock.setSystemTime(at(hour));
      const want = EXPECT[hour];
      await open(page, 'garden');

      // Home
      const status = page.getByTestId('home-review-status');
      await expect(status).toBeVisible();
      if (want.session > 0) {
        await expect(status).toContainText(`review · ${want.session} cards`);
        expect(await num(page.getByTestId('review-all-btn'), /\((\d+)\)/)).toBe(want.session);
        // one card per word here, so Water all's words = the session's cards
        expect(await num(page.getByTestId('water-all-btn'), /\((\d+)\)/)).toBe(want.session);
      } else {
        await expect(status).toContainText(`(${want.next} cards)`);
        await expect(page.getByTestId('review-all-btn')).toHaveCount(0);
        await expect(page.getByTestId('garden-watered')).toContainText(`${want.next} words in the evening session`);
      }
      // the nav badge
      expect(await badge(page)).toBe(want.session);
      // Garden: the plants that need water
      await expect(page.locator('.garden-tile--wilting, .garden-tile--withered')).toHaveCount(want.session);

      // Review: the same status line and session size
      const homeLine = await status.innerText();
      await page.getByRole('button', { name: 'Review', exact: true }).first().click();
      await expect(page.getByTestId('review-status')).toHaveText(homeLine);
      expect(await num(page.getByTestId('review-counts'), /^(\d+) due/)).toBe(want.session);

      if (want.session === 0) {
        // Review early is one size from every entry: Review's own link (shown once its new words
        // are done) and Home's button
        const reviewEarly = page.getByTestId('review-early');
        if (await reviewEarly.isVisible()) {
          await reviewEarly.click();
          await expect(page.getByTestId('review-counts')).toContainText(new RegExp(`^${want.next} due`));
        }
        await open(page, 'garden');
        await page.getByTestId('review-early').first().click();
        await expect(page.getByRole('heading', { name: 'Review early' })).toBeVisible();
        await expect(page.getByTestId('review-counts')).toContainText(new RegExp(`^${want.next} due`));
      } else {
        // Water all covers the same words
        await open(page, 'garden');
        await page.getByTestId('water-all-btn').click();
        await expect(page.locator('.water-all-meta')).toContainText(`${want.session} words`);
      }

      // Cloze: this session's cards plus at most Cloze's new words (5, progress.config newPerQueue)
      await open(page, 'cloze');
      const start = page.getByTestId('cloze-start');
      await expect(start.or(page.getByTestId('cloze-empty'))).toBeVisible();
      const clozeItems = (await start.isVisible()) ? await num(start, /\((\d+) items?\)/) : 0;
      expect(clozeItems).toBeLessThanOrEqual(want.session + 5);
      if (want.session > 0) expect(clozeItems).toBeGreaterThan(0);

      // Textbook: lesson 1 is Mastered on the chip, 100% on the lesson, and nothing is left in Vocab
      await open(page, 'textbook');
      const l1 = page.getByTestId('lesson-1');
      await expect(l1.locator('.textbook-chip--good')).toBeVisible();
      await expect(l1.getByTestId('lesson-progress')).toContainText('Mastered 100%');
      await l1.getByRole('button').first().click();
      await page.getByTestId('study-lesson').click();
      await expect(page.getByTestId('lesson-vocab-empty')).toContainText('This lesson is mastered.');

      // Progress: the same Learned / Mastered whatever the time of day
      await open(page, 'progress');
      progressLines.push(
        `${await page.getByTestId('level-progress-N1').locator('.lm-line').innerText()} | ${await page.getByTestId('progress-all').locator('.lm-line').innerText()}`,
      );
    }
    expect(new Set(progressLines).size).toBe(1);
  });
});
