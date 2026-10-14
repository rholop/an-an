import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures.js';

/**
 * Phase 39: upload a class summary PDF → check screen → Save → the class is under Tutoring with its
 * steps, at phone and laptop size, in both themes. The AI routes are faked with the recorded
 * extraction of the owner's PDF; the PDF here is a tiny stand-in (pdf.js still renders it).
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

const SCENARIO = {
  title: 'Ordering a late-night snack',
  setting: 'A small shop near your home, late in the evening',
  npcName: 'Carl',
  personality: 'friendly and patient',
  speechStyle: 'short, simple sentences',
  goalSteps: [{ description: 'Say what you want to eat', keywordHints: ['宵夜'] }],
  opener: { zh: '你好！你想吃什麼宵夜？', en: 'Hi! What late-night snack would you like?' },
  successLine: { zh: '好，我們明天見！', en: 'OK, see you tomorrow!' },
};

const SIZES = [
  { name: 'phone', viewport: { width: 390, height: 844 } },
  { name: 'laptop', viewport: { width: 1280, height: 800 } },
] as const;

for (const theme of ['light', 'dark'] as const) {
  for (const size of SIZES) {
    test(`tutoring: upload, check, Save, the class and its steps (${theme}, ${size.viewport.width}px)`, async ({ page }) => {
      test.setTimeout(90_000);
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(String(err)));
      await page.setViewportSize(size.viewport);
      await page.addInitScript((t) => localStorage.setItem('anan.theme', t), theme);
      const calls: string[] = [];
      await page.route('**/v1/tutor-extract', (route) => {
        calls.push('extract');
        const body = route.request().postDataJSON() as { pages: { mimeType: string; data: string }[] };
        // the page images, never the PDF
        expect(body.pages.length).toBe(1);
        expect(body.pages[0]!.mimeType).toBe('image/jpeg');
        return route.fulfill({ json: EXTRACTION });
      });
      await page.route('**/v1/tutor-check', (route) => {
        calls.push('check');
        const { sentences } = route.request().postDataJSON() as { sentences: { id: string }[] };
        return route.fulfill({ json: { results: sentences.map((s) => ({ id: s.id, ok: true })) } });
      });
      await page.route('**/v1/tutor-scenario', (route) => {
        calls.push('scenario');
        return route.fulfill({ json: SCENARIO });
      });

      await page.goto('/?page=tutoring');
      await expect(page.getByRole('heading', { name: 'Tutoring' })).toBeVisible({ timeout: 20_000 });
      await page.getByTestId('tutor-upload').setInputFiles({ name: 'summary.pdf', mimeType: 'application/pdf', buffer: tinyPdf() });

      // Part C: the check screen
      const check = page.getByTestId('tutor-check');
      await expect(check).toBeVisible({ timeout: 30_000 });
      await expect(check.getByRole('heading', { name: 'Carl · Tue 13 Oct' })).toBeVisible();
      await expect(check.getByTestId('tutor-word')).toHaveCount(20);
      await expect(check.getByTestId('tutor-grammar')).toHaveCount(8);
      const guoyu = check.getByTestId('tutor-word').filter({ hasText: '國語' });
      await expect(guoyu).toContainText('Mainland term');
      await expect(guoyu).toContainText('also said in mainland China');
      await expect(check.getByTestId('tutor-word').filter({ hasText: '義大利麵' })).toContainText('Not in the word list');
      await expect(check.getByTestId('tutor-grammar').filter({ hasText: '省略成分' })).toContainText('note only');
      expect(calls).toEqual(['extract', 'check']);
      // nothing is stored before Save
      expect(await page.evaluate(() => (window as unknown as { __anan: { db: { tutorSessions: { count: () => Promise<number> } } } }).__anan.db.tutorSessions.count())).toBe(0);
      if (size.viewport.width === 390) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      }

      await page.getByTestId('tutor-save').click();
      const classPage = page.getByTestId('tutor-class-page');
      await expect(classPage).toBeVisible({ timeout: 20_000 });
      expect(calls).toContain('scenario');
      await expect(classPage.getByRole('status')).toContainText('added to your reviews');
      await expect(classPage.getByTestId('tutor-class-progress')).toContainText('Learned');
      await expect(classPage.getByTestId('tutor-grammar-note')).toHaveCount(1);

      // the steps
      await page.getByTestId('study-tutor-class').click();
      const study = page.getByTestId('tutor-study');
      await expect(study).toContainText('Step 1 of');
      await expect(study).toContainText('Vocabulary review');
      await study.getByTestId('study-skip').click();
      await expect(study).toContainText('Grammar practice');
      // skip to the chat (the story step is there only when stories can be written)
      while (!(await study.locator('.textbook-study-bar').textContent())?.includes('Chat about the class'))
        await study.getByTestId('study-skip').click();
      // the class's own scenario, opened with its opener (shown with readings between the characters)
      await expect(study).toContainText('Ordering a late-night snack', { timeout: 20_000 });
      await expect(study).toContainText('Say what you want to eat');

      // the class is listed under Tutoring on the Textbook page
      await page.goto('/?page=textbook');
      const section = page.locator('#tutoring');
      await expect(section.getByTestId('tutor-class')).toHaveCount(1, { timeout: 20_000 });
      await expect(section.getByTestId('tutor-class')).toContainText('Carl · Tue 13 Oct');
      if (size.viewport.width === 390) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      }
      expect(errors).toEqual([]);
    });
  }
}

test('tutoring: a failed reading shows plain words, never the server reply', async ({ page }) => {
  await page.route('**/v1/tutor-extract', (route) =>
    route.fulfill({
      status: 502,
      json: { error: 'tutor_extract_failed', attempts: [{ model: 'gemini-2.5-flash', reason: 'bad_request' }] },
    }),
  );
  await page.goto('/?page=tutoring');
  await expect(page.getByRole('heading', { name: 'Tutoring' })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('tutor-upload').setInputFiles({ name: 'summary.pdf', mimeType: 'application/pdf', buffer: tinyPdf() });
  const error = page.getByTestId('tutor-upload-error');
  await expect(error).toContainText("Gemini couldn't read the class notes", { timeout: 30_000 });
  await expect(error).not.toContainText('tutor_extract_failed');
});
