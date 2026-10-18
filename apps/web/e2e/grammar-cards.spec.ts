import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 46: grammar cards never give the answer away. Before a choice is made, the pattern is masked
 * (no part that is a choice or in the answer) and only its English meaning shows; the explanation,
 * the class notes and the example come after. Every matched class point can be practised (剛剛 from
 * the class's own example). The tutoring Grammar step and a Review grammar card, at phone and laptop
 * size, in both themes.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTION = JSON.parse(
  readFileSync(path.join(here, '../../../packages/core/src/test-fixtures/tutor-italki-2026-10-13.extraction.json'), 'utf8'),
) as unknown;

/** A one-page PDF ("AI Lesson summary"), built with correct xref offsets. */
function tinyPdf(): Buffer {
  const text = 'BT /F1 18 Tf 20 100 Td (AI Lesson summary) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const SIZES = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

const SIMPLIFIED_ONLY = /[们这说饭刚还动词没时语间点么后从厕吗]/;

async function noOverflow(page: Page, width: number) {
  if (width !== 390) return;
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * Answers one grammar exercise (the first choice, or tiles in order) and returns what was on screen
 * before the answer and the answer itself (a fill's right option; else the sentence).
 */
async function answer(ex: Locator): Promise<{ before: string; answer: string; type: string }> {
  const type = (await ex.getAttribute('data-type')) ?? '';
  const prompt = ex.getByTestId('grammar-prompt');
  await expect(prompt).toHaveAttribute('data-answered', 'no');
  const before = (await prompt.textContent()) ?? '';
  await expect(ex.getByTestId('grammar-after')).toHaveCount(0);
  if (type === 'fill' || type === 'pick') await ex.getByTestId('grammar-option').first().click();
  else {
    const check = ex.getByTestId('grammar-check');
    while (await check.isDisabled()) await ex.locator('[data-testid="grammar-tile"]:not([disabled])').first().click();
    await check.click();
  }
  await expect(prompt).toHaveAttribute('data-answered', 'yes');
  await expect(ex.getByTestId('grammar-after')).toBeVisible();
  const right = type === 'fill' ? ((await ex.locator('[data-testid="grammar-option"].is-right').textContent()) ?? '') : '';
  return { before, answer: right, type };
}

for (const theme of ['light', 'dark'] as const) {
  for (const size of SIZES) {
    test(`Phase 46: the tutoring Grammar step hides the answer and every point can be practised (${theme}, ${size.width}px)`, async ({ page }) => {
      test.setTimeout(120_000);
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(String(err)));
      await page.setViewportSize(size);
      await page.addInitScript((t) => localStorage.setItem('anan.theme', t), theme);
      await page.route('**/v1/tutor-extract', (route) => route.fulfill({ json: EXTRACTION }));
      await page.route('**/v1/tutor-check', (route) => {
        const { sentences } = route.request().postDataJSON() as { sentences: { id: string }[] };
        return route.fulfill({ json: { results: sentences.map((s) => ({ id: s.id, ok: true })) } });
      });
      await page.route('**/v1/tutor-scenario', (route) => route.fulfill({ status: 503, json: { error: 'quota_exhausted' } }));
      await page.route('**/v1/tutor-classify', (route) => route.fulfill({ json: { words: [], topics: [] } }));
      await page.route('**/v1/tutor-grammar-practice', (route) => route.fulfill({ json: { sentences: [] } }));
      await page.route('**/v1/tutor-audio**', (route) => route.fulfill({ status: 503, json: { error: 'speech_not_configured' } }));

      await page.goto('/?page=tutoring');
      await expect(page.getByRole('heading', { name: 'Tutoring' })).toBeVisible({ timeout: 20_000 });
      await page.getByTestId('tutor-upload').setInputFiles({ name: 'summary.pdf', mimeType: 'application/pdf', buffer: tinyPdf() });
      const check = page.getByTestId('tutor-check');
      await expect(check).toBeVisible({ timeout: 30_000 });
      // Part C: the check screen's grammar is all traditional
      expect(await check.locator('.tutoring-grammar').textContent()).not.toMatch(SIMPLIFIED_ONLY);
      // Part D: 可以 vs 能 shows both items
      await expect(check.getByTestId('tutor-grammar').filter({ hasText: '可以 vs 能不能' })).toContainText('S + 可以 + V (O), S + (Adv) + 能 + V (O)');
      await page.getByTestId('tutor-save').click();
      const classPage = page.getByTestId('tutor-class-page');
      await expect(classPage).toBeVisible({ timeout: 20_000 });
      // Part D.3/D.4: the heading's own explanation, the class's notes under it, and "Matched to"
      const neng = classPage.getByTestId('tutor-grammar-point').filter({ hasText: 'S + (Adv) + 能 + V (O)' });
      await expect(neng).toContainText('S + 可以 + V (O)');
      await expect(neng.getByTestId('tutor-class-notes')).toContainText('Your class notes said:');
      await expect(neng.getByTestId('tutor-grammar-match')).toContainText('Matched to:');
      expect(await classPage.textContent()).not.toMatch(SIMPLIFIED_ONLY);
      await noOverflow(page, size.width);

      await page.getByTestId('study-tutor-class').click();
      const study = page.getByTestId('tutor-study');
      await study.getByTestId('study-skip').click();
      await expect(study).toContainText('Grammar practice');
      const step = study.getByTestId('tutor-grammar-step');
      // every matched point: an exercise (never "No practice yet"), nothing answer-revealing before the choice
      await expect(step.getByTestId('grammar-exercise')).toBeVisible({ timeout: 20_000 });
      // 剛剛, 還沒, time-place order, 的時候, 跟…一起, 可以, 能, 什麼 (省略成分 is a note)
      await expect(step.getByTestId('grammar-prompt')).toContainText('1 of 8');
      for (let k = 1; k <= 8; k++) {
        const ex = step.getByTestId('grammar-exercise');
        await expect(ex.getByTestId('grammar-prompt')).toContainText(`${k} of 8`, { timeout: 20_000 });
        await expect(step.getByTestId('tutor-grammar-no-practice')).toHaveCount(0);
        const grammar = await ex.getAttribute('data-grammar');
        await expect(ex.getByTestId('tutor-class-notes')).toHaveCount(0);
        const got = await answer(ex);
        if (got.answer) expect(got.before, `${grammar}: the answer ${got.answer} before the choice`).not.toContain(got.answer);
        if (grammar === 'gram-hai-still') expect(got.before).not.toContain('還');
        if (grammar === 'gram-ganggang-just') {
          // one of the class's own sentences (its example 我剛剛在吃飯, or its 剛剛 word example)
          expect(await ex.getAttribute('data-sentence')).toMatch(/^tutor-/);
          if (got.type === 'fill') expect(got.answer).toBe('剛剛');
        }
        await expect(ex.getByTestId('grammar-pattern')).toHaveAttribute('data-masked', 'no');
        await expect(ex.getByTestId('tutor-class-notes')).toContainText('Your class notes said:');
        await noOverflow(page, size.width);
        await ex.getByTestId('grammar-next').click();
      }
      await expect(step).toContainText('Notes from the class');
      expect(errors).toEqual([]);
    });

    test(`Phase 46: a Review grammar card shows "S + ＿＿ + someone + 一起 + V (O)" and never 跟 before the answer (${theme}, ${size.width}px)`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.addInitScript((t) => localStorage.setItem('anan.theme', t), theme);
      await page.goto('/?page=review');
      await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
      await page.evaluate(async () => {
        const now = Date.now();
        const db = (window as unknown as { __anan: { db: { items: { put: (r: unknown) => Promise<unknown> }; evidence: { add: (r: unknown) => Promise<unknown> } } } })
          .__anan.db;
        await db.evidence.add({ item: { kind: 'word', id: 'done-0' }, skill: 'recognition', kind: 'review_good', at: new Date(now - 60_000), uid: 'seed-done-0' });
        await db.items.put({
          pk: 'grammar:gram-gen-yiqi:recognition',
          item: { kind: 'grammar', id: 'gram-gen-yiqi' },
          skill: 'recognition',
          card: { due: new Date(now - 60_000), stability: 4, difficulty: 5, elapsed_days: 2, scheduled_days: 4, learning_steps: 0, reps: 3, lapses: 0, state: 2, last_review: new Date(now - 4 * 86_400_000) },
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
        });
      });
      await page.goto('/?page=review');
      const card = page.getByTestId('review-card');
      const ex = card.getByTestId('grammar-exercise');
      await expect(ex).toBeVisible({ timeout: 20_000 });
      await expect(ex).toHaveAttribute('data-grammar', 'gram-gen-yiqi');
      const front = (await card.textContent()) ?? '';
      expect(front).not.toContain('S + 跟 + someone');
      if ((await ex.getAttribute('data-type')) === 'fill') {
        await expect(ex.getByTestId('grammar-pattern')).toHaveText('S + ＿＿ + someone + 一起 + V (O)');
        await expect(ex.getByTestId('grammar-meaning')).toContainText('together with');
        expect(await ex.getByTestId('grammar-prompt').textContent()).not.toContain('跟');
      }
      await noOverflow(page, size.width);
      const got = await answer(ex);
      if (got.answer) expect(got.before).not.toContain(got.answer);
      await expect(ex.getByTestId('grammar-pattern')).toContainText('S + 跟 + someone + 一起 + V (O)');
      await expect(ex.getByTestId('grammar-after')).toContainText('together with');
      await noOverflow(page, size.width);
    });
  }
}
