/**
 * Phase 34 B: `pnpm curriculum:extras <bookId | --all>` — scan every lesson's full page range
 * for vocabulary outside the four parsed sections (labelled boxes, word banks, tables) and
 * propose it in `data/curriculum/<book>/extras.yaml`. Writes `extras-report.md` too.
 *
 * Re-runs keep the owner's edits (`status: keep|drop`, hand-added lines) and only add new
 * candidates. Pages whose labels are pictures are listed in the report; Claude Code reads
 * those as images and adds the words with `found: image`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TextbookFile } from '@anan/core';
import {
  BOOK_ORDER,
  configuredBooks,
  loadBookConfig,
  loadLinkLexicon,
  loadPages,
  REPO_ROOT,
} from './curriculum-import.js';
import { bareLabels, printedPage, scanPage } from './lib/curriculum/extras-scan.js';
import { activeExtras, loadExtras, mergeExtras, saveExtras, type ExtraEntry } from './lib/curriculum/extras-file.js';
import type { RawCandidate } from './lib/curriculum/extras-scan.js';
import { linkBookWord } from './lib/curriculum/link.js';

interface BookFile extends TextbookFile {
  wordNotes: Array<{ wordId: string; lesson: number; section: string; headword: string; pinyin?: string; glossEn?: string }>;
}

function readBook(bookId: string): BookFile | undefined {
  const f = path.join(REPO_ROOT, 'data/curriculum', bookId, 'book.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as BookFile) : undefined;
}

/** `pdftotext -layout` text per page, cached in private/ (never committed). */
function loadLayout(bookId: string, dir: string, pages: number[], skip: boolean): Record<string, string> {
  const file = path.join(dir, 'private', 'layout.json');
  const cache: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (skip) return cache;
  const pdf = path.join(REPO_ROOT, 'data/raw/textbook', `${bookId}.pdf`);
  let changed = false;
  for (const p of pages) {
    if (cache[String(p)] !== undefined) continue;
    cache[String(p)] = execFileSync('pdftotext', ['-layout', '-f', String(p), '-l', String(p), pdf, '-'], {
      encoding: 'utf8',
      maxBuffer: 1 << 24,
    });
    changed = true;
  }
  if (changed) writeFileSync(file, JSON.stringify(cache) + '\n', 'utf8');
  return cache;
}

export interface ScanResult {
  entries: ExtraEntry[];
  weak: string[];
  imagePages: Array<{ lesson: number; page: number; pdfPage: number; bare: number }>;
  /** Names and places the scan skipped (capitalised reading): listed so the owner can add one by hand. */
  skippedNames: string[];
  /** Image-read words the lexicon lacks and the file gave no reading for. */
  needsReading: string[];
}

/** Words Claude Code read from page images: `private/image-words.tsv`, lines `pdfPage<TAB>headword<TAB>pinyin<TAB>gloss`. */
function loadImageWords(dir: string): Map<number, RawCandidate[]> {
  const file = path.join(dir, 'private', 'image-words.tsv');
  const out = new Map<number, RawCandidate[]>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [page, headword, pinyin = '', glossEn = ''] = line.split('\t');
    const list = out.get(Number(page)) ?? [];
    const [first = '', ...variants] = headword!.split('/');
    list.push({ headword: first, variants, pinyin: pinyin.trim(), glossEn: glossEn.trim(), found: 'image' });
    out.set(Number(page), list);
  }
  return out;
}

