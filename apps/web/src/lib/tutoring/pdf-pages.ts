// Phase 39 Part A.1: a class summary PDF rendered to page images in the browser (pdf.js, loaded
// only on this screen). The PDF never leaves the device; only these images go to the proxy, once.
import type { TutorPageImage } from '@anan/core';

/** Pages past this are left out (a class summary is a few pages). */
export const MAX_PAGES = 12;
/** Render scale: big enough for small Chinese print, small enough for the free model. */
const SCALE = 1.6;

export async function pdfToPageImages(file: Blob): Promise<TutorPageImage[]> {
  // The legacy build: the modern one needs very new JS (Map.getOrInsertComputed) that Safari on
  // the owner's iPhones and current Chrome don't have yet.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Our own worker file (see pdf.worker.ts), started here and ended when the pages are done.
  const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
  const port = pdfjs.PDFWorker.create({ port: worker });
  const doc = await pdfjs
    .getDocument({ data: new Uint8Array(await file.arrayBuffer()), worker: port })
    .promise.catch((err: unknown) => {
      port.destroy();
      worker.terminate();
      throw err;
    });
  const pages: TutorPageImage[] = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('This browser cannot draw the PDF pages.');
      // a white page under the print (JPEG has no transparency), not a UI colour
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      pages.push({ mimeType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) });
      page.cleanup();
    }
  } finally {
    void doc.destroy().finally(() => {
      port.destroy();
      worker.terminate();
    });
  }
  return pages;
}
