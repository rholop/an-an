import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 30 Part A: the app fits a small laptop. At 1280×650 and 1366×620 (a 13–14" laptop after
 * the browser's own bars) and 1440×780, in both themes: the header is one row, and every Review
 * face, Pinyin & tones, Cloze, Water all and the lesson Vocab and Grammar steps answer with no
 * vertical scroll and the answer buttons in view. The review card's Chinese is at least 44 px at
 * Normal. A phone (390×844) keeps its tab bar. With THEME_SCREENS=1 the 1280×650 screens are also
 * saved to docs/theme-screens/laptop/ for the owner to look at.
 */

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/theme-screens/laptop');
const SIZES = [
  { width: 1280, height: 650 },
  { width: 1366, height: 620 },
  { width: 1440, height: 780 },
] as const;
const THEMES = ['light', 'dark'] as const;

const IDS = {
  老師: 'tocfl-e6e5696c01',
  學生: 'tocfl-df11d6ee67',
  朋友: 'tocfl-79b6361089',
  喜歡: 'tocfl-8cca6ed256',
  電話: 'tocfl-c128a92442',
  咖啡: 'tocfl-7c491838af',
  手機: 'tocfl-8e37d8babc',
  學校: 'tocfl-d44d3a4900',
  可以: 'tocfl-76fa79162a',
  一起: 'tocfl-2d03bda470',
  吃: 'tocfl-29992340ae',
  喝: 'tocfl-3361e60084',
  茶: 'tocfl-4ff50dae17',
  水: 'tocfl-f3c1948845',
  書: 'tocfl-2580412342',
  買: 'tocfl-d9c66f870a',
};
const ALL = Object.values(IDS);
const DAY = 86_400_000;

type Row = { id: string; skill: string; dueIn: number; prodRung?: 'pick' | 'recall'; kind?: 'word' | 'grammar' };
type Handle = { db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } } };

/** Cards answered before (FSRS Review state); `dueIn` ms from now (negative = due now). */
async function seed(page: Page, rows: Row[]) {
  await page.evaluate(async (list) => {
    const now = Date.now();
    await (window as unknown as { __anan: Handle }).__anan.db.items.bulkPut(
      list.map(({ id, skill, dueIn, prodRung, kind }) => ({
        pk: `${kind ?? 'word'}:${id}:${skill}`,
        item: { kind: kind ?? 'word', id },
        skill,
        card: {
          due: new Date(now + dueIn),
          stability: 4,
          difficulty: 5,
          elapsed_days: 2,
          scheduled_days: 4,
          learning_steps: 0,
          reps: 3,
          lapses: 0,
          state: 2,
          last_review: new Date(now - 4 * 86_400_000),
        },
        ...(prodRung ? { prodRung, prodStreak: 0 } : {}),
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
      })),
    );
  }, rows);
}

async function open(page: Page, route: string) {
  await page.goto(`/?page=${route}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
}

/** Not scrolled while answering: the page is no taller than the window, and `buttons` are in view. */
async function expectFits(page: Page, what: string, buttons: Locator, shot: string) {
  await expect(buttons.first(), `${what}: answer buttons`).toBeVisible();
  // fonts and late layout settle first
  await page.evaluate(() => document.fonts.ready);
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollHeight,
    inner: window.innerHeight,
  }));
  expect(scroll, `${what}: page height ${scroll} > window ${inner}`).toBeLessThanOrEqual(inner);
  const box = (await buttons.last().boundingBox())!;
  expect(box.y + box.height, `${what}: buttons below the fold`).toBeLessThanOrEqual(inner);
  await save(page, shot);
}

/** With THEME_SCREENS=1, the 1280×650 screens (the smallest laptop) are saved for the owner. */
async function save(page: Page, shot: string) {
  if (!process.env.THEME_SCREENS || !shot.includes('1280x650')) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${shot}.png`) });
}

/** Runs `act`, then waits until `el` (a keyed card) has left the page: the next card is up. */
async function andNext(el: Locator, act: () => Promise<void>) {
  const handle = await el.elementHandle();
  await act();
  if (handle) await el.page().waitForFunction((node) => !node.isConnected, handle);
}

