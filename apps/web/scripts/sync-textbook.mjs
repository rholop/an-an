// Copies the textbook structure (book.json: lessons, word ids, grammar,
// prompts) and the generated lesson sentences into public/textbook/. These
// carry NO text from the book itself — dialogues and the book's own example
// sentences stay in data/curriculum/*/private and are served only by the proxy
// behind the household code.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const BOOKS = ['laixue-1'];

for (const id of BOOKS) {
  const src = path.join(REPO_ROOT, 'data/curriculum', id, 'book.json');
  const sentences = path.join(REPO_ROOT, 'data/build', `sentences.textbook-${id}.json`);
  if (!existsSync(src)) {
    console.log(
      `sync-textbook: ${src} doesn't exist yet (run "pnpm curriculum:import ${id}") — skipping.`,
    );
    continue;
  }
  const dest = path.join(__dirname, '../public/textbook', id);
  mkdirSync(dest, { recursive: true });
  copyFileSync(src, path.join(dest, 'book.json'));
  if (existsSync(sentences)) copyFileSync(sentences, path.join(dest, 'sentences.json'));
  console.log(`sync-textbook: copied ${id} to ${dest}`);
}
