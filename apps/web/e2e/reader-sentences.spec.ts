import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

declare global {
  interface Window {
    __anan: {
      db: {
        items: { bulkPut: (rows: unknown[]) => Promise<unknown> };
        evidence: {
          toArray: () => Promise<
            { kind: string; item: { id: string }; context?: { source: string; refId?: string } }[]
          >;
          clear: () => Promise<void>;
        };
        liveSentences: {
          bulkPut: (rows: unknown[]) => Promise<unknown>;
          count: () => Promise<number>;
        };
        readerShown: { count: () => Promise<number> };
        settings: { get: (k: string) => Promise<{ value: unknown } | undefined> };
      };
    };
  }
}

// Real lexicon ids (data/build/lexicon.v2.json).
const IDS = {
  我: 'tocfl-df8a004869',
  我們: '',
  去: 'tocfl-b2d9f51336',
  喜歡: 'tocfl-8cca6ed256',
  咖啡: 'tocfl-7c491838af',
  便利商店: 'supp-e58571bedc',
};

async function open(page: Page) {
  await page.goto('/?page=reader');
  await expect(page.getByText(/Lexicon v2/)).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => Boolean(window.__anan));
}

/** Known words (review state) plus ONE due word in `dueState`. */
async function seedLearner(
  page: Page,
  opts: { dueState?: 'review' | 'learning'; known?: string[] } = {},
) {
  const known = opts.known ?? [IDS.我, IDS.去, IDS.喜歡, IDS.咖啡];
  await page.evaluate(
    async ({ known, due, dueState }) => {
      const now = new Date();
      const past = new Date(now.getTime() - 86_400_000);
      const future = new Date(now.getTime() + 30 * 86_400_000);
      const card = (when: Date, state: number) => ({
        due: when,
        stability: 30,
        difficulty: 5,
        elapsed_days: 0,
        scheduled_days: 30,
        learning_steps: 0,
        reps: 3,
        lapses: 0,
        state,
        last_review: past,
      });
      const row = (id: string, when: Date, fsrsState: number, state: string) => ({
        pk: `word:${id}:recognition`,
        item: { kind: 'word', id },
        skill: 'recognition',
        card: card(when, fsrsState),
        state,
        lapses: 0,
        leech: false,
        leechTreatmentsTried: [],
        familiarity: 0,
        readingDependence: 0,
        flags: {},
        updatedAt: now,
      });
      await window.__anan.db.items.bulkPut([
        ...known.map((id) => row(id, future, 2, 'review')),
        row(due, past, dueState === 'learning' ? 1 : 2, dueState),
      ]);
    },
    { known, due: IDS.便利商店, dueState: opts.dueState ?? 'review' },
  );
}

const live = (id: string, zh: string, level = 'N1') => ({
  id,
  zh,
  en: `English for ${id}`,
  targetWordId: IDS.便利商店,
  level,
  tokens: [],
  source: 'generated-live',
  doubtful: false,
  createdAt: new Date(),
});
async function seedSentences(page: Page, rows: ReturnType<typeof live>[]) {
  await page.evaluate((r) => window.__anan.db.liveSentences.bulkPut(r), rows);
}

const sentenceText = (page: Page) => page.locator('.an-text').innerText();
const newButton = (page: Page) => page.getByRole('button', { name: /New sentence/ });
const evidence = (page: Page) => page.evaluate(() => window.__anan.db.evidence.toArray());

