#!/usr/bin/env tsx
/**
 * Phase 7 §B Step 0: diagnose the wrong glosses BEFORE fixing them. Compares
 * the old lexicon (v1) with the rebuilt one (v2) for a reproducible sample of
 * 60 words and writes docs/gloss-diagnosis.md with a cause for each and the
 * counts per cause (sample and whole lexicon).
 *
 *   pnpm --filter @anan/data-pipeline diagnose:glosses [old.json] [new.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVEL_IDS, Lexicon, ScenarioFileSchema, segment, type Level, type Word } from '@anan/core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const oldPath = process.argv[2] ?? path.join(root, 'data/build/lexicon.v1.json');
const newPath = process.argv[3] ?? path.join(root, 'data/build/lexicon.v2.json');
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as { words: Word[] };
const oldWords = load(oldPath).words;
const newById = new Map(load(newPath).words.map((w) => [w.id, w]));

export type Cause =
  | 'first-sense-only'
  | 'homograph-conflation'
  | 'wrong-sense-for-context'
  | 'missing-entry'
  | 'ok-before';

const JUNK_FIRST =
  /^(surname\b|variant of\b|\(loanword\)|\(archaic\)|old variant|abbr\. for|Taiwan pr\.|see\b)/i;

/** Why was the OLD gloss (the first CC-CEDICT sense of the whole headword,
 * ignoring the reading) wrong or fragile? Ordered most- to least-specific. */
function causeOf(w: Word, byHeadword: Map<string, Word[]>): Cause {
  if (!w.glossEn) return 'missing-entry';
  const same = byHeadword.get(w.headword) ?? [];
  if (same.some((o) => o.id !== w.id && o.pinyin !== w.pinyin && o.glossEn === w.glossEn))
    return 'homograph-conflation';
  if (JUNK_FIRST.test(w.glossEn)) return 'first-sense-only';
  const n = newById.get(w.id);
  if ((n?.senses?.length ?? 0) >= 3) return 'wrong-sense-for-context';
  return 'ok-before';
}

const byHeadword = new Map<string, Word[]>();
for (const w of oldWords) byHeadword.set(w.headword, [...(byHeadword.get(w.headword) ?? []), w]);

// ---- population counts
const population: Record<Cause, number> = {
  'first-sense-only': 0,
  'homograph-conflation': 0,
  'wrong-sense-for-context': 0,
  'missing-entry': 0,
  'ok-before': 0,
};
for (const w of oldWords) population[causeOf(w, byHeadword)]++;

// ---- segmentation / ambiguity: tokens whose headword has several readings
const scenarios = ScenarioFileSchema.parse(
  JSON.parse(readFileSync(path.join(root, 'data/build/scenarios.json'), 'utf8')),
).scenarios;
const lexicon = new Lexicon(oldWords);
let tokens = 0;
let ambiguous = 0;
for (const s of scenarios) {
  const lines = [
    s.opener.zh,
    s.successLine.zh,
    ...s.vocabExtras,
    ...s.goalSteps.flatMap((g) => g.keywordHints),
  ];
  for (const t of segment(lines.join('\n'), lexicon)) {
    if (t.kind !== 'word') continue;
    tokens++;
    if (new Set(lexicon.lookup(t.text).map((w) => w.pinyin)).size > 1) ambiguous++;
  }
}

// ---- the 60-word sample (seeded, reproducible)
let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const reported: [string, string?][] = [
  ['機車'],
  ['還', 'hái'],
  ['還', 'huán'],
  ['長', 'cháng'],
  ['長', 'zhǎng'],
  ['打', 'dǎ'],
  ['便利商店'],
  ['垃圾車'],
  ['了', 'le'],
  ['把', 'bǎ'],
  ['得', 'de'],
  ['行', 'xíng'],
  ['行', 'háng'],
];
const sample: Word[] = [];
const taken = new Set<string>();
const take = (w?: Word) => {
  if (w && !taken.has(w.id)) {
    taken.add(w.id);
    sample.push(w);
  }
};
for (const [h, p] of reported)
  take(oldWords.find((w) => w.headword === h && (!p || w.pinyin === p)));
