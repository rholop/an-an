import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningClip, makeClipLookup, type AudioManifest, type TutorSessionRecord } from '@anan/core';
import { __setAudioStateForTests, findClip, getAudioState, loadTutorAudio, setTutorManifest } from '../audio.js';
import { requestTutorAudio, tutorAudioItems } from './tutor-audio.js';
import { proxyBase } from '../api.js';

const entry = (file: string, text: string, status: 'auto_ok' | 'suspect' = 'auto_ok') => ({
  file,
  voice: 'zh-TW-HsiaoChenNeural',
  hash: 'd'.repeat(64),
  status,
  text,
});
const staticManifest: AudioManifest = {
  meta: { version: 1, builtAt: 'x', voice: 'v' },
  words: { 'tocfl-jiche': entry('words/tocfl-jiche.mp3', '機車') },
  sentences: { 'tb-1': entry('sentences/tb-1.mp3', '你好') },
};
const tutorManifest: AudioManifest = {
  meta: { version: 1, builtAt: 'y', voice: 'v' },
  words: {
    'custom-zaocan': entry('words/custom-zaocan.mp3', '早餐'),
    // a clash: the static clip wins
    'tocfl-jiche': entry('words/tocfl-jiche.mp3', '機車(tutor)'),
  },
  sentences: { 'tutor-x:w1': entry('sentences/tutor-x_w1-abc.mp3', '我吃早餐。') },
};

const session: Pick<TutorSessionRecord, 'id' | 'words' | 'sentences'> = {
  id: 'tutor-x',
  words: [
    { wordId: 'custom-zaocan', zh: '早餐', printed: '早餐', pinyin: 'zǎocān', zhuyin: 'ㄗㄠˇ ㄘㄢ', gloss: 'breakfast', ticked: true, custom: true },
    { wordId: 'tocfl-jiche', zh: '機車', printed: '機車', pinyin: 'jīchē', zhuyin: 'ㄐㄧ ㄔㄜ', gloss: 'scooter', ticked: true, custom: false },
  ],
  sentences: [
    { id: 'tutor-x:w1', zh: '我吃早餐。', en: 'I eat breakfast.', practice: true },
    { id: 'tutor-x:w2', zh: '顯示而已。', en: 'Display only.', practice: false },
  ],
};

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  vi.stubGlobal('window', { dispatchEvent: () => true });
  __setAudioStateForTests({ manifest: staticManifest, marks: {}, byText: new Map([['你好', 'tb-1']]), tutorSpeech: 'unknown' });
});
afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the tutoring manifest merged into the audio state', () => {
  it('makes hasClip true for a tutoring word, with the static clip winning a clash', () => {
    expect(makeClipLookup(getAudioState().manifest, {})('word', 'custom-zaocan')).toBe(false);
    setTutorManifest('ron', tutorManifest);
    const s = getAudioState();
    expect(makeClipLookup(s.manifest, s.marks)('word', 'custom-zaocan')).toBe(true);
    expect(s.manifest!.words['tocfl-jiche']!.text).toBe('機車');
    // the clip is served by the proxy behind the household code
    const url = listeningClip(s.manifest, s.marks, 'word', 'custom-zaocan')!.url;
    expect(url.startsWith(`${proxyBase()}/v1/tutor-audio/file/ron/words/custom-zaocan.mp3?v=`)).toBe(true);
    expect(findClip(s, { kind: 'word', id: 'custom-zaocan' })!.url).toBe(url);
    expect(findClip(s, { kind: 'word', id: 'tocfl-jiche' })!.url).toContain('/audio/words/tocfl-jiche.mp3');
    // class sentences by id and by text
    expect(findClip(s, { kind: 'sentence', id: 'tutor-x:w1' })?.id).toBe('tutor-x:w1');
    expect(findClip(s, { kind: 'sentence', text: '我吃早餐。' })?.id).toBe('tutor-x:w1');
    expect(findClip(s, { kind: 'sentence', text: '你好' })?.id).toBe('tb-1');
  });

  it('loadTutorAudio replaces another profile’s clips and records whether speech is configured', async () => {
    setTutorManifest('guanyu', tutorManifest);
    const fetchFn = vi.fn(async () =>
      json(200, { configured: false, manifest: { meta: tutorManifest.meta, words: {}, sentences: {} } }),
    );
    await loadTutorAudio('ron', fetchFn as unknown as typeof fetch);
    const s = getAudioState();
    expect(s.manifest!.words['custom-zaocan']).toBeUndefined();
    expect(s.tutor?.profileId).toBe('ron');
    expect(s.tutorSpeech).toBe('not_configured');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/v1/tutor-audio/manifest?profileId=ron');
    expect((init.headers as Record<string, string>)['x-site-code']).toBeDefined();
  });
});

describe('requestTutorAudio', () => {
  it('sends every word and the practice sentences, skipping what the static build already has', () => {
    expect(tutorAudioItems(session, staticManifest)).toEqual([
      { kind: 'word', id: 'custom-zaocan', text: '早餐', zhuyin: 'ㄗㄠˇ ㄘㄢ' },
      { kind: 'sentence', id: 'tutor-x:w1', text: '我吃早餐。' },
    ]);
  });

  it('maps a 503 speech_not_configured to its own status', async () => {
    const fetchFn = vi.fn(async () => json(503, { error: 'speech_not_configured' }));
    const r = await requestTutorAudio(session, 'ron', { fetchFn: fetchFn as unknown as typeof fetch });
    expect(r.status).toBe('speech_not_configured');
    expect(getAudioState().tutorSpeech).toBe('not_configured');
  });

  it('other failures are "error"', async () => {
    const down = vi.fn(async () => json(502, { error: 'speech_error' }));
    expect((await requestTutorAudio(session, 'ron', { fetchFn: down as unknown as typeof fetch })).status).toBe('error');
    const offline = vi.fn(async () => {
      throw new TypeError('offline');
    });
    expect((await requestTutorAudio(session, 'ron', { fetchFn: offline as unknown as typeof fetch })).status).toBe('error');
  });

  it('asks again for what was pending, and the clips join the audio state', async () => {
    const counts = { made: 1, unchanged: 0, suspect: 0, failed: 0, skipped: 0, pending: 1 };
    const bodies: Array<{ items: Array<{ id: string }> }> = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      bodies.push(b);
      if (bodies.length === 1)
        return json(200, {
          entries: { words: { 'custom-zaocan': tutorManifest.words['custom-zaocan'] }, sentences: {} },
          counts,
          failed: [],
          skipped: [],
        });
      return json(200, {
        entries: { words: {}, sentences: { 'tutor-x:w1': { ...tutorManifest.sentences['tutor-x:w1']!, status: 'suspect' } } },
        counts: { ...counts, suspect: 1, pending: 0 },
        failed: [],
        skipped: [],
      });
    });
    const r = await requestTutorAudio(session, 'ron', { fetchFn: fetchFn as unknown as typeof fetch });
    expect(r).toMatchObject({ status: 'ok', made: 2, suspect: 1, failed: 0, pending: 0 });
    expect(bodies[0]!.items.map((i) => i.id)).toEqual(['custom-zaocan', 'tutor-x:w1']);
    expect(bodies[1]!.items.map((i) => i.id)).toEqual(['tutor-x:w1']);
    const s = getAudioState();
    expect(makeClipLookup(s.manifest, s.marks)('word', 'custom-zaocan')).toBe(true);
    expect(findClip(s, { kind: 'sentence', text: '我吃早餐。' })?.id).toBe('tutor-x:w1');
  });
});
