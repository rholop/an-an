import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Phase 29 Part C.2 acceptance: the `anan/progress-from-ledger` lint rule (eslint-rules/) fails on
 * a planted "due" check in the web app and in core outside progress/, and on day maths and
 * threshold numbers; the ledger itself (core/progress) may read cards. The planted files live in
 * `test-fixtures/` folders, which `pnpm lint` skips and this test lints on purpose.
 */
const REPO = path.resolve(__dirname, '../../..');
const eslint = new ESLint({ cwd: REPO, ignore: false });

async function ruleHits(rel: string): Promise<string[]> {
  const [result] = await eslint.lintFiles([path.join(REPO, rel)]);
  const fatal = (result?.messages ?? []).filter((m) => m.fatal);
  expect(fatal).toEqual([]);
  return (result?.messages ?? []).filter((m) => m.ruleId === 'anan/progress-from-ledger').map((m) => m.message);
}

// typed linting builds a TypeScript program first: allow it time on a slow CI runner
describe('the progress lint rule (Phase 29)', { timeout: 120_000 }, () => {
  it('fails on a planted `card.due <= now` in lib/', async () => {
    const hits = await ruleHits('apps/web/src/lib/test-fixtures/planted-due.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/Don't read `due` of a Card/);
  });

  it('fails on a planted `card.due <= now` in core/game/', async () => {
    expect(await ruleHits('packages/core/src/game/test-fixtures/planted-due.ts')).toHaveLength(1);
  });

  it("fails on a SkillCard's own state and reps, also through Pick<>", async () => {
    expect(await ruleHits('apps/web/src/lib/test-fixtures/planted-state.ts')).toHaveLength(2);
  });

  it('fails on day maths in the device time zone and on threshold numbers', async () => {
    expect(await ruleHits('apps/web/src/lib/test-fixtures/planted-days.ts')).toHaveLength(4);
  });

  it('allows the ledger itself, plain objects with a `state`, and writes', async () => {
    expect(await ruleHits('packages/core/src/progress/test-fixtures/planted-ok.ts')).toEqual([]);
    expect(await ruleHits('apps/web/src/lib/test-fixtures/planted-ok.ts')).toEqual([]);
  });
});