/** One grammar exercise answered (any type), as grammar-step.spec does. */
async function answerGrammar(ex: Locator) {
  const type = await ex.getAttribute('data-type');
  if (type === 'fill' || type === 'pick') await ex.getByTestId('grammar-option').first().click();
  else {
    const check = ex.getByTestId('grammar-check');
    while (await check.isDisabled()) await ex.locator('[data-testid="grammar-tile"]:not([disabled])').first().click();
    await check.click();
  }
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    const tag = `${size.width}x${size.height}-${theme}`;
    test.describe(`laptop ${tag}`, () => {
      test.use({ viewport: size, colorScheme: theme });
      test.beforeEach(async ({ context }) => {
        await context.addInitScript((t) => localStorage.setItem('anan.theme', t), theme);
      });

      test('the header is one 48 px row', async ({ page }) => {
        await open(page, 'garden');
        const bar = page.locator('.app-topbar');
        await expect(bar.getByTestId('profile-chip')).toBeVisible();
        const box = (await bar.boundingBox())!;
        expect(box.height).toBeLessThanOrEqual(48);
        const nav = page.getByRole('navigation', { name: 'Sections' });
        for (const el of [nav, page.getByTestId('profile-chip'), page.getByLabel('My level'), page.getByTestId('header-shortcuts-btn')]) {
          const b = (await el.boundingBox())!;
          expect(b.y).toBeGreaterThanOrEqual(box.y);
          expect(b.y + b.height).toBeLessThanOrEqual(box.y + box.height);
        }
        // Home, Review and Textbook are always in the bar
        for (const name of [/^Home/, /^Review/, /^Textbook/]) await expect(nav.getByRole('button', { name })).toBeVisible();
        await save(page, `home-${tag}`);
      });

      test('every Review face fits, and the Chinese on the card is at least 44 px', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page, 'review');
        const later = 30 * DAY;
        const now = -60_000;
        // one due card per face, each on its own word; every other card of those words is not due
        await seed(page, [
          ...ALL.flatMap((id) => [
            { id, skill: 'recognition', dueIn: later },
            { id, skill: 'production', dueIn: later },
            { id, skill: 'reading', dueIn: later },
          ]),
          { id: IDS.老師, skill: 'recognition', dueIn: now },
          { id: IDS.學生, skill: 'production', dueIn: now, prodRung: 'pick' },
          { id: IDS.朋友, skill: 'production', dueIn: now, prodRung: 'recall' },
          { id: IDS.喜歡, skill: 'reading', dueIn: now },
          { id: 'gram-ne-followup', skill: 'recognition', dueIn: now, kind: 'grammar' },
        ]);
        await open(page, 'review');
        const faces = new Set<string>();
        for (let step = 0; step < 12; step++) {
          const card = page.getByTestId('review-card');
          const done = page.getByTestId('review-done');
          await expect(card.or(done).first()).toBeVisible();
          if (await done.isVisible()) break;
          const face = (await card.getAttribute('data-face'))!;
          faces.add(face);
          if (face === 'grammar') {
            // one exercise from the lesson step's builders, inside the card
            const grammar = card.getByTestId('grammar-exercise');
            await expectFits(page, 'grammar front', grammar, `review-grammar-${tag}`);
            await answerGrammar(grammar);
            await expectFits(page, 'grammar answered', page.getByTestId('grammar-next'), `review-grammar-answered-${tag}`);
            await andNext(card, () => page.getByTestId('grammar-next').click());
            continue;
          }
          if (face === 'meaning' || face === 'say') {
            const front = card.locator('.review-card-front');
            const px = await front.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
            expect(px, `${face} front font size`).toBeGreaterThanOrEqual(44);
          }
          if (face === 'pick') {
            await expectFits(page, 'pick', page.getByTestId('review-pick-option'), `review-pick-${tag}`);
            await page.locator('[data-testid="review-pick-option"][data-right="true"]').click();
            const good = page.getByRole('button', { name: 'Good' });
            await expectFits(page, 'pick answered', good, `review-pick-answered-${tag}`);
            await andNext(card, () => good.click());
            continue;
          }
          const reveal = page.getByRole('button', { name: 'Show answer' });
          await expectFits(page, `${face} front`, reveal, `review-${face}-${tag}`);
          if (face === 'recall') await card.locator('.review-recall-input').fill('朋友');
          await reveal.click();
          const grades = page.locator('.review-buttons .review-btn');
          await expectFits(page, `${face} answer`, grades, `review-${face}-answer-${tag}`);
          await andNext(card, () => page.getByRole('button', { name: 'Good' }).click());
        }
        expect([...faces].sort()).toEqual(['grammar', 'meaning', 'pick', 'recall', 'say']);
      });

      test('Pinyin & tones exercises fit', async ({ page }) => {
        test.setTimeout(90_000);
        await open(page, 'garden');
        await seed(page, [
          ...ALL.map((id) => ({ id, skill: 'recognition', dueIn: 30 * DAY })),
          ...ALL.map((id) => ({ id, skill: 'reading', dueIn: -60_000 })),
        ]);
        await open(page, 'pinyin');
        const seen = new Set<string>();
        for (let step = 0; step < 40; step++) {
          const ex = page.getByTestId('pinyin-exercise');
          const summary = page.getByTestId('pinyin-summary');
          await expect(ex.or(summary).first()).toBeVisible();
          if (await summary.isVisible()) break;
          const kind = (await ex.getAttribute('data-kind'))!;
          const first = !seen.has(kind);
          seen.add(kind);
          if (first) await expectFits(page, `pinyin ${kind}`, ex, `pinyin-${kind}-${tag}`);
          if (kind === 'tones') {
            const syllables = ex.getByTestId('pinyin-syllable');
            for (let i = 0; i < (await syllables.count()); i++)
              await syllables.nth(i).locator('[data-testid="pinyin-tone"][data-right="true"]').click();
            await page.getByTestId('pinyin-check').click();
          } else if (kind === 'match') {
            const words = ex.getByTestId('pinyin-match-word');
            for (let i = 0; i < (await words.count()); i++) {
              const id = await words.nth(i).getAttribute('data-id');
              await words.nth(i).click();
              await ex.locator(`[data-testid="pinyin-match-reading"][data-id="${id}"]`).click();
            }
          } else if (kind === 'chars' || kind === 'lookalike') {
            await ex.locator('[data-testid="pinyin-pick-option"][data-right="true"]').click();
          } else if (kind === 'which') {
            await ex.locator('[data-testid="pinyin-which-option"][data-right="true"]').click();
          } else if (kind === 'sort') {
            const rows = ex.getByTestId('pinyin-sort-row');
            for (let i = 0; i < (await rows.count()); i++)
              await rows.nth(i).locator('[data-testid="pinyin-sort-pattern"][data-right="true"]').click();
            await page.getByTestId('pinyin-check').click();
          } else if (kind === 'type') {
            await ex.getByTestId('pinyin-type-input').fill('ma1');
            await page.getByTestId('pinyin-check').click();
          }
          if (first) await expectFits(page, `pinyin ${kind} answered`, page.getByTestId('pinyin-next'), `pinyin-${kind}-answered-${tag}`);
          await page.getByTestId('pinyin-next').click();
        }
        expect(seen.size).toBeGreaterThanOrEqual(4);
      });

      test('Cloze and Water all fit', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page, 'garden');
        const words = [IDS.老師, IDS.學生, IDS.朋友, IDS.喜歡];
        await seed(page, [
          ...words.flatMap((id) => [
            { id, skill: 'recognition', dueIn: -3_600_000 },
            { id, skill: 'production', dueIn: 30 * DAY },
            { id, skill: 'reading', dueIn: 30 * DAY },
          ]),
        ]);
        await open(page, 'cloze');
        await page.getByRole('button', { name: /Start session/ }).click();
        const chips = page.locator('.cloze-chip');
        await expectFits(page, 'cloze', chips, `cloze-${tag}`);
        await chips.first().click();
        const next = page.getByRole('button', { name: 'Next' });
        await expectFits(page, 'cloze answered', next, `cloze-answered-${tag}`);

        await open(page, 'garden');
        await page.getByTestId('water-all-btn').click();
        await expect(page.getByTestId('water-all')).toBeVisible();
        const reveal = page.getByRole('button', { name: 'Show answer' });
        const chip = page.locator('.cloze-chip');
        // a flashcard or a cloze comes first (wait until one is on screen, not mid-load)
        let flashcard: boolean | undefined;
        await expect
          .poll(async () => {
            flashcard = (await reveal.isVisible()) ? true : (await chip.first().isVisible()) ? false : undefined;
            return flashcard !== undefined;
          })
          .toBe(true);
        if (flashcard) {
          await expectFits(page, 'water all card', reveal, `water-all-${tag}`);
          await reveal.click();
          await expectFits(page, 'water all answer', page.locator('.review-buttons .review-btn'), `water-all-answer-${tag}`);
        } else {
          await expectFits(page, 'water all cloze', chip, `water-all-${tag}`);
        }
      });

      test('the lesson Vocab and Grammar steps fit', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page, 'textbook');
        await page.getByTestId('my-class-toggle').check();
        await page.getByTestId('my-class-lesson').selectOption('4');
        await page.getByTestId('lesson-4').getByRole('button').first().click();
        await page.getByTestId('study-lesson').click();
        // Vocab: new lesson words on review cards
        const reveal = page.getByRole('button', { name: 'Show answer' });
        await expectFits(page, 'lesson vocab', reveal, `lesson-vocab-${tag}`);
        await reveal.click();
        await expectFits(page, 'lesson vocab answer', page.locator('.review-buttons .review-btn'), `lesson-vocab-answer-${tag}`);
        await page.getByTestId('study-skip').click();
        // Grammar
        const ex = page.getByTestId('grammar-exercise');
        await expectFits(page, 'lesson grammar', ex, `lesson-grammar-${tag}`);
        await answerGrammar(ex);
        await expectFits(page, 'lesson grammar answered', page.getByTestId('grammar-next'), `lesson-grammar-answered-${tag}`);
      });
    });
  }
}

