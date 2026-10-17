import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 45 (owner, 2026-10-17: "Why can't I review the lesson / tutoring lesson vocabulary?"): a
 * lesson's and a tutoring class's words can be practised any time, also when nothing of them is in
 * the session. Only faces a word already has; each card's first answer of the day counts
 * ("counted ✓"), later ones that day are practice only.
 */

type Db = {
  items: { bulkPut: (rows: unknown[]) => Promise<unknown> };
  tutorSessions: { put: (row: unknown) => Promise<unknown> };
  evidence: { toArray: () => Promise<Array<{ kind: string; skill: string; context?: { practice?: boolean } }>> };
};

const book = JSON.parse(readFileSync(fileURLToPath(new URL('../public/textbook/laixue-1/book.json', import.meta.url)), 'utf8')) as {
  lessons?: { n: number; vocab: string[]; properNouns: string[] }[];
  textbook?: { lessons: { n: number; vocab: string[]; properNouns: string[] }[] };
};
const lesson1 = (book.textbook ?? book).lessons!.find((l) => l.n === 1)!;
const VOCAB = [...new Set(lesson1.vocab)].filter((id) => !lesson1.properNouns.includes(id));
const ANSWERED = VOCAB.slice(0, 4);

async function ready(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
}

/** Recognition cards answered three times and due in five days (in no session), and one New
 * production card (a face the word hasn't started: never practised). */
async function seed(page: Page, answered: string[], newProduction?: string, flags: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ answered, newProduction, flags }) => {
      const now = Date.now();
      const base = { lapses: 0, leech: false, leechTreatmentsTried: [], clozeRung: 1, clozeStreak: 0, familiarity: 0, readingDependence: 0, flags: {}, updatedAt: new Date(now) };
      const rows = answered.map((id, i) => ({
        ...base,
        flags,
        pk: `word:${id}:recognition`,
        item: { kind: 'word', id },
        skill: 'recognition',
        state: 'review',
        card: {
          due: new Date(now + 5 * 86_400_000),
          stability: 4 + i,
          difficulty: 5,
          elapsed_days: 2,
          scheduled_days: 7,
          learning_steps: 0,
          reps: 3,
          lapses: 0,
          state: 2,
          last_review: new Date(now - 2 * 86_400_000),
        },
      }));
      if (newProduction) rows.push({
        ...base,
        pk: `word:${newProduction}:production`,
        item: { kind: 'word', id: newProduction },
        skill: 'production',
        state: 'introduced',
        card: { due: new Date(now), stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0 } as never,
        flags: {},
      });
      await (window as unknown as { __anan: { db: Db } }).__anan.db.items.bulkPut(rows);
    },
    { answered, newProduction, flags },
  );
}

const evidence = (page: Page) => page.evaluate(() => (window as unknown as { __anan: { db: Db } }).__anan.db.evidence.toArray());

async function answer(page: Page, grade: 'Good' | 'Easy') {
  await page.getByRole('button', { name: 'Show answer' }).click();
  await page.getByRole('button', { name: grade, exact: true }).click();
}

for (const [label, viewport] of [
  ['phone (390 px)', { width: 390, height: 844 }],
  ['laptop (1280 px)', { width: 1280, height: 800 }],
] as const) {
  test.describe(label, () => {
    test.use({ viewport });

    test('a lesson with nothing in the session: Practise these words (N), only Meaning, first answer counts', async ({ page }) => {
      await ready(page, '/?page=textbook');
      await seed(page, ANSWERED, ANSWERED[0]!);
      await page.reload();
      await page.getByTestId('lesson-1').getByRole('button').first().click();
      await expect(page.getByTestId('practise-words')).toHaveText('Practise these words (4)');
      // the lesson's other words (and its grammar words) have no card yet
      await expect(page.getByTestId('practise-waiting')).toHaveText(/^\s*\d+ words from this lesson start in the next sessions$/);

      await page.getByTestId('practise-words').click();
      const practice = page.getByTestId('practice-page');
      await expect(practice).toBeVisible();
      await expect(practice.getByTestId('practice-counts')).toHaveText('4 left');
      for (let i = 0; i < 4; i++) {
        await expect(practice.getByTestId('review-card')).toHaveAttribute('data-face', 'meaning');
        await answer(page, 'Good');
        await expect(practice.getByTestId('practice-counted')).toBeVisible();
      }
      await expect(practice.getByTestId('practice-done')).toBeVisible();
      const counted = (await evidence(page)).filter((e) => e.context?.practice);
      expect(counted.map((e) => e.kind)).toEqual(['review_good', 'review_good', 'review_good', 'review_good']);
      expect(counted.every((e) => e.skill === 'recognition')).toBe(true);

      // another round the same day: practice only, nothing counted
      await page.getByTestId('practice-again-round').click();
      await answer(page, 'Easy');
      await expect(practice.getByTestId('practice-undo')).toBeVisible();
      await expect(practice.getByTestId('practice-counted')).toHaveCount(0);
      expect((await evidence(page)).at(-1)!.kind).toBe('practice_easy');
      await page.getByRole('button', { name: /← / }).first().click();
      await expect(page.getByTestId('practise-words')).toBeVisible();
    });

    test('a tutoring class: Practise replaces "Nothing from this class to review"', async ({ page }) => {
      await ready(page, '/?page=tutoring');
      // two answered words, Meaning not yet consistently known (so no Pick card joins the session);
      // ticked words with no card would get a Meaning card in the session
      const ids = VOCAB.slice(0, 2);
      await seed(page, ids, undefined, { goodRun: 1 });
      await page.evaluate(async (ids) => {
        const now = new Date();
        await (window as unknown as { __anan: { db: Db } }).__anan.db.tutorSessions.put({
          id: 'class-e2e',
          date: '2026-10-15T10:00',
          tutor: 'Carl',
          topics: [{ zh: '家人', en: 'family' }],
          words: ids.map((id) => ({ wordId: id, zh: id, printed: id, pinyin: '', zhuyin: '', gloss: id, ticked: true, custom: false })),
          grammar: [],
          sentences: [],
          createdAt: now,
          updatedAt: now,
        });
      }, ids);
      await page.reload();
      await page.getByTestId('tutor-class').first().getByRole('button').first().click();
      const classPage = page.getByTestId('tutor-class-page');
      await expect(classPage.getByTestId('practise-words')).toHaveText('Practise these words (2)');

      // the class's Vocab step: nothing in the session, so Practise is offered (no "Nothing from this class")
      await page.getByTestId('study-tutor-class').click();
      const study = page.getByTestId('tutor-study');
      const empty = study.getByTestId('tutor-vocab-empty');
      await expect(empty).toBeVisible();
      await expect(empty).not.toContainText('Nothing from this class');
      await empty.getByTestId('practise-words').click();
      await expect(page.getByTestId('practice-page').getByTestId('practice-counts')).toHaveText('2 left');
      await expect(page.getByTestId('review-card')).toHaveAttribute('data-face', 'meaning');
    });
  });
}
