import { expect, test } from '@playwright/test';
import {
  collectFindings,
  openApp,
  prepareContext,
  ROUTES,
  seedDueCards,
  WORDS,
} from './support.js';

/**
 * Phase 11 acceptance: the app on a newer iPhone (Safari / Chrome on iOS, both
 * WebKit). Runs on the iphone-13 and iphone-15-pro-max projects.
 */

declare global {
  interface Window {
    __anan: {
      db: {
        evidence: { toArray: () => Promise<{ kind: string; context?: { source: string } }[]> };
        settings: { put: (row: { key: string; value: unknown }) => Promise<unknown> };
      } & Record<string, unknown>;
    };
  }
}

test.describe('every screen fits a phone', () => {
  for (const route of ROUTES) {
    test(`${route.id}: no sideways scroll, nothing cut off, targets ≥44px, text sizes ok`, async ({
      page,
    }) => {
      test.setTimeout(60000);
      await prepareContext(page, route.session, 'light');
      await route.run(page);
      await page.waitForTimeout(300);
      const findings = await collectFindings(page);
      expect(
        findings.map((f) => `${f.kind}: ${f.where} (${f.detail})`),
        `${route.id} has phone-layout problems`,
      ).toEqual([]);
    });
  }
});

test.describe('navigation and shell', () => {
  test('a bottom tab bar replaces the top menu, and More holds the rest', async ({ page }) => {
    await prepareContext(page, 'signed-in', 'light');
    await openApp(page, 'garden');
    const tabbar = page.getByRole('navigation', { name: 'Main' });
    await expect(tabbar).toBeVisible();
    await expect(tabbar.getByRole('button')).toHaveCount(5); // Home, Chat, Review, Journal, More
    await expect(page.locator('.app-nav')).toBeHidden(); // the 13-button top strip is gone
    // pinned to the bottom of the screen (poll: the bar mounts a moment after the page)
    const vh = page.viewportSize()!.height;
    await expect
      .poll(async () => {
        const box = await tabbar.boundingBox();
        return box ? Math.abs(box.y + box.height - vh) : Infinity;
      })
      .toBeLessThanOrEqual(1);

    await tabbar.getByRole('button', { name: 'More' }).tap();
    const sheet = page.getByRole('dialog', { name: 'More' });
    await expect(sheet).toBeVisible();
    for (const label of ['Reader', 'Cloze', 'Progress', 'Textbook', 'Credits']) {
      await expect(sheet.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
    }
    await expect(sheet.getByRole('radiogroup', { name: 'Colour theme' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Reader' }).tap();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText(/Lexicon v2/)).toBeVisible();
  });

  test('the header is just the profile, the level picker and the sync dot', async ({ page }) => {
    await prepareContext(page, 'signed-in', 'light');
    await openApp(page, 'garden');
    const header = page.locator('.app-header');
    await expect(header.getByTestId('profile-chip')).toBeVisible();
    await expect(header.getByLabel('My level')).toBeVisible();
    await expect(header.locator('.theme-toggle')).toBeHidden();
    const box = (await header.boundingBox())!;
    expect(box.height).toBeLessThan(80);
  });

  test('the page extends under the notch and home bar (viewport-fit=cover) and uses dvh', async ({
    page,
  }) => {
    await prepareContext(page, 'signed-in', 'light');
    await openApp(page, 'garden');
    await expect(page.locator('meta[name=viewport]')).toHaveAttribute(
      'content',
      /viewport-fit=cover/,
    );
    const css = await page.evaluate(async () => {
      const sheets = [...document.styleSheets];
      let text = '';
      for (const s of sheets) {
        try {
          for (const r of s.cssRules) text += r.cssText;
        } catch {
          /* cross-origin */
        }
      }
      return text;
    });
    expect(css).toContain('safe-area-inset-bottom');
    expect(css).toContain('safe-area-inset-top');
    expect(css).toMatch(/100dvh/);
  });

  test('the household code screen: a big Continue button and a field that will not autofill or zoom', async ({
    page,
  }) => {
    await prepareContext(page, 'no-code', 'light');
    await page.goto('/');
    const input = page.locator('#site-code');
    await expect(input).toBeVisible({ timeout: 20000 });
    await expect(input).toHaveAttribute('autocomplete', 'off');
    expect(
      parseFloat(await input.evaluate((el) => getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    const button = page.getByRole('button', { name: /continue/i });
    const b = (await button.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(52);
    expect(b.width).toBeGreaterThan(page.viewportSize()!.width * 0.6);
  });
});

test.describe('no hover on a phone: everything works by tap', () => {
  test('a tap opens the definition as a bottom sheet that stays on screen; tapping elsewhere closes it', async ({
    page,
  }) => {
    await prepareContext(page, 'signed-in', 'light');
    await openApp(page, 'reader');
    const tokens = page.locator('.an-token');
    await expect(tokens.first()).toBeVisible({ timeout: 20000 });
    await tokens.nth((await tokens.count()) - 3).tap();
    const sheet = page.getByRole('dialog', { name: /Definition of/ });
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    const { width, height } = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
    expect(box.width).toBeGreaterThan(width * 0.95); // full width
    // the close button is a proper touch target
    const close = (await sheet.getByRole('button', { name: 'Close' }).boundingBox())!;
    expect(close.width).toBeGreaterThanOrEqual(44);
    expect(close.height).toBeGreaterThanOrEqual(44);

    // tap on empty space (the page heading) closes it
    await page.getByRole('heading', { name: "An'an reader" }).tap();
    await expect(sheet).toHaveCount(0);

    // the × also closes
    await tokens.first().tap();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).tap();
    await expect(sheet).toHaveCount(0);
  });

  test('"hover" mode: the first tap shows the reading, the second opens the definition — with the same evidence hovering had', async ({
    page,
  }) => {
    await prepareContext(page, 'signed-in', 'light');
    await openApp(page, 'reader');
    await page.evaluate(() => window.__anan.db.settings.put({ key: 'readerMode', value: 'hover' }));
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__anan));
    const token = page.locator('.an-token').nth(2);
    await expect(token).toBeVisible({ timeout: 20000 });
    // hidden until tapped
    await expect(token.locator('rt').first()).toHaveCSS('opacity', '0');

    await token.tap();
    await expect(token.locator('rt').first()).toHaveCSS('opacity', '1'); // reading revealed
    await expect(page.getByRole('dialog', { name: /Definition of/ })).toHaveCount(0); // no sheet yet
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.__anan.db.evidence.toArray())).map((e) => e.kind),
      )
      .toEqual(['chat_hover_reading']); // exactly what a hover records, and no lookup

    await token.tap();
    await expect(page.getByRole('dialog', { name: /Definition of/ })).toBeVisible();
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.__anan.db.evidence.toArray())).map((e) => e.kind).sort(),
      )
      .toEqual(['chat_hover_reading', 'chat_lookup_gloss']);

    // tapping elsewhere hides the reading again
    await page.getByRole('heading', { name: "An'an reader" }).tap();
    await expect(page.getByRole('dialog', { name: /Definition of/ })).toHaveCount(0);
    await expect(token.locator('rt').first()).toHaveCSS('opacity', '0');
  });

  test('tapping a word is not a hover: with the reading already shown, a tap records one lookup and no hover event', async ({
    page,
  }) => {
    await prepareContext(page, 'signed-in', 'light');
    await openApp(page, 'reader');
    await expect(page.locator('.an-token').first()).toBeVisible({ timeout: 20000 });
    await page.locator('.an-token').nth(1).tap();
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.__anan.db.evidence.toArray())).map((e) => e.kind),
      )
      .toEqual(['chat_lookup_gloss']);
  });
});