export function scanBook(bookId: string): ScanResult {
  const cfg = loadBookConfig(bookId);
  const dir = path.join(REPO_ROOT, 'data/curriculum', bookId);
  const book = readBook(bookId);
  if (!book) throw new Error(`Run \`pnpm curriculum:import ${bookId}\` first: no book.json.`);
  const { pages } = loadPages(cfg, dir);
  const lexicon = loadLinkLexicon(bookId);
  const imageWords = loadImageWords(dir);
  // Readings the books themselves give (a word taught as core in a later lesson is not in the lexicon file yet).
  const bookReading = new Map<string, { pinyin: string; glossEn: string }>();
  for (const b of [...BOOK_ORDER.slice(0, BOOK_ORDER.indexOf(bookId)).map(readBook), book])
    for (const n of b?.wordNotes ?? [])
      if (n.pinyin && !bookReading.has(n.headword)) bookReading.set(n.headword, { pinyin: n.pinyin, glossEn: n.glossEn ?? '' });
  const lessonCount = cfg.lessonStartPages.length;
  const allPages = Array.from({ length: cfg.endPage - cfg.lessonStartPages[0]! }, (_, i) => cfg.lessonStartPages[0]! + i);
  const layout = loadLayout(bookId, dir, allPages, cfg.glyphDecode);

  // Everything already taught up to a lesson (this book, earlier books), by id and written form.
  const bookIdx = BOOK_ORDER.indexOf(bookId);
  const earlier = BOOK_ORDER.slice(0, bookIdx).map(readBook).filter((b): b is BookFile => !!b);
  const knownIds = new Set<string>();
  const knownForms = new Set<string>([...cfg.extraNames.map((n) => n.headword), ...cfg.vocabSwaps.map((x) => x.from)]);
  const learn = (b: BookFile, upTo: number) => {
    for (const l of b.textbook.lessons) {
      if (l.n > upTo) continue;
      for (const id of [...l.vocab, ...l.supplementary, ...(l.grammarWords ?? []), ...l.properNouns]) knownIds.add(id);
    }
    for (const n of b.wordNotes) if (n.lesson <= upTo && n.section !== ('extra' as string)) knownForms.add(n.headword);
  };
  for (const b of earlier) learn(b, 99);
  // Extras an earlier book (or lesson) already teaches are not proposed again.
  for (const eb of BOOK_ORDER.slice(0, bookIdx))
    for (const e of activeExtras(loadExtras(path.join(REPO_ROOT, 'data/curriculum', eb)))) knownForms.add(e.headword);
  const priorLesson = new Map(loadExtras(dir).map((e) => [e.headword, e.lesson]));
  const addForms = () => {
    for (const id of knownIds) {
      const w = lexicon.byId(id);
      if (w) for (const f of [w.headword, ...w.variants]) knownForms.add(f);
    }
  };

  const out: ExtraEntry[] = [];
  const weak: string[] = [];
  const imagePages: ScanResult['imagePages'] = [];
  const skippedNames: string[] = [];
  const needsReading: string[] = [];
  const bareOut: Record<string, { lesson: number; labels: string[]; known: string[] }> = {};
  const taken = new Set<string>(); // an extra is taught in the first lesson that shows it
  for (let n = 1; n <= lessonCount; n++) {
    learn(book, n);
    addForms();
    const start = cfg.lessonStartPages[n - 1]!;
    const next = cfg.lessonStartPages[n] ?? cfg.endPage;
    for (let p = start; p < next; p++) {
      const text = pages[String(p)] ?? '';
      const printed = printedPage(text) ?? printedPage(layout[String(p)] ?? '') ?? p;
      const cands = [...scanPage(layout[String(p)] ?? '', text), ...(imageWords.get(p) ?? [])];
      const covered = new Set<string>(knownForms);
      for (const c of cands) {
        covered.add(c.headword);
        if (c.proper) {
          if (!knownForms.has(c.headword) && !skippedNames.some((x) => x.startsWith(`L${n} `) && x.includes(` ${c.headword} `)))
            skippedNames.push(`L${n} p${printed} ${c.headword} ${c.pinyin} "${c.glossEn}"`);
          continue;
        }
        if ([c.headword, ...c.variants].some((f) => knownForms.has(f)) || taken.has(c.headword) || (priorLesson.has(c.headword) && priorLesson.get(c.headword) !== n)) continue;
        const link = linkBookWord(
          { lesson: n, n: 0, section: 'supplementary', headword: c.headword, variants: c.variants, pinyin: c.pinyin, pos: [], glossEn: c.glossEn },
          lexicon,
        );
        // A bare gloss (picture label, no reading) is only trusted when the lexicon knows the word.
        const own = bookReading.get(c.headword);
        if (!c.pinyin && !link.word && own) {
          c.pinyin = own.pinyin;
          c.glossEn = c.glossEn || own.glossEn;
        }
        if (!c.pinyin && !link.word) {
          if (c.found === 'image') needsReading.push(`L${n} p${printed} (pdf ${p}) ${c.headword}`);
          continue;
        }
        if (link.word && (knownIds.has(link.word.id) || link.word.tags.includes('name'))) continue;
        if (/surname|given name|\bname\b.*\(/i.test(c.glossEn)) continue;
        taken.add(c.headword);
        if (link.word && link.tier !== 'exact') {
          weak.push(`L${n} p${printed} ${c.headword} (${c.pinyin}, "${c.glossEn}") → ${link.word.headword} ${link.word.pinyin} "${link.word.glossEn}" [${link.tier}]`);
        }
        out.push({
          lesson: n,
          page: printed,
          ...(printed !== p ? { pdfPage: p } : {}),
          headword: c.headword,
          pinyin: c.pinyin || link.word?.pinyin,
          glossEn: (c.pinyin ? c.glossEn : '') || link.word?.glossEn,
          wordId: link.word?.id ?? null,
          found: c.found,
          status: 'proposed',
        });
      }
      const bare = bareLabels(text, covered).filter((h) => !taken.has(h));
      if (bare.length >= 3) {
        imagePages.push({ lesson: n, page: printed, pdfPage: p, bare: bare.length });
        const known = bare.filter((h) => lexicon.lookup(h).some((w) => w.headword === h && w.source !== 'textbook' && !knownIds.has(w.id)));
        bareOut[String(p)] = { lesson: n, labels: bare, known };
      }
    }
  }
  // The bare labels are page text: private, read by Claude Code next to the page image.
  writeFileSync(path.join(dir, 'private', 'bare-labels.json'), JSON.stringify(bareOut, null, 1) + '\n', 'utf8');
  return { entries: out, weak, imagePages, skippedNames, needsReading };
}

function report(bookId: string, all: ExtraEntry[], added: ExtraEntry[], res: ScanResult): string {
  const lines = [
    `# ${bookId}: lesson extras (Phase 34)`,
    '',
    `Generated by \`pnpm curriculum:extras ${bookId}\`. Word list only, no book text.`,
    `${all.filter((e) => e.status !== 'drop').length} extras kept or proposed, ${all.filter((e) => e.status === 'drop').length} dropped; ${added.length} new in the last run.`,
    '',
  ];
  const lessons = [...new Set(all.map((e) => e.lesson))].sort((a, b) => a - b);
  for (const n of lessons) {
    lines.push(`## Lesson ${n}`, '', '| Page | Word | Pinyin | Meaning | Found | Status |', '|---|---|---|---|---|---|');
    for (const e of all.filter((x) => x.lesson === n))
      lines.push(`| ${e.page} | ${e.headword} | ${e.pinyin ?? ''} | ${e.glossEn ?? ''} | ${e.found ?? ''} | ${e.status} |`);
    const imgs = all.filter((e) => e.lesson === n && e.found === 'image');
    if (imgs.length) lines.push('', `Read as images: pages ${[...new Set(imgs.map((e) => e.page))].join(', ')}.`);
    lines.push('');
  }
  lines.push('## Pages with Chinese labels and no gloss (read as images)', '');
  lines.push(res.imagePages.length ? res.imagePages.map((p) => `- L${p.lesson} p${p.page} (pdf ${p.pdfPage}): ${p.bare} bare labels`).join('\n') : '(none)', '');
  lines.push('## Names and places skipped (capitalised reading)', '', res.skippedNames.length ? res.skippedNames.map((w) => `- ${w}`).join('\n') : '(none)', '');
  lines.push('## Weak lexicon links', '', res.weak.length ? res.weak.map((w) => `- ${w}`).join('\n') : '(none)', '');
  return lines.join('\n');
}

export function runExtras(bookId: string): void {
  const dir = path.join(REPO_ROOT, 'data/curriculum', bookId);
  const res = scanBook(bookId);
  const { merged, added } = mergeExtras(loadExtras(dir), res.entries);
  saveExtras(dir, bookId, merged);
  writeFileSync(path.join(dir, 'extras-report.md'), report(bookId, merged, added, res), 'utf8');
  if (res.needsReading.length) console.log(`  needs a reading in image-words.tsv:\n    ${res.needsReading.join('\n    ')}`);
  console.log(`${bookId}: ${added.length} new candidates (${merged.length} in extras.yaml); ${res.imagePages.length} pages to read as images.`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: curriculum:extras <bookId | --all>');
    process.exit(2);
  }
  for (const id of arg === '--all' || arg === 'all' ? configuredBooks() : [arg]) runExtras(id);
}