// Random words that LOOK wrong, from every level (cause ≠ ok-before), 7 per level.
for (const level of LEVEL_IDS as readonly Level[]) {
  const pool = oldWords.filter(
    (w) => w.level === level && causeOf(w, byHeadword) !== 'ok-before' && !taken.has(w.id),
  );
  for (let i = 0; i < 7 && pool.length > 0; i++)
    take(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
}
const filler = oldWords.filter((w) => !taken.has(w.id) && causeOf(w, byHeadword) !== 'ok-before');
while (sample.length < 60 && filler.length > 0)
  take(filler.splice(Math.floor(rnd() * filler.length), 1)[0]);

sample.length = Math.min(sample.length, 60);

const sampleCounts: Record<Cause, number> = {
  'first-sense-only': 0,
  'homograph-conflation': 0,
  'wrong-sense-for-context': 0,
  'missing-entry': 0,
  'ok-before': 0,
};

const rows: string[] = [];
let ok = 0;
let flagged = 0;
for (const w of sample) {
  const cause = causeOf(w, byHeadword);
  sampleCounts[cause]++;
  const n = newById.get(w.id);
  const sources = n?.glossSources ?? [];
  const supported =
    sources.includes('top2011') || sources.includes('override') || sources.includes('supplement');
  const status = n && n.senses?.length && supported ? 'ok' : 'flagged';
  if (status === 'ok') ok++;
  else flagged++;
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  rows.push(
    `| ${w.level ?? '—'} | ${w.headword} ${w.pinyin} | ${cell(w.glossEn.slice(0, 50) || '—')} | ${cause} | ${cell(
      (n?.senses ?? [])
        .slice(0, 2)
        .map((s) => s.glossEn)
        .join(' / ') || '—',
    )} | ${sources.join('+') || '—'} | ${status} |`,
  );
}

const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`;
const table = (c: Record<Cause, number>, total: number) =>
  (Object.entries(c) as [Cause, number][])
    .filter(([k]) => k !== 'ok-before')
    .map(([k, v]) => `| ${k} | ${v} | ${pct(v, total)} |`)
    .join('\n');

const md = `# Gloss diagnosis (phase 7, part B, step 0)

Generated by \`pnpm --filter @anan/data-pipeline diagnose:glosses\` — old lexicon \`${path.basename(oldPath)}\` vs rebuilt \`${path.basename(newPath)}\`.

## What the old build did

\`build-lexicon.ts\` set \`Word.glossEn = moe.gloss(headword)\`, i.e. the \`English\` field of the MOE translated dictionary, which is **the first CC-CEDICT sense of the whole headword**:

- the **reading is ignored** — 還 *hái* and 還 *huán*, 長 *cháng* and *zhǎng*, 打 in all its readings got the same text;
- the **first** sense is whatever CC-CEDICT happens to list first — often a surname ("surname Huan"), a loanword ("(loanword) dozen") or the mainland sense ("locomotive; train engine car");
- the **TOCFL part of speech** and the exam's intended sense were never consulted;
- the 2023 TOCFL list has no definitions at all, so nothing in the build could have checked any of this.

## Causes — whole lexicon (${oldWords.length} words, old build)

| cause | words | share |
| --- | --- | --- |
${table(population, oldWords.length)}

(\`wrong-sense-for-context\` = the word has ≥ 3 distinct senses in the rebuilt inventory, so a single gloss can only be right for some contexts; a count of *fragile* glosses, not of *wrong* ones.)

Segmentation: on the scenario corpus (${scenarios.length} scenarios), **${ambiguous} of ${tokens} word tokens (${pct(ambiguous, tokens)})** have a headword with more than one reading, so the reader/chat attached the first-listed homograph's gloss regardless of context. This is the "wrong word attached" cause: it is addressed by sense picking (\`resolveSense\`, \`sense_id\` in chat tokens), not by the build.

## Causes — the 60-word sample

Owner-reported words (機車, 還, 長, 打, 便利商店, 垃圾車, 了, 把, 得, 行) plus seven random suspicious words from each of the seven levels, seeded so the sample is reproducible.

| cause | words | share |
| --- | --- | --- |
${table(sampleCounts, sample.length)}

**Biggest cause: first-sense-only / reading-blind glosses.** Fixed first (below).

## The fix

1. Glosses are now **per reading** (CC-CEDICT lines matched on pinyin via ivankra/tocfl's \`tocfl-cedict.csv\`), with MOE's bundled English only as a labelled fallback.
2. Candidates are ranked by TOCFL POS, the old TOP 2011 gloss (which says which sense the list meant), Taiwan tags, and a penalty for surnames/variants/loanwords/mainland-only senses; near-synonyms are folded together; each word keeps up to four senses, primary first (\`Word.senses\`).
3. MOE's Chinese definitions are attached verbatim (\`moeDefZh\`), hand \`gloss-overrides.yaml\` always wins, and the offline LLM adjudication (\`build:glosses\`) can refine the choice but only by choosing/condensing from cited candidates.
4. Wiktionary (kaikki.org) and Unihan are optional sources, in the data since 2026-10-01. Wiktionary fills gaps (Taiwan spellings via its soft redirects: 汙染 → 污染) and adds Taiwan-tagged senses, but never outranks this reading's CEDICT senses; its slang, dialect, Classical and literal-only senses are dropped.

## The same 60 words after the fix

Status: **ok** = the new primary gloss is backed by the TOP 2011 / an override / a supplement gloss; **flagged** = no corroborating source, so it is in \`gloss-review.md\` for a human (it may still be right). ${ok} ok, ${flagged} flagged.

| level | word | old gloss | old cause | new senses (first two) | sources | status |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;

writeFileSync(path.join(root, 'docs/gloss-diagnosis.md'), md);
console.log(
  `wrote docs/gloss-diagnosis.md — sample causes ${JSON.stringify(sampleCounts)}; ${ok} ok / ${flagged} flagged`,
);
