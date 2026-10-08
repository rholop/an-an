import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { eveningZone } from '../fixtures.js';

declare global {
  interface Window {
    __anan: {
      db: {
        items: { bulkPut: (rows: unknown[]) => Promise<unknown> };
        conversations: { add: (row: unknown) => Promise<number> };
        turns: { add: (row: unknown) => Promise<unknown> };
        liveSentences: { bulkPut: (rows: unknown[]) => Promise<unknown> };
      };
      learnerService: { record: (e: unknown, now: Date) => Promise<unknown> };
    };
  }
}

export type Theme = 'light' | 'dark';
export type Session = 'signed-in' | 'no-code' | 'no-profile';

export const WORDS = {
  我: 'tocfl-df8a004869',
  去: 'tocfl-b2d9f51336',
  喜歡: 'tocfl-8cca6ed256',
  咖啡: 'tocfl-7c491838af',
  吃: 'tocfl-29992340ae',
  喝: 'tocfl-3361e60084',
  飯: 'tocfl-752403db3c',
  便利商店: 'supp-e58571bedc',
};

/** localStorage state the app reads at start-up (same keys as e2e/fixtures.ts). */
export async function prepareContext(page: Page, session: Session, theme: Theme): Promise<void> {
  await page.context().addInitScript(
    ([s, t, zone]) => {
      const set = (k: string, v: string) => {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      };
      if (s !== 'no-code') set('anan.siteCode', 'tofu');
      if (s === 'signed-in') set('anan.profile', 'ron');
      set('anan.sync.disabled', '1');
      localStorage.setItem('anan.theme', t as string);
      // Phase 23: a zone where it is evening now, so the review session holds today's cards
      set('anan.sessions.defaultZone', zone as string);
    },
    [session, theme, eveningZone()],
  );
}

export async function openApp(page: Page, route: string): Promise<void> {
  await page.goto(`/?page=${route}`);
  await page.waitForFunction(() => Boolean(window.__anan), undefined, { timeout: 20000 });
}

/** SkillCard rows (recognition) due now, at the given cloze rungs. */
export async function seedDueCards(
  page: Page,
  cards: { id: string; rung?: number; state?: string; skill?: string }[],
): Promise<void> {
  await page.evaluate(async (list) => {
    const now = new Date();
    const past = new Date(now.getTime() - 3 * 86_400_000);
    await window.__anan.db.items.bulkPut(
      list.map(({ id, rung, state, skill }) => ({
        pk: `word:${id}:${skill ?? 'recognition'}`,
        item: { kind: 'word', id },
        skill: skill ?? 'recognition',
        card: {
          due: past,
          stability: 2,
          difficulty: 5,
          elapsed_days: 3,
          scheduled_days: 2,
          learning_steps: 0,
          reps: 2,
          lapses: 0,
          state: 2,
          last_review: new Date(past.getTime() - 2 * 86_400_000),
        },
        state: state ?? 'review',
        lapses: 0,
        leech: false,
        leechTreatmentsTried: [],
        clozeRung: rung ?? 1,
        clozeStreak: 0,
        familiarity: 0,
        readingDependence: 0,
        flags: {},
        updatedAt: now,
      })),
    );
  }, cards);
}

/** A past conversation, so chat-sourced cloze sentences exist. */
export async function seedChatHistory(
  page: Page,
  lines: { zh: string; en?: string }[],
): Promise<void> {
  await page.evaluate(async (ls) => {
    const at = new Date(Date.now() - 86_400_000);
    const conv = await window.__anan.db.conversations.add({
      scenarioId: 'tea-shop',
      npcId: 'clerk',
      startedAt: at,
      goalStepsDone: [],
      completed: false,
      stuckCount: 0,
      englishFallbackUsed: false,
    });
    for (const l of ls) {
      await window.__anan.db.turns.add({
        conversationId: conv,
        role: 'npc',
        zh: l.zh,
        en: l.en,
        at,
      });
    }
  }, lines);
}

/** Long-overdue words (garden wilting, journal prompt words). */
export async function seedOverdue(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(async (list) => {
    const long = new Date(Date.now() - 365 * 86_400_000);
    for (const id of list) {
      for (let i = 0; i < 2; i++) {
        await window.__anan.learnerService.record(
          { item: { kind: 'word', id }, skill: 'production', kind: 'review_good', at: long },
          new Date(long.getTime() + i * 86_400_000),
        );
      }
    }
  }, ids);
}

