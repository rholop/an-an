import {
  buildLessonGrammarStep,
  checkTaiwanness,
  courseOrdinal,
  homeLessonOfTags,
  isPunctTile,
  LAIXUE_COURSE,
  lessonScopedWordIds,
  lessonTileWords,
  NUMBER_UNITS,
  patternBlank,
  segment,
  sentenceTiles,
  splitPinyinSyllables,
  type GrammarItem,
  type Lexicon,
  type SentenceBankEntry,
  type Textbook,
  type Word,
} from '@anan/core';
import { resolveMoeReading, type MoeDictionary } from '../moe.js';
import { makeScopeChecker, type ScopeChecker } from './scope-check.js';

/**
 * Phase 25 D: the curriculum audit (`pnpm audit:curriculum`, run in CI). Every check is a pure
 * function of the built data, so a failure names the entry or sentence and why.
 */

export type AuditCheck =
  | 'lexicon-unresolved'
  | 'lexicon-headword'
  | 'lexicon-syllables'
  | 'lexicon-moe'
  | 'lexicon-book-reading'
  | 'lexicon-gloss'
  | 'sentence-taiwan'
  | 'sentence-later-word'
  | 'sentence-later-grammar'
  | 'sentence-tag'
  | 'sentence-blank'
  | 'sentence-tile'
  | 'sentence-duplicate'
  | 'lesson-grammar-exercises'
  | 'lesson-proper-noun'
  | 'lesson-prompt-scope';

export const AUDIT_CHECKS: Record<AuditCheck, string> = {
  'lexicon-unresolved': 'A lesson word id that is not in the lexicon',
  'lexicon-headword': 'A headword with spaces or Latin letters',
  'lexicon-syllables': 'Pinyin whose syllable count does not match the headword',
  'lexicon-moe': 'Pinyin that disagrees with the MOE reading',
  'lexicon-book-reading': "Pinyin that disagrees with the book's reading (a dropped final -n)",
  'lexicon-gloss': 'A gloss with stray punctuation',
  'sentence-taiwan': 'Simplified characters or a mainland term',
  'sentence-later-word': 'A word taught in a later lesson',
  'sentence-later-grammar': 'A grammar point taught in a later lesson',
  'sentence-tag': 'A grammar tag the matcher does not confirm',
  'sentence-blank': 'A grammar blank inside another word or outside the pattern',
  'sentence-tile': 'A reorder tile that is not a word, a number + measure word, or punctuation',
  'sentence-duplicate': 'The same sentence twice',
  'lesson-grammar-exercises': 'A grammar point with fewer than 3 exercises or fewer than 2 types',
  'lesson-proper-noun': 'A proper noun in study vocabulary',
  'lesson-prompt-scope': "A journal prompt using words or grammar beyond its lesson",
};

export interface AuditFinding {
  check: AuditCheck;
  /** Where: a word id, a sentence id, or "laixue-1 L3 scenario opener". */
  where: string;
  detail: string;
}

export interface AuditBook {
  textbook: Textbook;
  grammarItems: GrammarItem[];
  wordNotes?: Array<{ wordId: string; headword?: string; glossEn?: string; pinyin?: string }>;
}

/** Text in a lesson other than bank sentences (scenario lines, prompt models). */
export interface AuditText {
  bookId: string;
  lesson: number;
  where: string;
  zh: string;
}

export interface AuditConfig {
  /** Headwords allowed to contain Latin letters (names written that way). */
  allowedLatin: string[];
  /** Grammar id → regex that detects a real use of the point (for "used before it is taught"). */
  detect: Record<string, string>;
  /** Accepted findings: each must match one finding exactly and say why. */
  allow: Array<{ check: AuditCheck; where: string; reason: string }>;
}

export interface AuditInputs {
  lexicon: Lexicon;
  /** Course order. */
  books: AuditBook[];
  sentences: SentenceBankEntry[];
  texts: AuditText[];
  moe?: MoeDictionary;
  config: AuditConfig;
  /** Seeds the grammar step is built with (each must give every point 3 exercises, 2 types). */
  seeds?: string[];
}

export interface AuditResult {
  findings: AuditFinding[];
  /** Allowed findings (matched an `allow` entry). */
  allowed: Array<AuditFinding & { reason: string }>;
  /** `allow` entries that matched nothing (stale). */
  staleAllows: AuditConfig['allow'];
  stats: { words: number; sentences: number; texts: number; grammarPoints: number; lessons: number };
}

