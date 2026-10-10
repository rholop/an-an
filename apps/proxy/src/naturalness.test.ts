import { describe, expect, it } from 'vitest';
import { FakeJsonAdapter } from './providers/fake.js';
import { QuotaExhaustedError, ProviderRetryableError, type JsonTaskRequest } from './providers/types.js';
import { linesToCheck, naturalnessRequest, naturalnessStatus, runNaturalness, type NatCache, type NatLine } from './naturalness.js';
import { QuotaTracker } from './quota.js';
import { geminiForScript } from './script-gemini.js';
import { loadEnv } from './env.js';

/** Phase 33 Part B: the naturalness pass on a daily-quota 429 (fixture lines, no network). */
const lines: NatLine[] = Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, zh: `句子${i}。`, en: `Sentence ${i}.`, kind: 'sentence' }));
const NOW = new Date('2026-10-10T16:53:00Z'); // 12:53 in New York
const RESET = new Date('2026-10-11T07:00:00Z'); // midnight Pacific = 03:00 New York

function deps(check: (batch: NatLine[]) => Promise<{ results: Array<{ id: string; natural: boolean; reason: string; rewrite: string }>; model: string }>) {
  const log: string[] = [];
  const asked: string[][] = [];
  let saves = 0;
  return {
    log,
    asked,
    saves: () => saves,
    deps: {
      check: async (batch: NatLine[]) => {
        asked.push(batch.map((l) => l.id));
        return check(batch);
      },
      saveCache: () => {
        saves++;
      },
      log: (line: string) => log.push(line),
      now: () => NOW,
    },
  };
}
const allNatural = (model = 'gemini-a') => async (batch: NatLine[]) => ({
  results: batch.map((l) => ({ id: l.id, natural: true, reason: '', rewrite: '' })),
  model,
});

describe('naturalness pass (Phase 33)', () => {
  it('stops after the first daily-quota batch, prints the resume message, and a rerun starts from the first unchecked line', async () => {
    const cache: NatCache = {};
    let n = 0;
    const run1 = deps(async (batch) => {
      if (n++ === 0) return allNatural()(batch);
      throw new QuotaExhaustedError(RESET, [{ model: 'gemini-a', reason: 'quota' }]);
    });
    const r1 = await runNaturalness(lines, cache, run1.deps);
    expect(r1).toMatchObject({ stopped: 'quota', checked: 50, total: 120, calls: 1 });
    // two requests: the batch that worked and the one that hit the quota; nothing after it
    expect(run1.asked).toHaveLength(2);
    expect(run1.saves()).toBeGreaterThanOrEqual(2);
    expect(run1.log.at(-1)).toBe(
      'Free quota used up. Checked 50 of 120 lines; the rest resumes from here. Quota resets at about 03:00 (in 14 h). Run the same command again then.',
    );
    expect(run1.log.filter((l) => /failed/.test(l))).toEqual([]);
    expect(cache['句子0。']).toMatchObject({ natural: true, model: 'gemini-a' });

    const run2 = deps(allNatural('gemini-b'));
    const r2 = await runNaturalness(lines, cache, run2.deps);
    expect(run2.asked[0]![0]).toBe('s50');
    expect(r2).toMatchObject({ checked: 120, calls: 2 });
    expect(r2.stopped).toBeUndefined();
    expect(cache['句子119。']!.model).toBe('gemini-b');
  });

  it('packs 50 lines per request and checks only lines not in the cache', async () => {
    const cache: NatCache = { '句子0。': { natural: true, reason: '', rewrite: '' } };
    expect(linesToCheck(lines, cache)).toHaveLength(119);
    const run = deps(allNatural());
    await runNaturalness(lines, cache, run.deps);
    expect(run.asked.map((b) => b.length)).toEqual([50, 50, 19]);
    expect(naturalnessStatus(lines, cache)).toBe('120 lines: 120 checked (unknown 1, gemini-a 119), 0 distinct left (0 requests of 50).');
  });

  it('--max-calls stops after N requests; other failures stop after 3 in a row', async () => {
    const run = deps(allNatural());
    expect(await runNaturalness(lines, {}, run.deps, { maxCalls: 1 })).toMatchObject({ stopped: 'max-calls', checked: 50 });
    const failing = deps(async () => {
      throw new Error('server error');
    });
    expect(await runNaturalness(lines, {}, failing.deps, { batch: 10 })).toMatchObject({ stopped: 'failures', calls: 3 });
  });

  it('through geminiForScript: the owner’s daily 429 on every model ends the run cleanly', async () => {
    const quota = new QuotaTracker({ now: () => NOW });
    const out = (model: string) =>
      Object.assign(
        new FakeJsonAdapter(model, { kind: 'success', respond: () => ({}) }),
        {
          generateJson: async (_req: JsonTaskRequest<unknown>) => {
            throw new ProviderRetryableError('Gemini quota', 'quota', 50_850_000, 20);
          },
        },
      );
    const g = geminiForScript({ role: 'check', env: loadEnv({ GEMINI_CHAIN_CHECK: 'gemini-a,gemini-b' }), adapter: out, quota });
    expect(g.chain).toEqual(['gemini-a', 'gemini-b']);
    const run = deps(async (batch) => {
      const r = await g.run(naturalnessRequest(batch));
      return { results: r.response.results, model: r.model };
    });
    const res = await runNaturalness(lines, {}, run.deps);
    expect(res).toMatchObject({ stopped: 'quota', checked: 0, calls: 0 });
    expect(run.log.at(-1)).toMatch(/^Free quota used up\. Checked 0 of 120 lines;.*Quota resets at about 03:00/);
  });
});
