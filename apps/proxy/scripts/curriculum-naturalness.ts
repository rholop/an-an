/**
 * Phase 25 Part D: one-time naturalness pass over the curriculum. Every textbook sentence
 * (grammar examples are sentence-bank ids, so they are included) and every journal prompt model
 * answer goes to the independent Gemini checker (GEMINI_MODEL_CHECK, a fresh call with no other
 * context) in batches. Results are cached in data/curriculum/naturalness-cache.json keyed by the
 * text, so a rerun only checks new or changed lines and an interrupted run resumes.
 *
 *   GEMINI_API_KEY=… pnpm --filter @anan/proxy naturalness
 *
 * Writes docs/curriculum-naturalness.md: the flagged lines with the checker's reason and
 * suggested rewrite. Rewrites are applied by hand in data/curriculum/laixue-N/content, then the
 * content is rebuilt. `--dry` writes the doc marked as a DRY RUN without calling anything.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dry = process.argv.includes('--dry');
const BATCH = 25;
const cacheFile = path.join(root, 'data/curriculum/naturalness-cache.json');
const docFile = path.join(root, 'docs/curriculum-naturalness.md');

interface Line {
  id: string;
  zh: string;
  en?: string;
  kind: 'sentence' | 'prompt-model';
}

const Verdict = z.object({
  id: z.string(),
  natural: z.boolean(),
  reason: z.string().default(''),
  rewrite: z.string().default(''),
});
const Reply = z.object({ results: z.array(Verdict) });
type VerdictT = z.infer<typeof Verdict>;
type Cache = Record<string, Omit<VerdictT, 'id'>>;

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

const PROMPT = `You are a native speaker of Taiwan Mandarin checking sentences for a beginner textbook course.
For each line, decide whether a Taiwanese speaker would naturally say or write it (traditional characters,
Taiwan vocabulary and usage). Simple is fine; flag only lines that are ungrammatical, unidiomatic, mainland
usage, or that do not mean the English given. For a flagged line give a short reason in English and a
natural rewrite that keeps the same words where possible. Reply as JSON:
{"results":[{"id":"…","natural":true|false,"reason":"…","rewrite":"…"}]} with one result per input id.`;

async function checkBatch(model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>, lines: Line[]) {
  const input = lines.map((l) => ({ id: l.id, zh: l.zh, en: l.en ?? '' }));
  const res = await model.generateContent(`${PROMPT}\n\nLines:\n${JSON.stringify(input)}`);
  return Reply.parse(JSON.parse(res.response.text())).results;
}

function render(lines: Line[], cache: Cache, note: string): string {
  const flagged = lines.filter((l) => cache[l.zh] && !cache[l.zh]!.natural);
  const checked = lines.filter((l) => cache[l.zh]).length;
  const rows = flagged.map(
    (l) => `| ${l.id} | ${l.zh} | ${cache[l.zh]!.reason.replace(/\|/g, '/')} | ${cache[l.zh]!.rewrite} |`,
  );
  return [
    '## Naturalness pass',
    '',
    note,
    '',
    `Lines: ${lines.length} (sentences and grammar examples ${lines.filter((l) => l.kind === 'sentence').length}, prompt model answers ${lines.filter((l) => l.kind === 'prompt-model').length}). Checked: ${checked}. Flagged: ${flagged.length}.`,
    '',
    ...(rows.length ? ['| id | line | reason | suggested rewrite |', '|---|---|---|---|', ...rows] : []),
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
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set (use --dry for a dry run)');
  const modelName = process.env.GEMINI_MODEL_CHECK ?? 'gemini-2.5-flash';
  const model = new GoogleGenerativeAI(key).getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });
  const todo = [...new Map(lines.filter((l) => !cache[l.zh]).map((l) => [l.zh, l])).values()];
  console.log(`${lines.length} lines, ${todo.length} to check with ${modelName}`);
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const results = await checkBatch(model, batch);
      for (const r of results) {
        const l = batch.find((x) => x.id === r.id);
        if (l) cache[l.zh] = { natural: r.natural, reason: r.reason, rewrite: r.rewrite };
      }
      writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
      console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
    } catch (e) {
      console.error(`  batch at ${i} failed, rerun to resume: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  writeFileSync(docFile, render(lines, cache, `Checked by \`${modelName}\` (independent call, no other context).`));
  console.log(`wrote ${path.relative(root, docFile)}`);
}

await main();