test.describe('Chinese text size', () => {
  test.use({ viewport: { width: 1280, height: 650 } });

  test('Settings → Chinese text size scales only the Chinese, and is saved with the profile', async ({ page }) => {
    await open(page, 'review');
    await seed(page, [
      { id: IDS.老師, skill: 'recognition', dueIn: -60_000 },
      { id: IDS.老師, skill: 'production', dueIn: 30 * DAY },
      { id: IDS.老師, skill: 'reading', dueIn: 30 * DAY },
    ]);
    await open(page, 'review');
    const front = page.locator('.review-card-front');
    const size = () => front.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const english = () => page.getByTestId('review-counts').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const normal = await size();
    const normalEnglish = await english();
    expect(normal).toBeGreaterThanOrEqual(44);

    await open(page, 'review-settings');
    await page.getByRole('radiogroup', { name: 'Chinese text size' }).getByLabel('Largest').check();
    await page.getByRole('button', { name: /^Review/ }).click();
    await expect.poll(size).toBeCloseTo(normal * 1.4, 0);
    expect(await english()).toBe(normalEnglish);

    // a profile setting (the synced settings table), so it survives a reload
    const stored = await page.evaluate(async () => {
      const db = (window as unknown as { __anan: { db: { settings: { get: (k: string) => Promise<{ value: unknown } | undefined> } } } }).__anan.db;
      return (await db.settings.get('zhTextSize'))?.value;
    });
    expect(stored).toBe('largest');
    await open(page, 'review');
    await expect.poll(size).toBeCloseTo(normal * 1.4, 0);
  });
});

test.describe('phone (unchanged)', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the bottom tab bar, not the top nav', async ({ page }) => {
    await open(page, 'garden');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.locator('.app-nav')).toBeHidden();
  });
});
