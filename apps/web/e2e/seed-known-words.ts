import type { Page } from '@playwright/test';
import { expect } from './fixtures.js';

type Handle = { learnerService: { recordBulk: (events: unknown[], now: Date) => Promise<unknown> } };
const handle = (page: Page) => page.evaluate(() => Boolean((window as unknown as { __anan?: Handle }).__anan));

/** 150 N1 words as Anki-seen: the learner's rung 1, so a story can be made of them. */
export async function seedKnownWords(page: Page) {
  await page.goto('/?page=garden');
  await expect.poll(() => handle(page), { timeout: 20_000 }).toBe(true);
  await page.evaluate(async () => {
    const data = (await (await fetch('/lexicon/lexicon.v2.json')).json()) as {
      words: { id: string; level: string | null; tags: string[] }[];
    };
    const now = new Date();
    const events = data.words
      .filter((w) => w.level === 'N1' && !w.tags.includes('name'))
      .slice(0, 150)
      .map((w) => ({ item: { kind: 'word', id: w.id }, skill: 'recognition', kind: 'anki_import_seen', at: now }));
    await (window as unknown as { __anan: Handle }).__anan.learnerService.recordBulk(events, now);
  });
}

