#!/usr/bin/env tsx
/**
 * Phase 25 D: `pnpm audit:curriculum`. Checks the lexicon entries, sentences, scenario lines,
 * prompts and grammar exercises of every textbook lesson (lib/curriculum/audit.ts), writes
 * docs/curriculum-audit.md and exits non-zero on any finding. Runs in CI.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAuditReport, runCurriculumAudit } from './lib/curriculum/audit.js';
import { loadAuditInputs } from './lib/curriculum/audit-inputs.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function main(): void {
  const result = runCurriculumAudit(loadAuditInputs(REPO));

  const naturalnessFile = path.join(REPO, 'docs/curriculum-naturalness.md');
  const naturalness = existsSync(naturalnessFile) ? readFileSync(naturalnessFile, 'utf8') : undefined;
  const date = new Date().toISOString().slice(0, 10);
  if (!process.argv.includes('--no-write'))
    writeFileSync(path.join(REPO, 'docs/curriculum-audit.md'), renderAuditReport(result, date, naturalness) + '\n', 'utf8');

  const byCheck = new Map<string, number>();
  for (const f of result.findings) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
  console.log(`Checked ${result.stats.words} words, ${result.stats.sentences} sentences, ${result.stats.texts} other lines, ${result.stats.grammarPoints} grammar points.`);
  for (const [c, n] of byCheck) console.log(`  ${c}: ${n}`);
  for (const f of result.findings.slice(0, Number(process.env.AUDIT_SHOW ?? 40))) console.log(`  - [${f.check}] ${f.where}: ${f.detail}`);
  for (const a of result.staleAllows) console.log(`  - stale allow (matches nothing): [${a.check}] ${a.where}`);
  if (result.findings.length || result.staleAllows.length) {
    console.error(`\nCurriculum audit failed: ${result.findings.length} finding(s). See docs/curriculum-audit.md.`);
    process.exit(1);
  }
  console.log('Curriculum audit passed.');
}

main();
