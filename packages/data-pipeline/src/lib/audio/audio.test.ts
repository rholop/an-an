import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIO_VOICES, buildFixtureLexiconForTests } from './test-support.js';
import { buildAudio, fixFlagged, fixSuspect, loadManifest, suspectsToFix } from './build.js';
import { recognisedMatches } from './compare.js';
import { loadLessonSentences, sentenceJobs, wordJobs } from './inputs.js';
import { renderReviewReport } from './report.js';
import type { SpeechClient } from './azure.js';
import { Lexicon, type SentenceBankEntry, type Word } from '@anan/core';

class FakeClient implements SpeechClient {
  usage = { billedChars: 0, ttsCalls: 0, sttCalls: 0 };
  /** ssml substring -> what STT "hears" (default: the text itself). */
  deaf = new Map<string, string>();
  voicesSeen: string[] = [];
  async synthesize(ssml: string) {
    this.usage.ttsCalls++;
    this.usage.billedChars += ssml.length;
    this.voicesSeen.push(/voice name="([^"]+)"/.exec(ssml)![1]!);
    return Buffer.from(ssml);
  }
  async transcribe(ssml: string) {
    this.usage.sttCalls++;
    for (const [k, v] of this.deaf) if (ssml.includes(k)) return v;
    return ssml.replace(/<[^>]*>/g, '');
  }
}

const sentence = (id: string, zh: string): SentenceBankEntry => ({
  id,
  zh,
  en: '',
  targetWordId: 'x',
  level: 'N1',
  tokens: [],
  source: 'generated',
  doubtful: false,
});