const HAN = /\p{Script=Han}/u;
const TONE_FREE = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const toneless = (s: string) => TONE_FREE(s).replace(/ü/g, 'v').replace(/[^a-zv]/g, '');
const normPinyin = (s: string) => s.normalize('NFC').toLowerCase().replace(/[\s'’\-·]/g, '');

const bookIdOf = (s: Pick<SentenceBankEntry, 'textbookId'>) => s.textbookId ?? 'laixue-1';

/** Tiles the reorder builder makes on purpose: number (+ unit) (十一點, 一百多個, 二〇二五), 這個 / 每個, 星期一. */
const NUMBER_TILE = /^(?:[〇零一二兩三四五六七八九十百千萬幾半0-9０-９]+多?|[這那哪每])\p{Script=Han}{0,2}$|^(?:星期|禮拜)[一二三四五六日天幾]$/u;

const NUM = '〇零一二兩三四五六七八九十百千萬幾半0-9０-９';
const NUMBER_RE = new RegExp(`[${NUM}]{2,}(?:${[...NUMBER_UNITS].sort((a, b) => b.length - a.length).join('|')})?|[${NUM}](?:${[...NUMBER_UNITS].sort((a, b) => b.length - a.length).join('|')})`, 'gu');
/** Numbers with their measure word (十一點, 三個): read as one, never a "later" word. */
function numberSpans(zh: string): Array<[number, number]> {
  return [...zh.matchAll(NUMBER_RE)].map((m) => [m.index!, m.index! + m[0].length]);
}

function ordinal(bookId: string, n: number): number {
  return courseOrdinal(LAIXUE_COURSE, bookId, n) ?? 9999;
}

/** Syllables a headword is read with: Han characters and digits, minus a final 兒 read as -r. */
function expectedSyllables(headword: string, syllables: string[]): number {
  let n = [...headword].filter((c) => HAN.test(c) || /\d/.test(c)).length;
  if (headword.endsWith('兒') && n > 1 && /r$/i.test(TONE_FREE(syllables.at(-1) ?? '')) && TONE_FREE(syllables.at(-1) ?? '') !== 'er') n--;
  return n;
}

export function runCurriculumAudit(inputs: AuditInputs): AuditResult {
  const { lexicon, books, config } = inputs;
  const findings: AuditFinding[] = [];
  const add = (check: AuditCheck, where: string, detail: string) => findings.push({ check, where, detail });
  const textbooks = books.map((b) => b.textbook);
  // A point taught again in a later book keeps one item: its home is the first lesson that teaches it.
  const grammarById = new Map<string, GrammarItem>();
  for (const g of books.flatMap((b) => b.grammarItems)) {
    const have = grammarById.get(g.id);
    grammarById.set(g.id, have ? { ...have, tags: [...new Set([...(have.tags ?? []), ...(g.tags ?? [])])] } : g);
  }
  const homeOf = (gid: string) => {
    const g = grammarById.get(gid);
    return g ? homeLessonOfTags(g.tags ?? []) : undefined;
  };

  // ---------------------------------------------------------------- lexicon entries
  const courseIds = new Map<string, string>(); // id -> where it is used
  for (const b of books) {
    for (const l of b.textbook.lessons)
      for (const id of [...l.vocab, ...l.supplementary, ...(l.grammarWords ?? []), ...l.properNouns])
        if (!courseIds.has(id)) courseIds.set(id, `${b.textbook.id} L${l.n}`);
  }
  for (const [id, where] of courseIds) {
    const w = lexicon.byId(id);
    if (!w) {
      add('lexicon-unresolved', id, `used in ${where}`);
      continue;
    }
    checkWord(w, inputs, add);
  }
  for (const b of books)
    for (const note of b.wordNotes ?? [])
    {
      if (note.glossEn && badGloss(note.glossEn))
        add('lexicon-gloss', `${b.textbook.id} note ${note.wordId}`, `"${note.glossEn}"`);
      const nw = lexicon.byId(note.wordId);
      // The book's reading is the hint the MOE reading was chosen with, so a different syllable is an
      // import error (南區 ná qū for the book's nán qū), not a second reading.
      if (nw && note.pinyin && !/[(/0-9]/.test(note.pinyin) && toneless(note.pinyin) !== toneless(nw.pinyin))
        add('lexicon-book-reading', `${b.textbook.id} note ${note.wordId}`, `${nw.headword}: book "${note.pinyin}", lexicon "${nw.pinyin}"`);
      if (nw && note.headword && ![nw.headword, ...nw.variants].includes(note.headword))
        add('lexicon-headword', `${b.textbook.id} note ${note.wordId}`, `the book's ${note.headword} is linked to ${nw.headword}`);
      if (note.pinyin && /[.,;:]$/.test(note.pinyin.trim()))
        add('lexicon-gloss', `${b.textbook.id} note ${note.wordId}`, `pinyin "${note.pinyin}"`);
    }

  // ---------------------------------------------------------------- per lesson
  const scopeCache = new Map<string, { scope: ScopeChecker; scoped: Set<string>; later: Set<string> }>();
  const allLessons = books.flatMap((b) => b.textbook.lessons.map((l) => ({ bookId: b.textbook.id, l })));
  const lessonScope = (bookId: string, n: number) => {
    const key = `${bookId}:${n}`;
    let hit = scopeCache.get(key);
    if (!hit) {
      const upTo = textbooks.filter((t) => ordinal(t.id, 1) <= ordinal(bookId, 1));
      const scoped = lessonScopedWordIds(upTo, n, { bookId });
      const later = new Set<string>();
      for (const { bookId: bid, l } of allLessons) {
        if (ordinal(bid, l.n) <= ordinal(bookId, n)) continue;
        for (const id of [...l.vocab, ...l.supplementary, ...(l.grammarWords ?? [])])
          if (!scoped.has(id) && !lexicon.byId(id)?.tags.includes('name')) later.add(id);
      }
      hit = { scope: makeScopeChecker(lexicon, upTo, n, bookId), scoped, later };
      scopeCache.set(key, hit);
    }
    return hit;
  };
  const tileCache = new Map<string, ReturnType<typeof lessonTileWords>>();
  const tileWordsOf = (bookId: string, n: number) => {
    const key = `${bookId}:${n}`;
    let hit = tileCache.get(key);
    if (!hit) {
      hit = lessonTileWords(lexicon, textbooks.filter((t) => ordinal(t.id, 1) <= ordinal(bookId, 1)), n, bookId);
      tileCache.set(key, hit);
    }
    return hit;
  };
  const detectors = Object.entries(config.detect).map(([gid, re]) => ({ gid, re: new RegExp(re, 'u'), home: homeOf(gid) }));

  /** Words and grammar from a later lesson, and Taiwan-cleanliness, for any lesson text. */
  const checkText = (bookId: string, n: number, where: string, zh: string) => {
    const tw = checkTaiwanness(zh);
    if (!tw.isClean)
      add('sentence-taiwan', where, `"${zh}": ${[...tw.simplifiedChars.map((c) => c.char), ...tw.mainlandTerms.map((m) => `${m.matched} → ${m.taiwan}`)].join('、')}`);
    const { scope, scoped, later } = lessonScope(bookId, n);
    const numbers = numberSpans(zh);
    const tokens = segment(zh, lexicon, { hints: scope.hints(zh) }).filter(
      (t) => t.kind === 'word' && !numbers.some(([a, b]) => t.start < b && t.end > a),
    );
    for (const t of tokens) {
      const ids = lexicon.lookup(t.text).map((w) => w.id);
      if (ids.some((id) => scoped.has(id))) continue;
      const lateId = ids.find((id) => later.has(id));
      if (lateId) add('sentence-later-word', where, `"${zh}": ${t.text} is taught in ${firstLessonOf(lateId)}`);
    }
    for (const d of detectors) {
      if (!d.home || ordinal(d.home.bookId, d.home.n) <= ordinal(bookId, n)) continue;
      if (d.re.test(zh)) add('sentence-later-grammar', where, `"${zh}": ${d.gid} is taught in ${d.home.bookId} L${d.home.n}`);
    }
  };
  const firstLesson = new Map<string, string>();
  for (const { bookId, l } of allLessons)
    for (const id of [...l.vocab, ...l.supplementary, ...(l.grammarWords ?? [])])
      if (!firstLesson.has(id)) firstLesson.set(id, `${bookId} L${l.n}`);
  const firstLessonOf = (id: string) => firstLesson.get(id) ?? '?';

  // ---------------------------------------------------------------- sentences
  const seenZh = new Map<string, string>();
  for (const s of inputs.sentences) {
    const bookId = bookIdOf(s);
    const n = s.lesson ?? 0;
    const zhKey = s.zh.replace(/[\s，。？！、]/gu, '');
    const dup = seenZh.get(zhKey);
    if (dup) add('sentence-duplicate', s.id, `"${s.zh}" is also ${dup}`);
    else seenZh.set(zhKey, s.id);
    checkText(bookId, n, s.id, s.zh);
    const tileWords = tileWordsOf(bookId, n);
    for (const gid of s.grammarIds ?? []) {
      const g = grammarById.get(gid);
      if (!g) continue;
      if (g.matcher && !new RegExp(g.matcher, 'u').test(s.zh)) add('sentence-tag', s.id, `"${s.zh}" is tagged ${gid} but its pattern /${g.matcher}/ does not match`);
      if ((g.focus ?? []).length > 0) {
        // The blank must fall on the pattern's own signal word: when it lands inside another word
        // (the 太 of 不太) while the same word stands alone elsewhere, the matcher span is wrong.
        const blank = patternBlank(s.zh, g, lexicon);
        const toks = segment(s.zh, lexicon);
        const alone = (at: number, f: string) => toks.some((t) => t.start === at && t.text === f);
        if (blank && !alone(blank.at, blank.answer)) {
          const elsewhere = (g.focus ?? []).some((f) => {
            for (let at = s.zh.indexOf(f); at >= 0; at = s.zh.indexOf(f, at + 1)) if (alone(at, f)) return true;
            return false;
          });
          if (elsewhere) add('sentence-blank', s.id, `"${s.zh}": the ${gid} blank falls on the ${blank.answer} inside another word, not the one the pattern uses`);
        }
      }
    }
    for (const tile of sentenceTiles(s, lexicon, tileWords)) {
      if (isPunctTile(tile) || NUMBER_TILE.test(tile)) continue;
      if (lexicon.lookup(tile).length === 0) add('sentence-tile', s.id, `"${s.zh}": tile ${tile} is not a word`);
    }
  }

  // ---------------------------------------------------------------- other lesson texts
  for (const t of inputs.texts) checkText(t.bookId, t.lesson, t.where, t.zh);

  // ---------------------------------------------------------------- lesson structure
  const seeds = inputs.seeds ?? ['audit-1', 'audit-2', 'audit-3'];
  let grammarPoints = 0;
  for (const b of books) {
    const bookId = b.textbook.id;
    const own = inputs.sentences.filter((s) => bookIdOf(s) === bookId);
    const grammarItems = books.flatMap((x) => x.grammarItems);
    for (const l of b.textbook.lessons) {
      const L = `${bookId} L${l.n}`;
      grammarPoints += l.grammar.length;
      for (const gid of l.grammar) {
        const usable = own.filter((s) => s.lesson === l.n && s.grammarIds?.includes(gid)).length;
        if (usable < 3) add('lesson-grammar-exercises', `${L} ${gid}`, `only ${usable} sentences`);
      }
      for (const seed of seeds) {
        const { plan } = buildLessonGrammarStep(l, grammarItems, own, { lexicon, bookId, books: textbooks, seed });
        for (const gid of l.grammar) {
          const ex = plan.exercises.filter((e) => e.grammarId === gid);
          const types = new Set(ex.map((e) => e.type));
          if (ex.length < 3 || types.size < 2)
            add('lesson-grammar-exercises', `${L} ${gid}`, `${ex.length} exercises, types ${[...types].join('/') || 'none'} (seed ${seed})`);
        }
      }
      for (const id of [...l.vocab, ...l.supplementary]) {
        const w = lexicon.byId(id);
        if (w && (l.properNouns.includes(id) || w.tags.includes('name'))) add('lesson-proper-noun', `${L} ${id}`, `${w.headword} is a name`);
      }
      const { scoped } = lessonScope(bookId, l.n);
      for (const p of l.journalPrompts ?? []) {
        for (const id of p.useWords) if (!scoped.has(id)) add('lesson-prompt-scope', p.id, `word ${lexicon.byId(id)?.headword ?? id} is not taught yet`);
        for (const gid of p.useGrammar) {
          const home = homeOf(gid);
          if (!home || ordinal(home.bookId, home.n) > ordinal(bookId, l.n)) add('lesson-prompt-scope', p.id, `grammar ${gid} is not taught yet`);
        }
        if (p.promptZh) checkText(bookId, l.n, `${p.id} model`, p.promptZh);
      }
    }
  }

  // ---------------------------------------------------------------- de-duplicate, apply allows
  const unique = new Map<string, AuditFinding>();
  for (const f of findings) unique.set(`${f.check}|${f.where}|${f.detail.replace(/ \(seed [^)]+\)$/, '')}`, { ...f, detail: f.detail.replace(/ \(seed [^)]+\)$/, '') });
  const out: AuditFinding[] = [];
  const allowed: AuditResult['allowed'] = [];
  const used = new Set<number>();
  for (const f of unique.values()) {
    const k = config.allow.findIndex((a) => a.check === f.check && a.where === f.where);
    if (k >= 0) {
      used.add(k);
      allowed.push({ ...f, reason: config.allow[k]!.reason });
    } else out.push(f);
  }
  return {
    findings: out,
    allowed,
    staleAllows: config.allow.filter((_, k) => !used.has(k)),
    stats: {
      words: courseIds.size,
      sentences: inputs.sentences.length,
      texts: inputs.texts.length,
      grammarPoints,
      lessons: allLessons.length,
    },
  };
}

export function badGloss(gloss: string): boolean {
  const g = gloss.trim();
  return /^[,;:.、]/.test(g) || /[,;:、]$/.test(g) || /[,;]\s*[,;]/.test(g) || /\(\s*\)/.test(g) || /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]\w*\.$/u.test(g);
}

function checkWord(w: Word, inputs: AuditInputs, add: (c: AuditCheck, where: string, detail: string) => void): void {
  const where = w.id;
  if (/\s/.test(w.headword) || (/[A-Za-z]/.test(w.headword) && !inputs.config.allowedLatin.includes(w.headword)))
    add('lexicon-headword', where, `"${w.headword}"`);
  const isName = w.tags.includes('name');
  const syllables = splitPinyinSyllables(w.pinyin);
  // names are often written joined (Wáng Míngwén); only spaced readings can be counted
  if ((!isName || syllables.length > 1) && !/[A-Za-z]/.test(w.headword)) {
    const expected = expectedSyllables(w.headword, syllables);
    if (w.pinyin && syllables.length !== expected && !(isName && syllables.length < expected))
      add('lexicon-syllables', where, `${w.headword} has ${expected} syllables, pinyin "${w.pinyin}" has ${syllables.length}`);
  }
  if (inputs.moe && !isName && !w.tags.some((t) => t === 'reading:override' || t === 'reading:unverified')) {
    const r = resolveMoeReading(inputs.moe, w.headword, w.pinyin);
    if (r.pinyin && normPinyin(r.pinyin) !== normPinyin(w.pinyin))
      add('lexicon-moe', where, `${w.headword} "${w.pinyin}", MOE "${r.pinyin}"`);
  }
  if (badGloss(w.glossEn)) add('lexicon-gloss', where, `${w.headword} "${w.glossEn}"`);
}

/** The audit report (docs/curriculum-audit.md). */
export function renderAuditReport(r: AuditResult, date: string, naturalness?: string): string {
  const by = new Map<AuditCheck, AuditFinding[]>();
  for (const f of r.findings) by.set(f.check, [...(by.get(f.check) ?? []), f]);
  const lines = [
    '# Curriculum audit',
    '',
    `Generated by \`pnpm audit:curriculum\` on ${date}. CI fails while any check below has a finding.`,
    '',
    `Checked ${r.stats.words} lesson words, ${r.stats.sentences} lesson sentences, ${r.stats.texts} scenario lines and prompt models, and ${r.stats.grammarPoints} grammar points in ${r.stats.lessons} lessons.`,
    '',
    '| Check | Findings |',
    '|---|---|',
    ...(Object.keys(AUDIT_CHECKS) as AuditCheck[]).map((c) => `| ${AUDIT_CHECKS[c]} | ${by.get(c)?.length ?? 0} |`),
    '',
    r.findings.length === 0 ? '**All checks pass.**' : `**${r.findings.length} finding(s).**`,
    '',
  ];
  for (const [c, list] of by) {
    lines.push(`## ${AUDIT_CHECKS[c]}`, '');
    for (const f of list) lines.push(`- \`${f.where}\`: ${f.detail}`);
    lines.push('');
  }
  if (r.allowed.length) {
    lines.push('## Accepted on purpose', '', 'Listed in `data/curriculum/audit-config.yaml`, each with its reason.', '');
    for (const a of r.allowed) lines.push(`- ${AUDIT_CHECKS[a.check]}: \`${a.where}\`: ${a.reason}`);
    lines.push('');
  }
  if (naturalness) lines.push(naturalness.trim(), '');
  return lines.join('\n');
}
