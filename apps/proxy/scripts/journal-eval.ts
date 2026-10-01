/**
 * Phase 5 baseline: runs data/journal-eval/entries.v1.json through a LIVE
 * proxy (real model) and writes docs/journal-eval.md with the raw and
 * validated results plus a blank verdict per correction for a human to fill
 * in. Re-run after any prompt change and diff the result.
 *
 *   pnpm --filter @anan/proxy dev          # in one terminal (needs an API key)
 *   pnpm --filter @anan/proxy journal-eval # in another
 *
 * Env: PROXY_URL (default http://localhost:3002).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Lexicon,
  extractBrackets,
  validateJournalReview,
  JournalReviewSchema,
  type Word,
  type GrammarItem,
} from '@anan/core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const proxyUrl = process.env.PROXY_URL ?? 'http://localhost:3002';

interface Fixture {
  id: string;
  text: string;
  expect: string;
}
const fixtures = JSON.parse(
  readFileSync(path.join(root, 'data/journal-eval/entries.v1.json'), 'utf8'),
) as {
  learnerLevel: 'L2';
  entries: Fixture[];
};
const lexFile = JSON.parse(readFileSync(path.join(root, 'data/build/lexicon.v1.json'), 'utf8')) as {
  words: Word[];
  grammar: GrammarItem[];
};
const lexicon = new Lexicon(lexFile.words, lexFile.grammar);

const lines: string[] = [
  '# Journal review eval',
  '',
  `Generated ${new Date().toISOString()} against ${proxyUrl} (prompt journal-review.v1).`,
  '',
  'Baseline for prompt changes (phase doc 05). Each correction needs a human verdict:',
  '**✅ good**, **⚠️ acceptable but wrong type/explanation**, or **❌ wrong/harmful**. Replace the `_pending_` markers.',
  '',
];

for (const f of fixtures.entries) {
  const gaps = extractBrackets(f.text);
  const res = await fetch(`${proxyUrl}/v1/journal-review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-install-id': 'journal-eval' },
    body: JSON.stringify({
      text: f.text,
      learnerLevel: fixtures.learnerLevel,
      promptWords: [],
      recurringPatterns: [],
      maxIssues: 3,
    }),
  });
  lines.push(`## ${f.id}`, '', `> ${f.text}`, '', `Expected: ${f.expect}`, '');
  if (!res.ok) {
    lines.push(`Request failed: HTTP ${res.status}`, '');
    continue;
  }
  const raw = JournalReviewSchema.parse(await res.json());
  const { review, rejected } = validateJournalReview(raw, {
    lexicon,
    text: f.text,
    bracketRanges: gaps.map((g): [number, number] => [g.start, g.end]),
  });
  lines.push(
    `Model returned ${raw.issues.length} issue(s); ${review.issues.length} kept after validation.`,
    '',
  );
  if (review.issues.length === 0) lines.push('- _no corrections_ — verdict: _pending_');
  for (const i of review.issues) {
    lines.push(
      `- \`${f.text.slice(i.span[0], i.span[1])}\` → **${i.correction}** (${i.type}, ${i.confidence}${i.pattern ? `, ${i.pattern}` : ''}) — ${i.explanationEn}  `,
      '  Verdict: _pending_',
    );
  }
  if (review.natural_rewrite)
    lines.push('', `Natural rewrite: ${review.natural_rewrite}  `, 'Verdict: _pending_');
  if (review.brackets.length)
    lines.push(
      '',
      `Brackets: ${review.brackets.map((b) => `${b.en}→${b.zh}`).join(', ')}  `,
      'Verdict: _pending_',
    );
  if (rejected.length)
    lines.push(
      '',
      `Rejected by validation: ${rejected.map((r) => `${r.what} (${r.reason})`).join('; ')}`,
    );
  lines.push('');
}

writeFileSync(path.join(root, 'docs/journal-eval.md'), lines.join('\n'));
console.log('wrote docs/journal-eval.md');
