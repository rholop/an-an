import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { seedAnsweredWords } from './seed-answered-words.js';

/**
 * Phase 47 (owner, 2026-10-18: "cloze is now only sentence corrections from journal ... it keeps
 * asking me to replace english words but I haven't learned or mastered them yet"): outside the
 * review session Cloze practises answered words (word bank, multiple choice, typed), journal fixes
 * are at most 3 and never side by side, and a fix whose answer has an unlearned word waits.
 */

const FISH = 'tocfl-1efde723a6'; // 魚

type Db = {
  errorItems: { bulkPut: (rows: unknown[]) => Promise<unknown> };
  evidence: { toArray: () => Promise<Array<{ kind: string; context?: { practice?: boolean; source?: string } }>> };
};

async function seedFixes(page: Page) {
  await page.evaluate(() => {
    const card = { due: new Date(Date.now() - 60_000), stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0 };
    const base = { type: 'error', flagged: false, createdAt: new Date(), status: 'active', version: 2, original: '我想吃fish。', span: [3, 7], card };
    const fish = (i: number) => ({
      ...base,
      id: `p47:fish:${i}`,
      journalEntryId: `p47-${i}`,
      corrected: '我想吃魚。',
      blank: [3, 4],
      en: 'I want to eat fish.',
      exercise: { kind: 'cloze', prompt: 'Use the right word here.', blankStart: 3, blankEnd: 4, answer: '魚', accepted: ['魚'] },
    });
    return (window as unknown as { __anan: { db: Db } }).__anan.db.errorItems.bulkPut([
      ...[0, 1, 2, 3, 4].map(fish),
      {
        ...base,
        id: 'p47:dumplings',
        journalEntryId: 'p47-d',
        original: '我想吃dumplings。',
        span: [3, 12],
        corrected: '我想吃水餃。',
        blank: [3, 5],
        en: 'I want to eat dumplings.',
        exercise: { kind: 'cloze', prompt: 'Use the right word here.', blankStart: 3, blankEnd: 5, answer: '水餃', accepted: ['水餃'] },
      },
    ]);
  });
}

for (const [label, viewport] of [
  ['phone (390 px)', { width: 390, height: 844 }],
  ['laptop (1280 px)', { width: 1280, height: 800 }],
] as const) {
  test.describe(label, () => {
    test.use({ viewport });

    test('nothing in the review session: Cloze practises words, fixes ≤ 3 apart, 水餃 waits', async ({ page }) => {
      test.setTimeout(90_000);
      await page.goto('/?page=cloze');
      await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
      await seedAnsweredWords(page, 24, [FISH]);
      await seedFixes(page);
      await page.reload();

      const start = page.getByTestId('cloze-start');
      await expect(start).toHaveText(/^Practise \(\d+ words, [1-3] journal sentences?\)$/, { timeout: 20_000 });
      await expect(page.getByTestId('cloze-waiting-fixes')).toHaveText("1 journal fix is waiting for words you haven't learned yet");
      await start.click();

      // the session as built (a missed item's "Again" retry is added at the end)
      const total = Number(/of (\d+)/.exec(await page.getByTestId('cloze-counter').innerText())?.[1]);
      const kinds: ('word' | 'fix')[] = [];
      for (let step = 0; step < 80; step++) {
        if (await page.getByRole('heading', { name: 'Session complete' }).isVisible()) break;
        const fix = page.locator('.cloze-badge', { hasText: 'From your journal' });
        const prompt = page.locator('.cloze-sentence, .cloze-prompt, .error-exercise, [data-testid="cloze-practice"]').first();
        await expect(prompt).toBeVisible();
        if (await fix.isVisible()) {
          kinds.push('fix');
          await expect(page.getByText('我想吃水餃')).toHaveCount(0);
          const input = page.locator('.cloze-page input').first();
          if (await input.isVisible()) {
            await input.fill('魚');
            await page.keyboard.press('Enter');
          } else await page.locator('.cloze-page button', { hasText: '魚' }).first().click();
          await page.getByRole('button', { name: /^Next/ }).first().click();
          continue;
        }
        kinds.push('word');
        await expect(page.getByTestId('cloze-practice')).toBeVisible();
        const chip = page.locator('.cloze-chip').first();
        if (await chip.isVisible()) await chip.click();
        else {
          await page.locator('.cloze-exercise input').first().fill('字');
          await page.keyboard.press('Enter');
        }
        await page.getByRole('button', { name: /^Next/ }).first().click();
      }
      kinds.splice(total);
      expect(kinds[0]).toBe('word');
      expect(kinds.filter((k) => k === 'fix').length).toBeLessThanOrEqual(3);
      expect(kinds.filter((k) => k === 'word').length).toBeGreaterThan(kinds.length / 2);
      for (let i = 1; i < kinds.length; i++) expect(`${kinds[i - 1]}+${kinds[i]}`).not.toBe('fix+fix');

      // each card's first cloze answer of the day counted as a review (practice)
      const ev = (await page.evaluate(() => (window as unknown as { __anan: { db: Db } }).__anan.db.evidence.toArray())).filter((e) => e.context?.source === 'cloze');
      expect(ev.length).toBeGreaterThan(0);
      expect(ev.every((e) => e.context?.practice)).toBe(true);
      expect(ev.some((e) => e.kind.startsWith('review_'))).toBe(true);

      // the waiting fix is listed on Reported with its word and Add to review
      await page.getByRole('button', { name: 'Back' }).click();
      await page.getByTestId('cloze-waiting-fixes').getByRole('button').click();
      const waiting = page.getByTestId('waiting-fixes');
      await expect(waiting).toContainText('我想吃水餃。');
      await waiting.getByTestId('waiting-add').click();
      await expect(waiting).toContainText('Added to review');
    });

    test('fewer than 10 answered words and only journal fixes: no fixes-only session', async ({ page }) => {
      await page.goto('/?page=cloze');
      await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
      await seedAnsweredWords(page, 4, [FISH]);
      await seedFixes(page);
      await page.reload();
      await expect(page.getByTestId('cloze-few-words')).toHaveText('Learn a few words in Review first.', { timeout: 20_000 });
      await expect(page.getByTestId('cloze-start')).toHaveCount(0);
      await page.getByTestId('cloze-go-review').click();
      await expect(page).toHaveURL(/./);
      await expect(page.locator('.cloze-page')).toHaveCount(0);
    });
  });
}
