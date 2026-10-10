/**
 * Phase 25 Part D: one-time naturalness pass over the curriculum. Every textbook sentence
 * (grammar examples are sentence-bank ids, so they are included) and every journal prompt model
 * answer goes to the independent Gemini checker (a fresh call with no other context), 50 lines per
 * request. Results are cached in data/curriculum/naturalness-cache.json keyed by the text (with the
 * model that checked each line), so a rerun only checks new or changed lines and a stopped run
 * resumes.
 *
 *   pnpm --filter @anan/proxy naturalness                 # the checker chain (GEMINI_CHAIN_CHECK)
 *   pnpm --filter @anan/proxy naturalness --status        # counts done and left, no calls
 *   pnpm --filter @anan/proxy naturalness --model gemini-2.5-flash-lite --max-calls 5
 *   GEMINI_MODEL_CHECK=<model with quota> pnpm --filter @anan/proxy naturalness
 *
 * Phase 33: the calls go through the proxy's model chain and quota tracker as batch requests (the
 * live app keeps its reserve). When the free quota is used up on every model it stops at once,
 * saves, prints when the quota resets, and exits 0.
 *
 * Writes docs/curriculum-naturalness.md: the flagged lines with the checker's reason and
 * suggested rewrite. Rewrites are applied by hand in data/curriculum/laixue-N/content, then the
 * content is rebuilt. `--dry` writes the doc marked as a DRY RUN without calling anything.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NATURALNESS_BATCH,
  naturalnessRequest,
  naturalnessStatus,
  runNaturalness,
  type NatCache as Cache,
  type NatLine as Line,
} from '../src/naturalness.js';
import { geminiForScript, modelFlag } from '../src/script-gemini.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const num = (flag: string) => {
  const at = argv.indexOf(flag);
  const n = at >= 0 ? Number(argv[at + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};
const BATCH = num('--batch') ?? NATURALNESS_BATCH;
const cacheFile = path.join(root, 'data/curriculum/naturalness-cache.json');
const docFile = path.join(root, 'docs/curriculum-naturalness.md');

function collect(): Line[] {
  const out: Line[] = [];
  for (const n of [1, 2, 3, 4]) {
    const s = JSON.parse(readFileSync(path.join(root, `data/build/sentences.textbook-laixue-${n}.json`), 'utf8')) as {
      sentences: Array<{ id: string; zh: string; en?: string }>;
    };
    for (const x of s.sentences) out.push({ id: x.id, zh: x.zh, en: x.en, kind: 'sentence' });
    const b = JSON.parse(readFileSync(path.join(root, `apps/web/public/textbook/laixue-${n}/book.json`), 'utf8')) as {
      textbook: { lessons: Array<{ journalPrompts?: Array<{ id: string; promptZh?: string; promptEn: string }> }> };
    };
    for (const l of b.textbook.lessons)
      for (const p of l.journalPrompts ?? [])
        if (p.promptZh) out.push({ id: p.id, zh: p.promptZh, en: p.promptEn, kind: 'prompt-model' });
  }
  return out;
}

function render(lines: Line[], cache: Cache, note: string): string {
  const flagged = lines.filter((l) => cache[l.zh] && !cache[l.zh]!.natural);
  const checked = lines.filter((l) => cache[l.zh]).length;
  const rows = flagged.map(
    (l) =>
      `| ${l.id} | ${l.zh} | ${cache[l.zh]!.reason.replace(/\|/g, '/')} | ${cache[l.zh]!.rewrite} | ${cache[l.zh]!.model ?? ''} |`,
  );
  return [
    '## Naturalness pass',
    '',
    note,
    '',
    `Lines: ${lines.length} (sentences and grammar examples ${lines.filter((l) => l.kind === 'sentence').length}, prompt model answers ${lines.filter((l) => l.kind === 'prompt-model').length}). Checked: ${checked}. Flagged: ${flagged.length}.`,
    '',
    ...(rows.length ? ['| id | line | reason | suggested rewrite | checked by |', '|---|---|---|---|---|', ...rows] : []),
    '',
  ].join('\n');
}

async function main() {
  const lines = collect();
  const cache: Cache = existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, 'utf8')) as Cache) : {};
  if (dry) {
    writeFileSync(
      docFile,
      render(
        lines,
        cache,
        '**DRY RUN.** No Gemini key was available where this was built, so no line has been checked yet. ' +
          'Run `GEMINI_API_KEY=… pnpm --filter @anan/proxy naturalness` to check every line with the independent checker.',
      ),
    );
    console.log(`dry run: ${lines.length} lines collected, doc written`);
    return;
  }
  if (argv.includes('--status')) {
    console.log(naturalnessStatus(lines, cache, BATCH));
    return;
  }
  const gemini = geminiForScript({ role: 'check', ...(modelFlag(argv) ? { model: modelFlag(argv)! } : {}) });
  console.log(`Checking with ${gemini.chain.join(' → ')} (models out of free quota are skipped)`);
  const maxCalls = num('--max-calls');
  const result = await runNaturalness(
    lines,
    cache,
    {
      check: async (batch) => {
        const r = await gemini.run(naturalnessRequest(batch));
        return { results: r.response.results, model: r.model };
      },
      saveCache: (c) => writeFileSync(cacheFile, JSON.stringify(c, null, 1)),
      log: (line) => console.log(line),
      now: () => new Date(),
    },
    { batch: BATCH, ...(maxCalls ? { maxCalls } : {}) },
  );
  const models = [...new Set(lines.flatMap((l) => cache[l.zh]?.model ?? []))];
  writeFileSync(
    docFile,
    render(
      lines,
      cache,
      `Checked by ${models.map((m) => `\`${m}\``).join(', ') || 'the checker'} (independent call, no other context; the model per line is in the table).` +
        (result.checked < result.total ? ` **Not finished:** ${result.total - result.checked} lines still to check; run the same command again.` : ''),
    ),
  );
  console.log(`wrote ${path.relative(root, docFile)}`);
}

await main();