// ---------------------------------------------------------------------------
// Routes (one entry per screen/state the audit covers)
// ---------------------------------------------------------------------------

export interface RouteDef {
  id: string;
  session: Session;
  /** Screenshot at the phone's full pixel density (for judging small zhuyin / ruby text). */
  highRes?: boolean;
  /** Bring the screen into the state to audit. */
  run: (page: Page) => Promise<void>;
}

const heading = (page: Page, name: string | RegExp) =>
  expect(page.getByRole('heading', { name }).first()).toBeVisible({ timeout: 20000 });

export const ROUTES: RouteDef[] = [
  {
    id: 'household-code',
    session: 'no-code',
    run: async (page) => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: /continue/i })).toBeVisible({ timeout: 20000 });
    },
  },
  {
    id: 'who-are-you',
    session: 'no-profile',
    run: async (page) => {
      await page.goto('/');
      await expect(page.locator('.gate-big').first()).toBeVisible({ timeout: 20000 });
    },
  },
  {
    id: 'garden',
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'garden');
      await heading(page, 'Word garden');
      await seedOverdue(page, [WORDS.咖啡, WORDS.吃, WORDS.我, WORDS.便利商店, WORDS.喜歡]);
      await page.reload();
      await heading(page, 'Word garden');
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await page.locator('.garden-tile').first().waitFor();
    },
  },
  {
    id: 'reader',
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'reader');
      await expect(page.getByText(/Lexicon v2/)).toBeVisible({ timeout: 20000 });
      await expect(page.locator('.an-token').first()).toBeVisible();
    },
  },
  {
    id: 'reader-popover',
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'reader');
      await expect(page.locator('.an-token').first()).toBeVisible({ timeout: 20000 });
      const tokens = page.locator('.an-token');
      await tokens.nth((await tokens.count()) - 3).tap();
      await expect(page.locator('.an-popover, .an-sheet').first()).toBeVisible();
    },
  },
  {
    id: 'reader-sentence',
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'reader');
      await expect(page.locator('.an-token').first()).toBeVisible({ timeout: 20000 });
      await page.evaluate(() =>
        window.__anan.db.liveSentences.bulkPut([
          {
            id: 'live-m1',
            zh: '我今天想去便利商店喝咖啡，你要不要一起去？',
            en: 'I want to go to the convenience store for coffee today. Want to come?',
            targetWordId: 'supp-e58571bedc',
            level: 'N1',
            tokens: [],
            source: 'generated-live',
            doubtful: false,
            createdAt: new Date(),
          },
        ]),
      );
      await page.getByRole('button', { name: /New sentence/ }).tap();
      await page
        .getByRole('button', { name: /Show English|Finding/ })
        .first()
        .waitFor({ timeout: 15000 });
    },
  },
  ...(['zhuyin', 'both'] as const).map<RouteDef>((script) => ({
    id: `reader-${script}`,
    session: 'signed-in',
    highRes: true,
    run: async (page) => {
      await openApp(page, 'reader');
      await page.evaluate(
        (s) => window.__anan.db.settings.put({ key: 'readerScript', value: s }),
        script,
      );
      await page.reload();
      await expect(page.locator('.an-token').first()).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(400);
    },
  })),
  {
    id: 'chat-scenarios',
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'chat');
      await expect(page.locator('.chat-scenario-card').first()).toBeVisible({ timeout: 20000 });
    },
  },
  {
    id: 'chat-conversation',
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'chat');
      await page.getByLabel('Use fake tutor (dev, no API key needed)').check();
      await page.locator('.chat-scenario-card').first().click();
      await expect(page.locator('.chat-bubble--npc').first()).toBeVisible({ timeout: 20000 });
      await page.locator('.chat-input').fill('我要一杯珍珠奶茶');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.locator('.chat-bubble--npc').nth(1)).toBeVisible({ timeout: 20000 });
    },
  },
  {
    id: 'review-front',
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'review');
      await seedDueCards(page, [{ id: WORDS.咖啡 }, { id: WORDS.吃 }, { id: WORDS.喝 }]);
      await page.reload();
      await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible({
        timeout: 20000,
      });
    },
  },
  {
    id: 'review-answer',
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'review');
      await seedDueCards(page, [{ id: WORDS.咖啡 }, { id: WORDS.吃 }, { id: WORDS.喝 }]);
      await page.reload();
      await page.getByRole('button', { name: 'Show answer' }).tap();
      await expect(page.getByRole('button', { name: 'Good' })).toBeVisible();
    },
  },
  {
    id: 'cloze-start',
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'cloze');
      await seedDueCards(page, [{ id: WORDS.咖啡 }, { id: WORDS.飯 }]);
      await page.reload();
      await expect(page.getByRole('button', { name: /Start session/ })).toBeVisible({
        timeout: 20000,
      });
    },
  },
  ...[1, 2, 3].map<RouteDef>((rung) => ({
    id: `cloze-rung-${rung}`,
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'cloze');
      await seedChatHistory(page, [
        { zh: '我今天想喝咖啡。', en: 'I want coffee today.' },
        { zh: '你想吃飯嗎？', en: 'Do you want to eat?' },
        { zh: '我們去便利商店買東西。', en: 'We go to the shop.' },
      ]);
      await seedDueCards(page, [
        { id: WORDS.咖啡, rung },
        { id: WORDS.飯, rung },
        { id: WORDS.便利商店, rung },
      ]);
      await page.reload();
      await page.getByRole('button', { name: /Start session/ }).click();
      await expect(page.locator('.cloze-exercise, .cloze-page').first()).toBeVisible({
        timeout: 20000,
      });
      await expect(page.locator('.cloze-badge').first()).toBeVisible();
    },
  })),
  {
    id: 'journal-write',
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'journal');
      await page.getByLabel(/Use fake tutor/).check();
      await heading(page, 'Journal');
      await page.getByLabel('Journal entry').fill('今天我搭地鐵。我去 [gym]。');
    },
  },
  {
    id: 'journal-self-correct',
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'journal');
      await page.getByLabel(/Use fake tutor/).check();
      await page.getByLabel('Journal entry').fill('今天我搭地鐵。我去 [gym]。');
      await page.getByRole('button', { name: 'Submit for feedback' }).click();
      await expect(page.getByRole('heading', { name: 'Spot the mistakes' })).toBeVisible({
        timeout: 15000,
      });
    },
  },
  {
    id: 'journal-reveal',
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, 'journal');
      await page.getByLabel(/Use fake tutor/).check();
      await page.getByLabel('Journal entry').fill('今天我搭地鐵。我去 [gym]。');
      await page.getByRole('button', { name: 'Submit for feedback' }).click();
      await expect(page.getByRole('heading', { name: 'Spot the mistakes' })).toBeVisible({
        timeout: 15000,
      });
      await page.getByRole('button', { name: 'Show corrections' }).tap();
      await expect(page.getByRole('button', { name: 'Finish entry' })).toBeVisible();
    },
  },
  ...(
    [
      'progress',
      'pinyin',
      'textbook',
      'placement',
      'anki-import',
      'credits',
      'audio-review',
      'zhuyin-test',
    ] as const
  ).map<RouteDef>((route) => ({
    id: route,
    session: 'signed-in',
    run: async (page) => {
      await openApp(page, route);
      await page.waitForTimeout(1200);
      // some screens have no heading when their data is absent (audio review says
      // "No audio has been built yet", the textbook says its private text is missing)
      await expect(page.locator('.page-slot').getByText(/\S/).first()).toBeVisible({
        timeout: 20000,
      });
    },
  })),
];

