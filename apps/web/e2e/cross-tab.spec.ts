import { gunzipSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 21 Part K: one seeded profile (class = Lesson 3, Lesson 1 partly mastered, a leech and an
 * imported card, a few due reviews). Every tab must show the same current lesson, the same
 * Learned · Mastered numbers and the same due count, at phone and desktop sizes; and every tab
 * must update without a reload when My class changes, a review is finished or a sync merge lands.
 */

declare global {
  interface Window {
    __anan: {
      db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } };
      learnerService: { record: (e: unknown, now: Date) => Promise<unknown> };
    };
    __ananSync: { pushInner: (keepalive: boolean) => Promise<void>; pull: () => Promise<unknown> };
  }
}

const DUE_WORDS = ['tocfl-7c491838af', 'tocfl-29992340ae', 'tocfl-3361e60084']; // 咖啡 吃 喝
const LESSON_3 = '來學華語 1 · Lesson 3';

async function setClassLesson(page: Page, n: string) {
  await page.getByTestId('my-class-toggle').check();
  await page.getByTestId('my-class-lesson').selectOption(n);
  await expect(page.getByTestId('class-status')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /Added \d+ words and grammar points/ })).toBeVisible();
}

/** Lesson words of book 1 (core vocabulary, names excluded), from the shipped book file. */
async function lessonCore(page: Page, n: number): Promise<string[]> {
  return page.evaluate(async (lessonN) => {
    const res = await fetch('/textbook/laixue-1/book.json');
    const book = (await res.json()) as {
      textbook: { lessons: { n: number; vocab: string[]; properNouns: string[] }[] };
    };
    const l = book.textbook.lessons.find((x) => x.n === lessonN)!;
    return l.vocab.filter((id) => !l.properNouns.includes(id));
  }, n);
}

/** Card rows: `mastered` = strong recognition + production; `leech`; `imported`; `due` = due now. */
async function seed(page: Page, rows: { id: string; kind: 'mastered' | 'leech' | 'imported' | 'due' }[]) {
  await page.evaluate(async (list) => {
    const now = new Date();
    const day = 86_400_000;
    const row = (id: string, skill: string, stability: number, over: Record<string, unknown> = {}) => ({
      pk: `word:${id}:${skill}`,
      item: { kind: 'word', id },
      skill,
      card: {
        due: new Date(now.getTime() + 10 * day),
        stability,
        difficulty: 5,
        elapsed_days: 3,
        scheduled_days: 10,
        learning_steps: 0,
        reps: 3,
        lapses: 0,
        state: 2,
        last_review: new Date(now.getTime() - 3 * day),
      },
      state: stability >= 21 ? 'mature' : 'review',
      lapses: 0,
      leech: false,
      leechTreatmentsTried: [],
      clozeRung: 1,
      clozeStreak: 0,
      familiarity: 0,
      readingDependence: 0,
      flags: {},
      updatedAt: now,
      ...over,
    });
    const out: unknown[] = [];
    for (const { id, kind } of list) {
      if (kind === 'mastered') out.push(row(id, 'recognition', 40), row(id, 'production', 10));
      if (kind === 'leech') out.push(row(id, 'recognition', 2, { leech: true, lapses: 8 }));
      if (kind === 'imported') {
        const r = row(id, 'recognition', 5, { flags: { imported: true } }) as { card: { reps: number } };
        r.card.reps = 1; // the seed's own rep: no answer in the app yet
        out.push(r);
      }
      if (kind === 'due') {
        const r = row(id, 'recognition', 2) as { card: { due: Date } };
        r.card.due = new Date(now.getTime() - 2 * day);
        out.push(r);
      }
    }
    await window.__anan.db.items.bulkPut(out);
  }, rows);
}

/** The "Learned X% · Mastered Y%" line of a LearnedMastered block (without the tricky/imported notes). */
const lmLine = async (page: Page, scope: ReturnType<Page['getByTestId']>) =>
  (await scope.locator('.lm-line').first().innerText()).split('\n')[0]!.split(' · ').slice(0, 2).join(' · ').replace('ⓘ', '').trim();

