// Phase 20 Part A: where a learner's review pile comes from, read from an app backup.
//
//   pnpm --filter @anan/data-pipeline review-pile <backup.json> [out.md]
//
// Prints (or writes) a markdown report: cards by source and level, the busiest due days and
// what fell due on them, and the "obscure" words (above the picked level or in no list).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cardSourceFor,
  Lexicon,
  levelIndex,
  pileReport,
  SOURCE_LABELS,
  type CardSource,
  type Evidence,
  type Level,
  type SkillCard,
  type Word,
} from '@anan/core';

const [, , backupPath, outPath] = process.argv;
if (!backupPath) {
  console.error('usage: review-pile <backup.json> [out.md]');
  process.exit(1);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const lexRaw = JSON.parse(readFileSync(resolve(repoRoot, 'data/build/lexicon.v2.json'), 'utf8')) as {
  words: Word[];
  grammar: never[];
};
const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as {
  exportedAt: string;
  items: SkillCard[];
  evidence: Evidence[];
  settings: Record<string, unknown>;
  customWords?: Word[];
};
const lexicon = new Lexicon([...lexRaw.words, ...(backup.customWords ?? [])], lexRaw.grammar);
const levelSetting = backup.settings.currentLevel as { value?: Level } | Level | undefined;
const picked = (typeof levelSetting === 'string' ? levelSetting : levelSetting?.value) ?? undefined;

// Backfill the source the same way the v9 migration does: the first evidence on each card.
const evidence = backup.evidence
  .map((e) => ({ ...e, at: new Date(e.at) }))
  .sort((a, b) => a.at.getTime() - b.at.getTime());
const first = new Map<string, Evidence>();
for (const e of evidence) {
  const k = `${e.item.kind}:${e.item.id}|${e.skill}`;
  if (!first.has(k)) first.set(k, e);
}
const cards: SkillCard[] = backup.items.map((c) => {
  const e = first.get(`${c.item.kind}:${c.item.id}|${c.skill}`);
  return {
    ...c,
    card: { ...c.card, due: new Date(c.card.due), ...(c.card.last_review ? { last_review: new Date(c.card.last_review) } : {}) },
    source: c.source ?? (e ? cardSourceFor(e) : c.flags.imported ? 'anki' : c.flags.probablyKnown ? 'placement' : 'other'),
  };
});

const report = pileReport(cards, (id) => lexicon.byId(id), picked);
const lines: string[] = [];
const out = (s = '') => lines.push(s);
const srcList = (o: Partial<Record<CardSource, number>>) =>
  (Object.entries(o) as Array<[CardSource, number]>)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${SOURCE_LABELS[s]}`)
    .join(', ');

const reviewable = cards.filter((c) => c.item.kind === 'word' && c.skill !== 'listening');
out(`Backup exported ${backup.exportedAt}; picked level ${picked ?? '(none)'}; ${reviewable.length} word cards (recognition + production).`);
out();
out('## Cards by source');
out();
for (const [s, n] of Object.entries(report.bySource).sort((a, b) => b[1] - a[1])) out(`- ${SOURCE_LABELS[s as CardSource]}: ${n}`);
out();
out('## Cards by level');
out();
for (const [l, n] of Object.entries(report.byLevel).sort((a, b) => b[1] - a[1])) out(`- ${l === 'none' ? 'not in any list' : l}: ${n}`);
out();
out(`Above the picked level: ${report.aboveLevel}. Not in any list: ${report.notInAnyList}.`);
out();
out('## Busiest due days');
out();
for (const d of report.busiestDays) out(`- ${d.day}: ${d.count} (${srcList(d.bySource)})`);
out();

// When were the cards made, in bulk? (Evidence days that created 50+ cards.)
const madeOn = new Map<string, Partial<Record<CardSource, number>>>();
for (const c of reviewable) {
  const e = first.get(`${c.item.kind}:${c.item.id}|${c.skill}`);
  if (!e) continue;
  const day = e.at.toISOString().slice(0, 10);
  const o = madeOn.get(day) ?? {};
  o[c.source!] = (o[c.source!] ?? 0) + 1;
  madeOn.set(day, o);
}
out('## Days that created 50+ cards');
out();
for (const [day, o] of [...madeOn].sort()) {
  const n = Object.values(o).reduce((a, b) => a + b, 0);
  if (n >= 50) out(`- ${day}: ${n} (${srcList(o)})`);
}
out();

// The obscure words: above picked level + 1, or in no list.
const obscure = report.rows.filter(
  (r) =>
    !r.removed &&
    (r.level === 'none' ||
      (picked && r.level !== 'textbook' && r.level !== 'custom' && levelIndex(r.level as Level) > levelIndex(picked) + 1)),
);
const obscureBySource: Partial<Record<CardSource, number>> = {};
for (const r of obscure) obscureBySource[r.source] = (obscureBySource[r.source] ?? 0) + 1;
out(`## Obscure cards (more than one level above ${picked ?? '?'}, or in no list): ${obscure.length}`);
out();
out(srcList(obscureBySource) || 'none');
out();
out(`Examples: ${[...new Set(obscure.map((r) => r.headword))].slice(0, 30).join('、')}`);

const text = lines.join('\n') + '\n';
if (outPath) writeFileSync(outPath, text);
else process.stdout.write(text);
