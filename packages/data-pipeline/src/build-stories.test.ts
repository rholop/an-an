import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dryStory, dryStoryCheck, dryStoryRepair, LessonStoriesFileSchema, type StoryRequest, type Textbook } from '@anan/core';
import { buildStories, lessonStoryLadder, parseArgs, retryAfterMs, type BuildDeps } from './build-stories.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const book1 = (JSON.parse(readFileSync(path.join(REPO, 'data/curriculum/laixue-1/book.json'), 'utf8')) as { textbook: Textbook }).textbook;

describe('Phase 26 Part E: lesson stories use only this lesson, the lessons before and the gate', () => {
  it('book 1 lesson 4: lesson 3 words are known, lesson 4 words are rung 2, lesson 5 words are outside', () => {
    const [l3, l4, l5] = [3, 4, 5].map((n) => book1.lessons.find((l) => l.n === n)!);
    const { ladder, level } = lessonStoryLadder('laixue-1', l4!.id);
    expect(level).toBe('N1');
    const only = (ids: string[], other: string[]) => ids.filter((id) => !other.includes(id));
    expect(ladder.rung(only(l3!.vocab, l4!.vocab)[0]!)).toBe(1);
    expect(ladder.rung(only(l4!.vocab, l3!.vocab)[0]!)).toBe(2);
    const later = only(l5!.vocab, [...l3!.vocab, ...l4!.vocab, ...book1.lessons.filter((l) => l.n < 4).flatMap((l) => l.vocab)]);
    expect(ladder.rung(later[0]!)).toBe(6);
    expect([...ladder.ids[3], ...ladder.ids[4], ...ladder.ids[5]]).toEqual([]);
  });
});

// ---- Phase 30 Part B.1: safe to rerun, steerable, stops cleanly on the free quota ----

