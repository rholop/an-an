import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIO_VOICES, buildFixtureLexiconForTests } from './test-support.js';
import { buildAudio, fixFlagged, loadManifest } from './build.js';
import { recognisedMatches } from './compare.js';
import { sentenceJobs, wordJobs } from './inputs.js';
import { renderReviewReport } from './report.js';
import type { SpeechClient } from './azure.js';
import type { SentenceBankEntry } from '@anan/core';

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

void readFileSync;