// ---------------------------------------------------------------------------
// Checks run inside the page
// ---------------------------------------------------------------------------

export interface Finding {
  kind:
    | 'horizontal-scroll'
    | 'offscreen'
    | 'small-target'
    | 'small-chinese'
    | 'small-input'
    | 'small-reading';
  where: string;
  detail: string;
}

export const MIN_TARGET = 44;
export const MIN_CHINESE_PX = 20;
export const MIN_INPUT_PX = 16;
/** Pinyin / zhuyin annotations must stay legible. */
export const MIN_READING_PX = 10;

/** Everything the brief's acceptance criteria measure, for the screen as it is now. */
export async function collectFindings(page: Page): Promise<Finding[]> {
  return page.evaluate(
    ({ MIN_TARGET, MIN_CHINESE_PX, MIN_INPUT_PX, MIN_READING_PX }) => {
      // Repeated elements (every Chinese word, every tile) are reported once
      // with a count, not once each: group by tag + classes.
      const raw: { kind: string; sel: string; label: string; detail: string }[] = [];
      const add = (kind: string, d: { sel: string; label: string }, detail: string) => {
        raw.push({ kind, sel: d.sel, label: d.label, detail });
      };
      const describe = (el: Element): { sel: string; label: string } => {
        const e = el as HTMLElement;
        const cls = [...e.classList]
          .slice(0, 2)
          .map((c) => `.${c}`)
          .join('');
        const label =
          e.getAttribute('aria-label') ||
          (e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24) ||
          e.getAttribute('placeholder') ||
          '';
        return { sel: `${e.tagName.toLowerCase()}${cls}`, label };
      };
      const visible = (el: Element): boolean => {
        const e = el as HTMLElement;
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(e);
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        if (e.closest('[hidden], [aria-hidden="true"]')) return false;
        return true;
      };

      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth + 1)
        add(
          'horizontal-scroll',
          { sel: 'page', label: '' },
          `scrollWidth ${root.scrollWidth} > clientWidth ${root.clientWidth}`,
        );

      // elements poking outside the screen (not inside their own horizontal scroller)
      const vw = window.innerWidth;
      for (const el of document.querySelectorAll('body *')) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.right <= vw + 1 && r.left >= -1) continue;
        let scrolled = false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') {
            scrolled = true;
            break;
          }
        }
        if (!scrolled)
          add('offscreen', describe(el), `x ${Math.round(r.left)}–${Math.round(r.right)} of ${vw}`);
      }

      // tap targets
      const targets = document.querySelectorAll(
        'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=radio], [role=tab], [role=menuitem], .an-token',
      );
      for (const el of targets) {
        const e = el as HTMLButtonElement;
        if (!visible(el) || e.disabled) continue;
        if (el.matches('input[type=checkbox][readonly], input[readonly][type=checkbox]')) continue;
        // a checkbox / radio is tapped through its label: that is the hit area
        const isToggle = el.matches('input[type=checkbox], input[type=radio]');
        const hit =
          (isToggle &&
            (el.closest('label') ??
              (e.id ? document.querySelector(`label[for="${e.id}"]`) : null))) ||
          el;
        const r = hit.getBoundingClientRect();
        if (r.width < MIN_TARGET - 0.5 || r.height < MIN_TARGET - 0.5)
          add('small-target', describe(el), `${Math.round(r.width)}×${Math.round(r.height)}px`);
      }

      // Chinese text size (ignore ruby annotations)
      const han = /[一-鿿]/;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? '';
        const parent = n.parentElement;
        if (!parent || !han.test(text) || !visible(parent) || parent.closest('rt, script, style'))
          continue;
        const px = parseFloat(getComputedStyle(parent).fontSize);
        // Chinese body text: 20px. A Chinese word inside an English sentence just
        // has to match the 16px body text around it.
        const letters = text.replace(/[\s\d\p{P}]/gu, '');
        const mostlyChinese = [...letters].filter((c) => han.test(c)).length >= letters.length / 2;
        if (px < (mostlyChinese ? MIN_CHINESE_PX : 16))
          add('small-chinese', describe(parent), `${px}px`);
      }

      // pinyin / zhuyin annotations
      for (const el of document.querySelectorAll('.an-token rt, .an-zhuyin-col')) {
        if (!visible(el)) continue;
        const px = parseFloat(getComputedStyle(el).fontSize);
        if (px < MIN_READING_PX) add('small-reading', describe(el), `${px}px`);
      }

      // iOS zooms the page when a focused field is under 16px
      for (const el of document.querySelectorAll(
        'input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select',
      )) {
        if (!visible(el)) continue;
        const px = parseFloat(getComputedStyle(el).fontSize);
        if (px < MIN_INPUT_PX) add('small-input', describe(el), `${px}px`);
      }
      const groups = new Map<string, typeof raw>();
      for (const r of raw) {
        const key = `${r.kind}|${r.sel}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      const out: { kind: string; where: string; detail: string }[] = [];
      for (const list of groups.values()) {
        const first = list[0]!;
        if (list.length <= 2) {
          for (const r of list)
            out.push({
              kind: r.kind,
              where: r.label ? `${r.sel} “${r.label}”` : r.sel,
              detail: r.detail,
            });
        } else {
          out.push({
            kind: first.kind,
            where: `${first.sel} (×${list.length})`,
            detail: first.detail,
          });
        }
      }
      return out;
    },
    { MIN_TARGET, MIN_CHINESE_PX, MIN_INPUT_PX, MIN_READING_PX },
  ) as Promise<Finding[]>;
}