/** A stand-in proxy: the offline writer's answers, or 429s once `limitAfter` calls are spent. */
function fakeProxy(opts: { limitAfter?: number; retryAfter?: string } = {}) {
  const calls: string[] = [];
  const fetchFn = (async (url: string, init: { body: string }) => {
    calls.push(url);
    if (opts.limitAfter !== undefined && calls.length > opts.limitAfter)
      return new Response(JSON.stringify({ error: 'rate limited, please retry shortly' }), {
        status: 429,
        headers: opts.retryAfter ? { 'retry-after': opts.retryAfter } : {},
      });
    const body = JSON.parse(init.body) as StoryRequest;
    const route = url.replace(/^.*\/v1\//, '');
    const out =
      route === 'story' ? dryStory(body) : route === 'story-check' ? dryStoryCheck(body as never) : dryStoryRepair(body as never);
    return new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function deps(root: string, fetchFn: typeof fetch, sleeps: number[] = []): BuildDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    fetch: fetchFn,
    sleep: async (ms) => void sleeps.push(ms),
    log: (l) => lines.push(l),
    tick: () => undefined,
    confirm: async () => false,
    root,
    proxyUrl: 'http://proxy.test',
    siteCode: 'x',
    now: () => new Date('2026-10-09T12:00:00Z'),
  };
}
const fileOf = (root: string, book = 'laixue-1') => path.join(root, 'data/curriculum', book, 'private', 'stories.json');
const storiesIn = (root: string, book = 'laixue-1') =>
  (JSON.parse(readFileSync(fileOf(root, book), 'utf8')) as { stories: { id: string; lessonId: string }[] }).stories;

describe('Phase 30 Part B.1: stories:build is safe to rerun', { timeout: 120_000 }, () => {
  it('parses the options', () => {
    expect(parseArgs(['--book', 'laixue-2,laixue-3', '--from', 'laixue-2-L02', '--max-calls', '20', '--per-lesson', '1'])).toMatchObject({
      books: ['laixue-2', 'laixue-3'],
      from: 'laixue-2-L02',
      maxCalls: 20,
      perLesson: 1,
      status: false,
    });
    expect(() => parseArgs(['--max-calls', 'lots'])).toThrow(/whole number/);
    expect(retryAfterMs('7', null)).toBe(7000);
    expect(retryAfterMs(null, { retryAfterMs: 1500 })).toBe(1500);
    expect(retryAfterMs('Fri, 09 Oct 2026 12:00:30 GMT', null, Date.parse('2026-10-09T12:00:00Z'))).toBe(30_000);
  });

  it('three rate limits in a row stop cleanly, keep every saved story, and a rerun continues at the right lesson', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'stories-'));
    // lesson 1 gets its 3 stories (3 calls each: write, check, …), then the quota runs out
    const first = fakeProxy({ limitAfter: 6, retryAfter: '2' });
    const sleeps: number[] = [];
    const d1 = deps(root, first.fetchFn, sleeps);
    const r1 = await buildStories(parseArgs(['--book', 'laixue-1', '--delay', '0']), d1);
    expect(r1.stopped).toBe('quota');
    const saved = storiesIn(root);
    expect(saved.length).toBeGreaterThan(0);
    expect(r1.resumeAt).toBeDefined();
    expect(sleeps.filter((ms) => ms === 2000)).toHaveLength(2); // retry-after honoured, then stop on the third
    expect(d1.lines.join('\n')).toMatch(/Free quota used up for now\. Saved so far: \d+ stories\. Run the same command later to continue from laixue-1-L0\d\./);
    // a rate limit is never a refused attempt
    expect(r1.failed).toBe(0);

    const second = fakeProxy();
    const r2 = await buildStories(parseArgs(['--book', 'laixue-1', '--delay', '0', '--max-calls', '4']), deps(root, second.fetchFn));
    expect(r2.stopped).toBe('max-calls');
    expect(second.calls.length).toBeLessThanOrEqual(4);
    const after = storiesIn(root);
    // everything saved before is still there, unchanged, and the new story is for the lesson it stopped at
    expect(after.slice(0, saved.length)).toEqual(saved);
    expect(after.slice(saved.length).every((s) => s.lessonId === r1.resumeAt)).toBe(true);
  });

  it('--status makes no model calls; a rerun with nothing to do leaves the file byte-identical', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'stories-'));
    const proxy = fakeProxy();
    await buildStories(parseArgs(['--book', 'laixue-1', '--lesson', '1', '--delay', '0']), deps(root, proxy.fetchFn));
    const before = readFileSync(fileOf(root));
    const noCalls = (async () => {
      throw new Error('no model calls allowed');
    }) as unknown as typeof fetch;
    const status = deps(root, noCalls);
    await buildStories(parseArgs(['--status']), status);
    expect(status.lines).toContain('  laixue-1-L01 3/3');
    expect(status.lines).toContain('  laixue-2-L02 0/3');
    const rerun = deps(root, noCalls);
    const r = await buildStories(parseArgs(['--book', 'laixue-1', '--lesson', '1']), rerun);
    expect(r.written).toBe(0);
    expect(rerun.lines[0]).toBe('Resuming: 1 of 1 lessons already have 3 stories and will be skipped. Existing stories are never overwritten.');
    expect(readFileSync(fileOf(root)).equals(before)).toBe(true);
  });

  it('a saved story whose questions were all dropped still loads; a broken file is reported, never rewritten', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'stories-'));
    const proxy = fakeProxy();
    await buildStories(parseArgs(['--book', 'laixue-1', '--lesson', '1', '--delay', '0']), deps(root, proxy.fetchFn));
    // The independent check can disagree with every question: the story is kept with none
    const file = JSON.parse(readFileSync(fileOf(root), 'utf8')) as { stories: { story: { questions: unknown[] } }[] };
    file.stories[0]!.story.questions = [];
    writeFileSync(fileOf(root), JSON.stringify(file));
    const noCalls = (async () => {
      throw new Error('no model calls allowed');
    }) as unknown as typeof fetch;
    const status = deps(root, noCalls);
    await buildStories(parseArgs(['--status']), status);
    expect(status.lines).toContain('  laixue-1-L01 3/3');
    expect(LessonStoriesFileSchema.safeParse(file).success).toBe(true);

    file.stories[1]!.story.questions = 'none' as never;
    writeFileSync(fileOf(root), JSON.stringify(file));
    const before = readFileSync(fileOf(root));
    await expect(buildStories(parseArgs(['--book', 'laixue-1', '--lesson', '1']), deps(root, noCalls))).rejects.toThrow(
      /does not match the stories format \(nothing was changed\):\n {2}stories 1: story\.questions/,
    );
    expect(readFileSync(fileOf(root)).equals(before)).toBe(true);
  });

  it('--redo asks first, backs up the file, and only then replaces that lesson', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'stories-'));
    const proxy = fakeProxy();
    await buildStories(parseArgs(['--book', 'laixue-1', '--lesson', '1', '--delay', '0']), deps(root, proxy.fetchFn));
    const before = readFileSync(fileOf(root));
    const declined = await buildStories(parseArgs(['--redo', 'laixue-1-L01']), deps(root, proxy.fetchFn));
    expect(declined.written).toBe(0);
    expect(readFileSync(fileOf(root)).equals(before)).toBe(true);
    const r = await buildStories(parseArgs(['--redo', 'laixue-1-L01', '--yes', '--delay', '0']), deps(root, proxy.fetchFn));
    expect(r.written).toBe(3);
    const dir = path.dirname(fileOf(root));
    const backups = readdirSync(dir).filter((f) => /^stories\.\d{8}-\d{4}\.bak\.json$/.test(f));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dir, backups[0]!)).equals(before)).toBe(true);
    expect(existsSync(fileOf(root))).toBe(true);
  });
});