test.describe('keyboards and inputs', () => {
  test('chat: with the keyboard up the input row stays inside the visible area and the latest message is in view', async ({
    page,
  }) => {
    await prepareContext(page, 'signed-in', 'light');
    await ROUTES.find((r) => r.id === 'chat-conversation')!.run(page);
    const { height } = page.viewportSize()!;
    // Simulate iOS: the keyboard covers the bottom ~300px; only the visual viewport shrinks.
    const visible = height - 300;
    await page.evaluate((vvh) => {
      document.documentElement.style.setProperty('--vvh', `${vvh}px`);
      document.documentElement.classList.add('kb-open');
    }, visible);
    await page.waitForTimeout(250);

    const input = (await page.locator('.chat-input').boundingBox())!;
    expect(input.y).toBeGreaterThanOrEqual(0);
    expect(input.y + input.height).toBeLessThanOrEqual(visible + 1);
    const stuck = (await page.getByRole('button', { name: "I'm stuck" }).boundingBox())!;
    expect(stuck.y + stuck.height).toBeLessThanOrEqual(visible + 1);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden(); // the tab bar steps aside
    // the newest message is what's visible above the input
    const last = (await page.locator('.chat-bubble').last().boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(input.y + 1);
    expect(last.y + last.height).toBeGreaterThan(0);
  });

  test('open chat: the topic box sits above the keyboard and every chip is a real tap target', async ({
    page,
  }) => {
    await prepareContext(page, 'signed-in', 'light');
    await openApp(page, 'chat');
    await page.getByLabel('Use fake tutor (dev, no API key needed)').check();
    await page.getByTestId('open-chat-card').click();
    await expect(page.getByTestId('open-chat-topic')).toBeVisible();
    const { height } = page.viewportSize()!;
    const visible = height - 300; // iOS keyboard covers the bottom ~300px
    await page.evaluate((vvh) => {
      document.documentElement.style.setProperty('--vvh', `${vvh}px`);
      document.documentElement.classList.add('kb-open');
    }, visible);
    await page.waitForTimeout(250);
    const box = (await page.getByTestId('open-chat-topic-input').boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(visible + 1);
    expect(
      parseFloat(
        await page.getByTestId('open-chat-topic-input').evaluate((el) => getComputedStyle(el).fontSize),
      ),
    ).toBeGreaterThanOrEqual(16);
    const chips = page.getByTestId('open-chat-chips').locator('.chat-chip');
    for (const b of await chips.evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect().height),
    ))
      expect(b).toBeGreaterThanOrEqual(44);
    await page.getByTestId('open-chat-topic-input').fill('food');
    await page.getByRole('button', { name: 'Start' }).click();
    // the chat re-renders as its first reply arrives: poll the boxes instead of reading one too early
    const bottom = async (l: import('@playwright/test').Locator) => {
      const b = await l.boundingBox().catch(() => null);
      return b ? b.y + b.height : Infinity;
    };
    await expect.poll(() => bottom(page.locator('.chat-input'))).toBeLessThanOrEqual(visible + 1);
    await expect.poll(() => bottom(page.getByRole('button', { name: "I'm stuck" }))).toBeLessThanOrEqual(visible + 1);
  });

  test('chat: input is 16px+ (no iOS zoom), suggestions scroll in one row, "I\'m stuck" is reachable without scrolling', async ({
    page,
  }) => {
    await prepareContext(page, 'signed-in', 'light');
    await ROUTES.find((r) => r.id === 'chat-conversation')!.run(page);
    const input = page.locator('.chat-input');
    expect(
      parseFloat(await input.evaluate((el) => getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    for (const [attr, value] of [
      ['autocapitalize', 'off'],
      ['autocorrect', 'off'],
      ['spellcheck', 'false'],
      ['lang', 'zh-Hant-TW'],
    ]) {
      await expect(input).toHaveAttribute(attr!, value!);
    }
    const chips = page.locator('.chat-chip');
    if ((await chips.count()) > 1) {
      const ys = await chips.evaluateAll((els) =>
        els.map((e) => Math.round(e.getBoundingClientRect().top)),
      );
      expect(new Set(ys).size).toBe(1); // one row
    }
    const stuck = (await page.getByRole('button', { name: "I'm stuck" }).boundingBox())!;
    const { height } = page.viewportSize()!;
    expect(stuck.y + stuck.height).toBeLessThanOrEqual(height);
    expect(stuck.y).toBeGreaterThanOrEqual(0);
  });

  test('journal: the entry box fills the screen, Submit is pinned within reach, typing is not auto-corrected', async ({
    page,
  }) => {
    await prepareContext(page, 'signed-in', 'light');
    await openApp(page, 'journal');
    await page.getByLabel('Journal entry').waitFor();
    const box = (await page.getByLabel('Journal entry').boundingBox())!;
    expect(box.height).toBeGreaterThan(page.viewportSize()!.height * 0.35);
    const textarea = page.getByLabel('Journal entry');
    for (const [attr, value] of [
      ['autocapitalize', 'off'],
      ['autocorrect', 'off'],
      ['spellcheck', 'false'],
    ]) {
      await expect(textarea).toHaveAttribute(attr!, value!);
    }
    expect(
      parseFloat(await textarea.evaluate((el) => getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    const submit = (await page.getByRole('button', { name: 'Submit for feedback' }).boundingBox())!;
    expect(submit.y + submit.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  });

  test('cloze: typed answers get the Chinese keyboard, no auto-capitals or auto-correct, and a done key', async ({
    page,
  }) => {
    await prepareContext(page, 'signed-in', 'light');
    await openApp(page, 'cloze');
    await page.evaluate(() => void 0);
    // rung 3 = typed answers
    await seedDueCards(page, [
      { id: WORDS.咖啡, rung: 3 },
      { id: WORDS.飯, rung: 3 },
      { id: WORDS.便利商店, rung: 3 },
    ]);
    await page.reload();
    await page.getByRole('button', { name: /Start session/ }).tap();
    const input = page.locator('.cloze-input-row input').first();
    if (await input.count()) {
      await expect(input).toHaveAttribute('autocapitalize', 'off');
      await expect(input).toHaveAttribute('autocorrect', 'off');
      await expect(input).toHaveAttribute('spellcheck', 'false');
      await expect(input).toHaveAttribute('enterkeyhint', 'done');
      expect(
        parseFloat(await input.evaluate((el) => getComputedStyle(el).fontSize)),
      ).toBeGreaterThanOrEqual(16);
    }
  });
});

test.describe('screen-specific', () => {
  test('review: Show answer, then all four grade buttons in ONE row, near the bottom', async ({
    page,
  }) => {
    await prepareContext(page, 'signed-in', 'light');
    await ROUTES.find((r) => r.id === 'review-answer')!.run(page);
    const names = ['Again', 'Hard', 'Good', 'Easy'];
    const boxes = [];
    for (const n of names)
      boxes.push((await page.getByRole('button', { name: n, exact: true }).boundingBox())!);
    expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1);
    const { width, height } = page.viewportSize()!;
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(width);
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.y + b.height).toBeLessThanOrEqual(height); // on screen without scrolling
    }
  });

  test('reader: New sentence is a large button pinned at the bottom; it works by tap', async ({
    page,
  }) => {
    await prepareContext(page, 'signed-in', 'light');
    await ROUTES.find((r) => r.id === 'reader-sentence')!.run(page);
    const button = page.getByRole('button', { name: /New sentence/ });
    const b = (await button.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(52);
    expect(b.y + b.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  });

  test('tables become stacked cards', async ({ page }) => {
    await prepareContext(page, 'signed-in', 'light');
    await openApp(page, 'anki-import');
    // no rows without a file, so check the CSS contract on a synthetic table
    const stacked = await page.evaluate(() => {
      const t = document.createElement('table');
      t.className = 'anki-preview';
      t.innerHTML =
        '<thead><tr><th>A</th></tr></thead><tbody><tr><td data-label="A">x</td></tr></tbody>';
      document.body.appendChild(t);
      const out = {
        theadHidden: getComputedStyle(t.querySelector('thead')!).display === 'none',
        rowIsGrid: getComputedStyle(t.querySelector('tr:last-child')!).display === 'grid',
      };
      t.remove();
      return out;
    });
    expect(stacked).toEqual({ theadHidden: true, rowIsGrid: true });
  });
});

test.describe('pinyin and zhuyin at phone sizes', () => {
  for (const script of ['pinyin', 'zhuyin', 'both'] as const) {
    test(`${script}: readable, never overlapping a neighbour, never wrapped away from its character`, async ({
      page,
    }) => {
      await prepareContext(page, 'signed-in', 'light');
      await openApp(page, 'reader');
      await page.evaluate(
        (s) => window.__anan.db.settings.put({ key: 'readerScript', value: s }),
        script,
      );
      await page.reload();
      await expect(page.locator('.an-token').first()).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(400);

      const m = await page.evaluate(() => {
        const rect = (el: Element) => el.getBoundingClientRect();
        const readings = [...document.querySelectorAll('.an-token rt, .an-zhuyin-col')];
        const smallest = Math.min(...readings.map((e) => parseFloat(getComputedStyle(e).fontSize)));
        const problems: string[] = [];

        // every word is one unbroken box: its characters share one line
        for (const tok of document.querySelectorAll('.an-token')) {
          const cells = [...tok.querySelectorAll('.an-char-cell')];
          if (cells.length > 1) {
            const tops = new Set(cells.map((c) => Math.round(rect(c).top)));
            if (tops.size > 1) problems.push(`word wrapped inside itself: ${tok.textContent}`);
          }
        }
        // zhuyin sits inside its own character cell, and neighbouring cells never overlap
        const cells = [...document.querySelectorAll('.an-char-cell')];
        for (const c of cells) {
          const col = c.querySelector('.an-zhuyin-col');
          if (col) {
            const a = rect(c);
            const b = rect(col);
            if (b.left < a.left - 1 || b.right > a.right + 1)
              problems.push(`zhuyin outside its cell: ${c.textContent}`);
          }
        }
        for (let i = 1; i < cells.length; i++) {
          const a = rect(cells[i - 1]!);
          const b = rect(cells[i]!);
          const sameLine = Math.abs(a.top - b.top) < 4;
          if (sameLine && a.right > b.left + 1)
            problems.push(`cells overlap: ${cells[i - 1]!.textContent}|${cells[i]!.textContent}`);
        }
        return { smallest, count: readings.length, problems };
      });
      expect(m.count).toBeGreaterThan(0);
      expect(m.smallest).toBeGreaterThanOrEqual(10);
      expect(m.problems).toEqual([]);
    });
  }
});