let dir: string;
beforeEach(() => void (dir = mkdtempSync(path.join(tmpdir(), 'audio-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lex = buildFixtureLexiconForTests();
const V = AUDIO_VOICES.female;
const base = () => ({ outDir: dir, voice: V, now: new Date('2026-01-01') });

describe('recognisedMatches', () => {
  it('ignores punctuation and spacing, catches different words', () => {
    expect(recognisedMatches('你好', '你好。')).toBe(true);
    expect(recognisedMatches('我有三個', '我有 3 個')).toBe(true);
    expect(recognisedMatches('垃圾', '樂色')).toBe(false);
    expect(recognisedMatches('好', '')).toBe(false);
  });
});

describe('buildAudio', () => {
  const jobs = () => [
    ...wordJobs(lex, ['N1']).jobs.slice(0, 5),
    ...sentenceJobs(lex, [sentence('s1', '你好'), sentence('s2', '我不是在銀行')]).jobs,
  ];

  it('makes clips, records auto_ok, and a rebuild with no changes makes zero calls', async () => {
    const client = new FakeClient();
    const first = await buildAudio(jobs(), { ...base(), client });
    expect(first.made).toBe(7);
    expect(Object.values(first.manifest.words).every((e) => e.status === 'auto_ok')).toBe(true);
    expect(existsSync(path.join(dir, first.manifest.sentences.s1!.file))).toBe(true);

    const second = new FakeClient();
    const again = await buildAudio(jobs(), { ...base(), client: second });
    expect(again.made).toBe(0);
    expect(again.unchanged).toBe(7);
    expect(second.usage.ttsCalls + second.usage.sttCalls).toBe(0);
  });

  it('a clip STT disagrees with is suspect, kept out of the app, and listed in the report', async () => {
    const client = new FakeClient();
    client.deaf.set('你好', '尼好');
    const res = await buildAudio(jobs(), { ...base(), client });
    expect(res.manifest.sentences.s1!.status).toBe('suspect');
    expect(res.manifest.sentences.s1!.heard).toBe('尼好');
    const md = renderReviewReport(res.manifest, [{ kind: 'sentence', id: 's9', text: '他長', reason: 'reading not certain for: 長' }]);
    expect(md).toContain('“你好”');
    expect(md).toContain('heard “尼好”');
    expect(md).toContain('reading not certain for: 長');
  });

  it('stops cleanly at the character budget and resumes next run', async () => {
    const client = new FakeClient();
    const res = await buildAudio(jobs(), { ...base(), client, maxChars: 1 });
    expect(res.stoppedEarly).toMatch(/budget/);
    expect(res.made).toBe(1);
    const resumed = await buildAudio(jobs(), { ...base(), client: new FakeClient() });
    expect(resumed.unchanged).toBe(1);
    expect(resumed.made).toBe(6);
  });

  it('only changed SSML is regenerated', async () => {
    await buildAudio(jobs(), { ...base(), client: new FakeClient() });
    const male = new FakeClient();
    const res = await buildAudio(jobs(), { ...base(), voice: AUDIO_VOICES.male, client: male });
    expect(res.made).toBe(7); // a different voice is different SSML for every clip
  });
});

describe('sentenceJobs', () => {
  it('lists sentences whose heteronym reading is uncertain instead of making audio', () => {
    const { jobs, skipped } = sentenceJobs(lex, [sentence('a', '他長'), sentence('b', '你好')]);
    expect(jobs.map((j) => j.id)).toEqual(['b']);
    expect(skipped).toEqual([{ kind: 'sentence', id: 'a', text: '他長', reason: expect.stringContaining('長') }]);
  });
});

describe('fixFlagged', () => {
  it('regenerates with the other voice, returns to auto_ok, and a plain rebuild leaves it', async () => {
    const jobs = wordJobs(lex, ['N1']).jobs.slice(0, 3);
    await buildAudio(jobs, { ...base(), client: new FakeClient() });
    const before = loadManifest(path.join(dir, 'manifest.json'), new Date(), V);
    const target = jobs[1]!;
    const prev = before.words[target.id]!;

    const client = new FakeClient();
    const res = await fixFlagged(jobs, { [`word:${target.id}`]: { status: 'flagged', hash: prev.hash } }, { ...base(), client });
    expect(res.fixed).toEqual([`word:${target.id}`]);
    expect(client.voicesSeen[0]).toBe(AUDIO_VOICES.male);
    const after = loadManifest(path.join(dir, 'manifest.json'), new Date(), V);
    expect(after.words[target.id]).toMatchObject({ status: 'auto_ok', voice: AUDIO_VOICES.male, fixed: true });
    expect(after.words[target.id]!.hash).not.toBe(prev.hash); // so the old flag no longer applies

    const again = new FakeClient();
    const rebuilt = await buildAudio(jobs, { ...base(), client: again });
    expect(rebuilt.made).toBe(0);
    expect(again.usage.ttsCalls).toBe(0);
  });

  it('falls through to explicit tags, and leaves the clip out if nothing passes', async () => {
    const jobs = wordJobs(lex, ['N1']).jobs.slice(0, 1);
    await buildAudio(jobs, { ...base(), client: new FakeClient() });
    const prev = loadManifest(path.join(dir, 'manifest.json'), new Date(), V).words[jobs[0]!.id]!;
    const client = new FakeClient();
    client.deaf.set(jobs[0]!.text, '???');
    const res = await fixFlagged(jobs, { [`word:${jobs[0]!.id}`]: { status: 'flagged', hash: prev.hash } }, { ...base(), client });
    expect(res.stillBad).toHaveLength(1);
    expect(client.usage.ttsCalls).toBeGreaterThanOrEqual(2);
    const after = loadManifest(path.join(dir, 'manifest.json'), new Date(), V);
    expect(after.words[jobs[0]!.id]!.status).toBe('suspect');
  });
});

/** STT mishears every clip `bad(ssml, spokenText)` returns true for. */
class PickyClient extends FakeClient {
  constructor(private bad: (ssml: string, spoken: string) => boolean) {
    super();
  }
  override async transcribe(ssml: string) {
    this.usage.sttCalls++;
    const spoken = ssml.replace(/<[^>]*>/g, '');
    return this.bad(ssml, spoken) ? '???' : spoken;
  }
}
const explicitTags = (ssml: string) => (ssml.match(/<phoneme/g) ?? []).length > 1;
const isMale = (ssml: string) => ssml.includes(AUDIO_VOICES.male);

describe('fixSuspect (Phase 35)', () => {
  const twoCharJobs = () => wordJobs(lex, ['N1']).jobs.filter((j) => [...j.text].length === 2 && j.buildSsml(V, true));
  const manifestNow = () => loadManifest(path.join(dir, 'manifest.json'), new Date(), V);
  /** Build 3 two-character words where the first one comes out suspect. */
  async function setup() {
    const jobs = twoCharJobs().slice(0, 3);
    expect(jobs).toHaveLength(3);
    const target = jobs[0]!;
    const maker = new FakeClient();
    maker.deaf.set(target.text, '???');
    await buildAudio(jobs, { ...base(), client: maker });
    const prev = manifestNow().words[target.id]!;
    expect(prev.status).toBe('suspect');
    return { jobs, target, prev };
  }

  it('a suspect fixed on attempt 2 (explicit readings) replaces the clip, auto_ok, fixed, named in the report', async () => {
    const { jobs, target, prev } = await setup();
    // the original voice without explicit tags, and the other voice, are still misheard
    const client = new PickyClient((ssml, spoken) => spoken === target.text && (isMale(ssml) || !explicitTags(ssml)));
    const res = await fixSuspect(jobs, { ...base(), client });
    expect(res.tried).toEqual([`word:${target.id}`]);
    expect(res.fixed).toEqual([`word:${target.id}`]);
    expect(client.usage.ttsCalls).toBe(2);
    const after = manifestNow().words[target.id]!;
    expect(after).toMatchObject({ status: 'auto_ok', fixed: true, fixedBy: 'explicit readings', voice: V, suspectHeard: '???' });
    expect(after.hash).not.toBe(prev.hash);
    const mp3 = readFileSync(path.join(dir, after.file), 'utf8');
    expect(explicitTags(mp3)).toBe(true); // the fake's mp3 is the SSML
    expect(existsSync(path.join(dir, `${after.file}.try0`))).toBe(false);
    expect(existsSync(path.join(dir, `${after.file}.try1`))).toBe(false);
    const md = renderReviewReport(manifestNow(), []);
    expect(md).toContain('Suspects fixed by --fix-suspect (1)');
    expect(md).toContain(`fixed by explicit readings (was heard “???”; other voice: “???”; explicit readings: “${target.text}”)`);
    // a plain rebuild leaves the fixed clip alone
    const again = new FakeClient();
    expect((await buildAudio(jobs, { ...base(), client: again })).made).toBe(0);
    expect(again.usage.ttsCalls).toBe(0);
  });

  it('a suspect no attempt fixes keeps its clip and status, records fixTried, and is skipped until --again', async () => {
    const { jobs, target, prev } = await setup();
    const before = readFileSync(path.join(dir, prev.file));
    const client = new PickyClient((_ssml, spoken) => spoken === target.text);
    const res = await fixSuspect(jobs, { ...base(), client, now: new Date('2026-10-10T12:00:00Z') });
    expect(res).toMatchObject({ fixed: [], stillSuspect: [`word:${target.id}`], stoppedEarly: null });
    expect(client.usage.ttsCalls).toBe(3);
    const after = manifestNow().words[target.id]!;
    expect(after).toMatchObject({ status: 'suspect', hash: prev.hash, voice: prev.voice, heard: prev.heard, fixTried: '2026-10-10T12:00:00.000Z' });
    expect(after.fixAttempts?.map((a) => a.attempt)).toEqual(['other voice', 'explicit readings', 'other voice + explicit readings']);
    expect(readFileSync(path.join(dir, prev.file))).toEqual(before);
    expect(renderReviewReport(manifestNow(), [])).toContain('--fix-suspect tried 2026-10-10, still suspect (other voice: “???”');

    const second = new PickyClient(() => true);
    const res2 = await fixSuspect(jobs, { ...base(), client: second });
    expect(res2.tried).toEqual([]);
    expect(second.usage.ttsCalls + second.usage.sttCalls).toBe(0);

    const third = new PickyClient(() => true);
    await fixSuspect(jobs, { ...base(), client: third, again: true });
    expect(third.usage.ttsCalls).toBe(3);
    // and a plain build doesn't re-make it either
    const plain = new FakeClient();
    expect((await buildAudio(jobs, { ...base(), client: plain })).made).toBe(0);
  });

  it('--max-chars stops mid-list and saves every finished fix', async () => {
    const jobs = twoCharJobs().slice(0, 3);
    const maker = new PickyClient(() => true);
    await buildAudio(jobs, { ...base(), client: maker });
    expect(suspectsToFix(jobs, manifestNow())).toHaveLength(3);
    const client = new FakeClient(); // the first attempt passes for everything
    const probe = new FakeClient();
    await probe.synthesize(jobs[0]!.buildSsml(AUDIO_VOICES.male, false)!);
    const res = await fixSuspect(jobs, { ...base(), client, maxChars: probe.usage.billedChars });
    expect(res.stoppedEarly).toMatch(/budget/);
    expect(res.fixed).toEqual([`word:${jobs[0]!.id}`]);
    const m = manifestNow();
    expect(m.words[jobs[0]!.id]).toMatchObject({ status: 'auto_ok', fixed: true });
    expect(m.words[jobs[1]!.id]).toMatchObject({ status: 'suspect' });
    expect(m.words[jobs[1]!.id]!.fixTried).toBeUndefined();
    expect(suspectsToFix(jobs, m)).toHaveLength(2);
  });
});

describe('wordJobs and textbook words (Phase 35)', () => {
  it('a textbook word rated L4 gets a job with the default levels; a plain L4 word does not', () => {
    const base0 = buildFixtureLexiconForTests().allWords();
    const pick = (hw: string) => base0.find((w) => w.headword === hw)!;
    const words: Word[] = [
      { ...pick('我們'), id: 'tb-l4', level: 'L4', tags: ['textbook:laixue-1', 'textbook:laixue-1:L04'] },
      { ...pick('沒有'), id: 'plain-l4', level: 'L4', tags: [] },
      { ...pick('你'), id: 'tb3-l3', level: 'L3', tags: ['textbook:laixue-3'] },
      { ...pick('他'), id: 'n1', level: 'N1', tags: [] },
    ];
    const res = wordJobs(new Lexicon(words, []), ['N1', 'N2', 'L1', 'L2']);
    expect(res.jobs.map((j) => j.id).sort()).toEqual(['n1', 'tb-l4', 'tb3-l3']);
    expect(res.textbook).toBe(2);
  });
});

describe('lesson practice sentences (Phase 35)', () => {
  it('a lesson sentence at any level gets a sentence job; nothing under private/ is read', () => {
    const file = (sentences: SentenceBankEntry[]) => JSON.stringify({ meta: { version: 'v1', buildDate: 'x', level: 'N1' }, sentences });
    writeFileSync(path.join(dir, 'sentences.textbook-laixue-3.json'), file([{ ...sentence('tb3-L01-001', '你好'), level: 'L4' }]));
    mkdirSync(path.join(dir, 'private'));
    writeFileSync(path.join(dir, 'private', 'sentences.textbook-laixue-3.json'), file([sentence('dlg-1', '我們')]));
    writeFileSync(path.join(dir, 'sentences.v1.N1.json'), file([sentence('bank-1', '我')]));
    const loaded = loadLessonSentences(dir);
    expect(loaded.map((s) => s.id)).toEqual(['tb3-L01-001']);
    expect(sentenceJobs(lex, loaded).jobs.map((j) => j.id)).toEqual(['tb3-L01-001']);
  });

  it('the real lesson sentences come only from the compiled content/L*.yaml files', () => {
    const src = readFileSync(new URL('./inputs.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export function loadLessonSentences'), src.indexOf('/** Phase 9 live sentences'));
    expect(fn).not.toMatch(/curriculum|private/);
    const curriculumRoot = path.resolve(new URL('.', import.meta.url).pathname, '../../../../../data/curriculum');
    if (existsSync(path.join(curriculumRoot, 'laixue-1/content/L01.yaml'))) {
      const first = readFileSync(path.join(curriculumRoot, 'laixue-1/content/L01.yaml'), 'utf8');
      const built = loadLessonSentences(path.resolve(curriculumRoot, '../build'));
      expect(built.length).toBeGreaterThan(0);
      expect(first).toContain(built.find((s) => s.id === 'tb-L01-001')!.zh);
    }
  });
});

void readFileSync;