async function seedProfile(page: Page) {
  await page.goto('/?page=textbook');
  await page.waitForFunction(() => Boolean(window.__anan));
  await setClassLesson(page, '3');
  const l1 = await lessonCore(page, 1);
  await seed(page, [
    ...l1.slice(0, 3).map((id) => ({ id, kind: 'mastered' as const })),
    { id: l1[3]!, kind: 'leech' },
    { id: l1[4]!, kind: 'imported' },
    ...DUE_WORDS.filter((id) => !l1.includes(id)).map((id) => ({ id, kind: 'due' as const })),
  ]);
  return DUE_WORDS.filter((id) => !l1.includes(id)).length;
}

for (const size of [
  { name: 'phone', viewport: { width: 390, height: 844 } },
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
]) {
  test.describe(`every tab agrees (${size.name})`, () => {
    test.use({ viewport: size.viewport });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => localStorage.removeItem('anan.study.disabled'));
    });

    test('same lesson, same Learned · Mastered, same due count', async ({ page }) => {
      test.setTimeout(60_000);
      const due = await seedProfile(page);

      // Home: Lesson 3 (the class) is active, Lessons 1 and 2 are catch-up.
      await page.goto('/?page=garden');
      await expect(page.getByTestId('now-studying-name')).toContainText(LESSON_3);
      await expect(page.getByTestId('now-studying-name')).toContainText('(your class)');
      await expect(page.getByTestId('now-studying-catchup')).toContainText('Lesson 1');
      await expect(page.getByTestId('now-studying-catchup')).toContainText('Lesson 2');
      const homeLine = await lmLine(page, page.getByTestId('now-studying-progress'));
      expect(homeLine).toMatch(/^Learned \d+% · Mastered \d+%$/);
      await expect(page.getByTestId('home-review-status')).toContainText(`Evening review · ${due} card`);
      // Phase 22: the two Home buttons carry the same counts (one card per due word here).
      await expect(page.getByTestId('review-all-btn')).toHaveText(`Review all (${due})`);
      await expect(page.getByTestId('water-all-btn')).toHaveText(`💧 Water all (${due})`);

      // Textbook: the same lesson carries the "Current lesson" chip and the same numbers.
      await page.goto('/?page=textbook');
      const row3 = page.getByTestId('lesson-3');
      await expect(row3.getByTestId('current-lesson-chip')).toBeVisible();
      await expect(page.getByTestId('current-lesson-chip')).toHaveCount(1);
      expect(await lmLine(page, row3.getByTestId('lesson-progress'))).toBe(homeLine);
      // Lesson 1: 3 mastered words, the leech counts as Learned but never Mastered, the import is shown.
      const row1 = page.getByTestId('lesson-1').getByTestId('lesson-progress');
      await expect(row1).toContainText('1 tricky');
      await expect(row1).toContainText('imported');
      expect(await lmLine(page, row1)).not.toBe('Learned 0% · Mastered 0%');

      // Home's catch-up Lesson 1 opens the same numbers as the Textbook row.
      const textbookL1 = await lmLine(page, row1);
      await page.goto('/?page=garden');
      await page.getByTestId('now-studying-catchup').getByRole('button', { name: 'Lesson 1' }).click();
      await expect(page.getByTestId('study-session')).toBeVisible();
      await page.goto('/?page=textbook');
      expect(await lmLine(page, page.getByTestId('lesson-1').getByTestId('lesson-progress'))).toBe(textbookL1);

      // Chat: the pinned scenarios are the current lesson's.
      await page.goto('/?page=chat');
      await expect(page.getByTestId('pinned-scenarios')).toContainText(`Current lesson: ${LESSON_3}`);

      // Progress: the level numbers come from the same summary (N1 holds the mastered words).
      await page.goto('/?page=progress');
      await expect(page.getByTestId('level-progress-N1')).toContainText(/Learned \d+% · Mastered \d+%/);

      // Review: the same due count as Home.
      await page.goto('/?page=review');
      await expect(page.getByTestId('review-counts')).toContainText(new RegExp(`^${due} due · `));
      await expect(page.getByTestId('review-status')).toContainText(`Evening review · ${due} card`);
    });
  });
}

