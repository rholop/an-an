import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 48 Part D.3: the owner's two Pick the Mandarin cards. A beginner who has just learned
 * Lesson 4's jobs (廚師, 醫師, 老師) and the days of the week (星期四 / 五 / 日) used to get
 * "usually, normally" → 平常 / 廚師 / 醫師 / 老師 and "ice cream" → 冰淇淋 / 星期五 / 星期四 / 星期日:
 * the answer was the odd one out. Now every option is close to the answer and the wrong ones
 * never share something the answer lacks.
 */

type AnanHandle = { db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } } };

const IDS = {
  平常: 'tocfl-39b867df96',
  冰淇淋: 'tocfl-0a27974d06',
  廚師: 'tocfl-662cb8d8a4',
  醫師: 'tocfl-7fdc33a1ea',
  老師: 'tocfl-e6e5696c01',
  星期四: 'tb-2750a4f013',
  星期五: 'tb-84b4437aca',
  星期日: 'tocfl-5c3db186b7',
};

async function seed(page: Page, rows: { id: string; skill: string; dueIn: number }[]) {
  await page.evaluate(async (list) => {
    const now = Date.now();
    await (window as unknown as { __anan: AnanHandle }).__anan.db.items.bulkPut(
      list.map(({ id, skill, dueIn }) => ({
        pk: `word:${id}:${skill}`,
        item: { kind: 'word', id },
        skill,
        card: {
          due: new Date(now + dueIn),
          stability: 2,
          difficulty: 5,
          elapsed_days: 2,
          scheduled_days: 4,
          learning_steps: 0,
          reps: 3,
          lapses: 0,
          state: 2,
          last_review: new Date(now - 4 * 86_400_000),
        },
        state: 'review',
        lapses: 0,
        leech: false,
        leechTreatmentsTried: [],
        familiarity: 0,
        readingDependence: 0,
        flags: {},
        updatedAt: new Date(now),
      })),
    );
  }, rows);
}

async function open(page: Page, route: string) {
  await page.goto(`/?page=${route}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
}

/** What the wrong options all share that the answer lacks (a character in the same place from the
 * start or the end), or undefined. The category half of the rule is covered by unit tests. */
function sharedTell(answer: string, wrong: string[]): string | undefined {
  if (wrong.length < 2) return undefined;
  const a = [...answer];
  const ws = wrong.map((x) => [...x]);
  for (const fromEnd of [false, true]) {
    const at = (cs: string[], i: number) => (fromEnd ? cs[cs.length - 1 - i] : cs[i]);
    for (let i = 0; i < ws[0]!.length; i++) {
      const ch = at(ws[0]!, i);
      if (ws.every((cs) => at(cs, i) === ch) && at(a, i) !== ch) return ch;
    }
  }
  return undefined;
}

test('Pick the Mandarin: 平常 and 冰淇淋 get fair options, never the odd one out', async ({ page }) => {
  await open(page, 'review');
  const later = 30 * 86_400_000;
  // the two production cards due now; the jobs and days known (answered, not due)
  await seed(page, [
    { id: IDS.平常, skill: 'recognition', dueIn: later },
    { id: IDS.平常, skill: 'production', dueIn: -60_000 },
    { id: IDS.冰淇淋, skill: 'recognition', dueIn: later },
    { id: IDS.冰淇淋, skill: 'production', dueIn: -60_000 },
    ...[IDS.廚師, IDS.醫師, IDS.老師, IDS.星期四, IDS.星期五, IDS.星期日].flatMap((id) => [
      { id, skill: 'recognition', dueIn: later },
      { id, skill: 'production', dueIn: later },
    ]),
    ...Object.values(IDS).map((id) => ({ id, skill: 'reading', dueIn: later })),
  ]);
  await open(page, 'review');
  const card = page.getByTestId('review-card');
  const seen = new Set<string>();
  for (let n = 0; n < 2; n++) {
    await expect(card).toHaveAttribute('data-face', 'pick');
    const right = page.locator('[data-testid="review-pick-option"][data-right="true"] .review-pick-zh');
    await expect(right).toHaveCount(1);
    // wait for the next card (the one just answered leaves first)
    await expect.poll(async () => seen.has((await right.innerText()).trim())).toBe(false);
    const answer = (await right.innerText()).trim();
    const all = (await page.locator('[data-testid="review-pick-option"] .review-pick-zh').allInnerTexts()).map((t) => t.trim());
    const wrong = all.filter((t) => t !== answer);
    seen.add(answer);
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.length).toBeLessThanOrEqual(4);
    expect(new Set(all.map((t) => [...t].length)).size).toBe(1);
    expect(sharedTell(answer, wrong), `${answer}: ${wrong.join(' / ')}`).toBeUndefined();
    if (answer === '平常') expect(wrong.filter((t) => t.endsWith('師')).length).toBeLessThan(2);
    if (answer === '冰淇淋') expect(wrong.filter((t) => t.startsWith('星期')).length).toBeLessThan(2);
    await page.locator('[data-testid="review-pick-option"][data-right="true"]').click();
    await page.getByRole('button', { name: 'Good' }).click();
  }
  expect([...seen].sort()).toEqual(['冰淇淋', '平常'].sort());
});
