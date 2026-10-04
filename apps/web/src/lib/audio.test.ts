import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioManifest } from '@anan/core';
import { __setAudioStateForTests, findClip, markClip } from './audio.js';

const hash = 'c'.repeat(64);
const entry = (status: 'auto_ok' | 'suspect', text = '垃圾') => ({
  file: 'words/w1.mp3',
  voice: 'zh-TW-HsiaoChenNeural',
  hash,
  status,
  text,
});
const manifest = (status: 'auto_ok' | 'suspect'): AudioManifest => ({
  meta: { version: 1, builtAt: 'x', voice: 'v' },
  words: { w1: entry(status) },
  sentences: { s1: { ...entry('auto_ok', '你好'), file: 'sentences/s1.mp3' } },
});

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

const state = (m: AudioManifest | null) => ({
  manifest: m,
  marks: {},
  byText: new Map(m ? Object.entries(m.sentences).map(([id, e]) => [e.text, id]) : []),
});

describe('findClip', () => {
  it('offers auto_ok clips (words by id, sentences by id or exact text) and nothing for suspect or unknown', () => {
    const s = state(manifest('auto_ok'));
    expect(findClip(s, { kind: 'word', id: 'w1' })?.url).toContain('words/w1.mp3?v=cccccccccc');
    expect(findClip(s, { kind: 'sentence', text: '你好' })?.id).toBe('s1');
    expect(findClip(s, { kind: 'sentence', id: 'nope', text: '你好' })?.id).toBe('s1');
    expect(findClip(s, { kind: 'sentence', text: '再見' })).toBeNull();
    expect(findClip(state(manifest('suspect')), { kind: 'word', id: 'w1' })).toBeNull();
    expect(findClip(state(null), { kind: 'word', id: 'w1' })).toBeNull();
  });
});

describe('markClip', () => {
  it('"Sounds wrong" stops the clip playing at once, even when the server is unreachable, and retries later', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    __setAudioStateForTests({ ...state(manifest('auto_ok')) });
    await markClip({ kind: 'word', id: 'w1', hash, status: 'flagged', text: '垃圾', profileId: 'ron' });
    const marks = JSON.parse(localStorage.getItem('anan.audioMarks')!);
    expect(findClip({ ...state(manifest('auto_ok')), marks }, { kind: 'word', id: 'w1' })).toBeNull();
    expect(JSON.parse(localStorage.getItem('anan.audioPending')!)).toHaveLength(1);
  });

  it('posts the mark to the proxy with the profile and clip hash', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await markClip({ kind: 'sentence', id: 's1', hash, status: 'verified', text: '你好', profileId: 'guanyu' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/v1\/audio\/mark$/);
    expect(JSON.parse(init.body)).toMatchObject({ kind: 'sentence', id: 's1', hash, status: 'verified', profileId: 'guanyu' });
    expect(localStorage.getItem('anan.audioPending')).toBeNull();
  });
});