test.describe('every tab stays fresh without a reload', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('anan.study.disabled'));
  });

  test('My class change, a finished review and a sync merge all show up in place', async ({ page }) => {
    test.setTimeout(60_000);
    const due = await seedProfile(page);
    await page.goto('/?page=textbook');
    const nav = page.getByTestId('nav-textbook');

    // 1. My class: the header and the lesson chip move without a reload.
    await expect(nav).toHaveText('Textbook · Lesson 3');
    await page.getByTestId('my-class-lesson').selectOption('4');
    await expect(nav).toHaveText('Textbook · Lesson 4');
    await expect(page.getByTestId('lesson-4').getByTestId('current-lesson-chip')).toBeVisible();
    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.getByTestId('now-studying-name')).toContainText('來學華語 1 · Lesson 4');
    await page.getByRole('button', { name: /Textbook · Lesson 4/ }).click();
    await page.getByTestId('my-class-lesson').selectOption('3');
    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.getByTestId('now-studying-name')).toContainText(LESSON_3);

    // 2. A finished review: Home's due count drops while Home stays on screen.
    await expect(page.getByTestId('home-review-status')).toContainText(`Evening review · ${due} card`);
    await page.evaluate(
      (id) =>
        window.__anan.learnerService.record(
          { item: { kind: 'word', id }, skill: 'recognition', kind: 'review_good', at: new Date() },
          new Date(),
        ),
      DUE_WORDS[0]!,
    );
    await expect(page.getByTestId('home-review-status')).toContainText(`Evening review · ${due - 1} card`);
    // ...and the Review tab, reached by the nav (no reload), agrees.
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByTestId('review-counts')).toContainText(new RegExp(`^${due - 1} due · `));
    await page.getByRole('button', { name: 'Home' }).click();

    // 3. A sync merge: the other device mastered Lesson 3's words; Home's numbers change in place.
    const before = await lmLine(page, page.getByTestId('now-studying-progress'));
    let remote: unknown = null;
    await page.route('**/v1/sync/**', async (route) => {
      const req = route.request();
      if (req.method() === 'PUT') {
        // Phase 28: pushes are gzipped
        const raw = req.postDataBuffer() ?? Buffer.from('{}');
        const text = req.headers()['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
        remote = (JSON.parse(text) as { data: unknown }).data;
        await route.fulfill({ json: { rev: 1 } });
      } else {
        await route.fulfill({ json: { rev: 2, updatedAt: new Date().toISOString(), data: remote } });
      }
    });
    await page.evaluate(() => window.__ananSync.pushInner(false));
    expect(remote).not.toBeNull();
    const l3 = await lessonCore(page, 3);
    remote = await page.evaluate(
      ({ data, ids }) => {
        const d = data as { items: Record<string, unknown>[] };
        const now = new Date();
        // The other device reviewed these words a lot: same rows, much stronger cards, newer.
        const items = d.items.map((r) => {
          const id = (r.item as { id: string }).id;
          if (!ids.includes(id) || (r.skill !== 'recognition' && r.skill !== 'production')) return r;
          const stability = r.skill === 'recognition' ? 40 : 10;
          return {
            ...r,
            card: {
              ...(r.card as object),
              due: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
              stability,
              reps: 4,
              state: 2,
              last_review: new Date(now.getTime() - 86_400_000).toISOString(),
            },
            state: stability >= 21 ? 'mature' : 'review',
            updatedAt: new Date(now.getTime() + 60_000).toISOString(),
          };
        });
        const touched = items.filter((r) => ids.includes((r.item as { id: string }).id)).length;
        if (touched === 0) throw new Error('lesson 3 has no cards to merge over');
        return { ...d, items };
      },
      { data: remote, ids: l3.slice(0, 4) },
    );
    await page.evaluate(() => window.__ananSync.pull());
    // Still on Home (a merge never moves you to another tab), with the new numbers.
    await expect(page.getByTestId('now-studying-name')).toContainText(LESSON_3);
    await expect
      .poll(() => lmLine(page, page.getByTestId('now-studying-progress')), { timeout: 10_000 })
      .not.toBe(before);
    await page.unroute('**/v1/sync/**');
  });
});
