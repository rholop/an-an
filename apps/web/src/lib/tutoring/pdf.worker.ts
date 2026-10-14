// Phase 39: pdf.js's worker, bundled by Vite as a plain .js file. Served as the original .mjs file,
// it failed on the live site: nginx sends .mjs as application/octet-stream and browsers refuse to
// run a module script with that type.
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