test.describe('Reader: New sentence (phase 9)', () => {
  test('starts on the sample text; the paste box is secondary but still works', async ({
    page,
  }) => {
    await open(page);
    await expect(page.locator('.an-token').first()).toBeVisible();
    await expect(page.getByTestId('reader-reason')).toContainText('Sample text');
    await expect(newButton(page)).toBeVisible();
    await page.getByLabel('Paste your own text').fill('我喜歡咖啡。');
    await expect(page.getByTestId('reader-reason')).toContainText('Your own text');
    await expect(page.locator('.an-text')).toContainText('咖');
  });

  test('twenty presses with the AI unavailable always show a sentence from the bank/own lines', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await open(page);
    await seedLearner(page);
    await seedSentences(page, [
      live('live-1', '我去便利商店。'),
      live('live-2', '我喜歡去便利商店。'),
      live('live-3', '我去便利商店喝咖啡。'),
    ]);

    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      await newButton(page).click();
      await expect(page.locator('.an-token').first()).toBeVisible();
      await expect(newButton(page)).toBeEnabled();
      // while the word is due, the line says what it is practising
      if (i < 2) await expect(page.getByTestId('reader-reason')).toContainText('便利商店');
      await expect(page.getByTestId('reader-reason')).not.toHaveText('');
      seen.push(await sentenceText(page));
    }
    // the first two presses are two different sentences (no repeat while a fresh one fits)
    expect(new Set(seen.slice(0, 2)).size).toBe(2);
    // every shown sentence is remembered for the 7-day rule; nothing outside the seeded bank appeared
    expect(await page.evaluate(() => window.__anan.db.readerShown.count())).toBeLessThanOrEqual(3);
    expect(await page.evaluate(() => window.__anan.db.liveSentences.count())).toBe(3);
    expect(errors).toEqual([]);
  });

  test('Back steps through earlier sentences in order; arrow keys work', async ({ page }) => {
    await open(page);
    await seedLearner(page);
    await seedSentences(page, [
      live('live-1', '我去便利商店。'),
      live('live-2', '我喜歡去便利商店。'),
      live('live-3', '我去便利商店喝咖啡。'),
    ]);
    const back = page.getByRole('button', { name: 'Previous sentence' });
    await expect(back).toBeDisabled();

    const shown: string[] = [];
    for (let i = 0; i < 3; i++) {
      await newButton(page).click();
      await expect(newButton(page)).toBeEnabled();
      shown.push(await sentenceText(page));
    }
    await back.click();
    expect(await sentenceText(page)).toBe(shown[1]);
    await back.click();
    expect(await sentenceText(page)).toBe(shown[0]);
    await page.keyboard.press('ArrowRight'); // → a NEW sentence, added after the ones already seen
    await expect(newButton(page)).toBeEnabled();
    await page.keyboard.press('ArrowLeft'); // ← back to the one seen just before it
    expect(await sentenceText(page)).toBe(shown[2]);
  });

  test('English is hidden by default; Show English counts as a lookup of the unknown words', async ({
    page,
  }) => {
    await open(page);
    await seedLearner(page, { dueState: 'learning' });
    await seedSentences(page, [live('live-1', '我去便利商店。')]);
    await newButton(page).click();
    await expect(page.getByTestId('reader-reason')).toContainText('便利商店');
    await expect(page.getByTestId('reader-english')).toHaveCount(0);
    await page.evaluate(() => window.__anan.db.evidence.clear());

    await page.getByRole('button', { name: 'Show English' }).click();
    await expect(page.getByTestId('reader-english')).toHaveText('English for live-1');
    await expect.poll(async () => (await evidence(page)).length).toBeGreaterThan(0);
    const rows = await evidence(page);
    expect(rows).toHaveLength(1); // 便利商店 only: 我 and 去 are already known
    expect(rows[0]).toMatchObject({
      kind: 'chat_lookup_gloss',
      item: { id: IDS.便利商店 },
      context: { source: 'reader', refId: 'live-1' },
    });
    // hiding and showing again does not count twice
    await page.getByRole('button', { name: 'Hide English' }).click();
    await page.getByRole('button', { name: 'Show English' }).click();
    expect(await evidence(page)).toHaveLength(1);
  });

  test('moving on without a lookup records chat_read_no_lookup; a tap records a lookup instead — both tagged reader', async ({
    page,
  }) => {
    await open(page);
    await seedLearner(page, { dueState: 'learning' });
    await seedSentences(page, [
      live('live-1', '我去便利商店。'),
      live('live-2', '我喜歡去便利商店。'),
    ]);
    await page.evaluate(() => window.__anan.db.evidence.clear());

    await newButton(page).click(); // sentence A
    await expect(page.getByTestId('reader-reason')).toContainText('便利商店');
    await newButton(page).click(); // leaving A with no lookup
    await expect
      .poll(async () => (await evidence(page)).map((e) => e.kind))
      .toContain('chat_read_no_lookup');
    let rows = await evidence(page);
    const noLookup = rows.find((e) => e.kind === 'chat_read_no_lookup')!;
    expect(noLookup.item.id).toBe(IDS.便利商店);
    expect(noLookup.context?.source).toBe('reader');

    // sentence B: tap the due word, then leave — a lookup, and NO no-lookup for B
    await page.evaluate(() => window.__anan.db.evidence.clear());
    await page.locator('.an-token', { hasText: '便' }).first().click();
    await expect
      .poll(async () => (await evidence(page)).map((e) => e.kind))
      .toContain('chat_lookup_gloss');
    await newButton(page).click();
    await page.waitForTimeout(300);
    rows = await evidence(page);
    expect(rows.every((e) => e.context?.source === 'reader')).toBe(true);
    expect(
      rows.filter((e) => e.kind === 'chat_read_no_lookup' && e.item.id === IDS.便利商店),
    ).toHaveLength(0);
  });

  test('the focus chip is remembered per profile across reloads', async ({ page }) => {
    await open(page);
    const chip = (name: string) => page.getByRole('radio', { name });
    await expect(chip('Mixed')).toHaveAttribute('aria-checked', 'true');
    await chip('Review').click();
    await expect(chip('Review')).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.__anan.db.settings.get('readerFocus'))?.value),
      )
      .toBe('review');
    await page.reload();
    await expect(page.getByText(/Lexicon v2/)).toBeVisible({ timeout: 15000 });
    await expect(chip('Review')).toHaveAttribute('aria-checked', 'true');
  });

  test('changing the level picker changes which sentences appear on the next press', async ({
    page,
  }) => {
    await open(page);
    await seedLearner(page);
    await seedSentences(page, [live('live-1', '我去便利商店。', 'L3')]);
    await page.getByLabel('My level').selectOption('N1');
    await newButton(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'No sentence found yet' })).toBeVisible(
      {
        timeout: 10000,
      },
    );

    await page.getByLabel('My level').selectOption('L3');
    await newButton(page).click();
    await expect(page.getByTestId('reader-reason')).toContainText('便利商店');
    await expect(page.getByText("Couldn't find a perfect match")).toHaveCount(0);
  });

  test('with nothing local, a live-generated sentence that passes validation is shown and saved to the bank', async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(() => void 0);
    // 我們 / 你 / 嗎 are used by the fake generator's sentences
    const lex = await (await page.request.get('/lexicon/lexicon.v2.json')).json();
    const idOf = (hw: string) =>
      lex.words.find((w: { headword: string }) => w.headword === hw).id as string;
    await seedLearner(page, {
      dueState: 'learning',
      known: [idOf('我們'), IDS.去, idOf('你'), IDS.喜歡, idOf('嗎')],
    });
    await page.getByLabel(/Use fake tutor for generated sentences/).check();
    expect(await page.evaluate(() => window.__anan.db.liveSentences.count())).toBe(0);

    await newButton(page).click();
    await expect(page.getByTestId('reader-reason')).toContainText('便利商店', { timeout: 10000 });
    await expect(page.getByText("Couldn't find a perfect match")).toHaveCount(0);
    await expect(page.locator('.reader-source')).toContainText('made for you');
    expect(await page.evaluate(() => window.__anan.db.liveSentences.count())).toBeGreaterThan(0);
  });

  test('a definition opened on the last line never covers the text or buttons below it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await open(page);
    const tokens = page.locator('.an-token');
    const below = [
      page.getByTestId('reader-reason'),
      page.getByRole('button', { name: 'Previous sentence' }),
      newButton(page),
    ];
    const tops = async () => Promise.all(below.map(async (l) => (await l.boundingBox())!.y));
    const before = await tops();

    // the very last word of the sample is on the bottom row
    await tokens.nth((await tokens.count()) - 3).click();
    const popover = page.locator('.an-popover');
    await expect(popover).toBeVisible();
    const pop = (await popover.boundingBox())!;
    const after = await tops();
    for (const top of after) expect(pop.y + pop.height).toBeLessThanOrEqual(top + 1);
    // the content moved down to make room, rather than being overlapped
    expect(after[0]).toBeGreaterThan(before[0]!);

    // expanding more of the definition keeps it clear too (the space is re-measured
    // when the popover grows, so give that a moment instead of reading mid-update)
    const others = page.locator('.an-popover-others summary');
    if (await others.count()) {
      await others.first().click();
      await expect
        .poll(async () => {
          const grown = (await popover.boundingBox())!;
          const tops = await Promise.all(below.map(async (l) => (await l.boundingBox())!.y));
          return Math.max(...tops.map((top) => grown.y + grown.height - top));
        })
        .toBeLessThanOrEqual(1);
    }

    // closing it gives the space back
    await page.locator('.an-popover-close').click();
    await expect(popover).toHaveCount(0);
    await expect.poll(tops).toEqual(before);
  });
});
