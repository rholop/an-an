import { describe, expect, it } from 'vitest';
import { buildFixtureLexicon } from '../test-fixtures/lexicon-fixture.js';
import { effectiveStatus, playableClip, type AudioManifest, type AudioMark } from './clips.js';
import { AUDIO_VOICES, sentenceSsml, wordSsml } from './ssml.js';
import { zhuyinToSapi } from './zhuyin-sapi.js';

const V = AUDIO_VOICES.female;
const ph = (text: string, sapi: string) => `<phoneme alphabet="sapi" ph="${sapi}">${text}</phoneme>`;

// [headword, MOE zhuyin as stored in the lexicon, expected `sapi` ph]
const WORD_SNAPSHOT: [string, string, string][] = [
  ['垃圾', 'ㄌㄜˋ ㄙㄜˋ', 'ㄌㄜˋ ㄙㄜˋ'],
  ['星期', 'ㄒㄧㄥ ㄑㄧˊ', 'ㄒㄧㄥ ㄑㄧˊ'],
  ['危險', 'ㄨㄟˊ ㄒㄧㄢˇ', 'ㄨㄟˊ ㄒㄧㄢˇ'],
  ['和', 'ㄏㄢˋ', 'ㄏㄢˋ'],
  ['頭髮', 'ㄊㄡˊ ㄈㄚˇ', 'ㄊㄡˊ ㄈㄚˇ'],
  ['還', 'ㄏㄞˊ', 'ㄏㄞˊ'],
  ['還', 'ㄏㄨㄢˊ', 'ㄏㄨㄢˊ'],
  ['長', 'ㄔㄤˊ', 'ㄔㄤˊ'],
  ['長', 'ㄓㄤˇ', 'ㄓㄤˇ'],
  ['了', '˙ㄌㄜ', 'ㄌㄜ˙'],
  ['了', 'ㄌㄧㄠˇ', 'ㄌㄧㄠˇ'],
  ['吧', '˙ㄅㄚ', 'ㄅㄚ˙'],
  ['的', '˙ㄉㄜ', 'ㄉㄜ˙'],
  ['覺得', 'ㄐㄩㄝˊ ˙ㄉㄜ', 'ㄐㄩㄝˊ ㄉㄜ˙'],
  ['銀行', 'ㄧㄣˊ ㄏㄤˊ', 'ㄧㄣˊ ㄏㄤˊ'],
  ['兒子', 'ㄦˊ ㄗˇ', 'ㄦˊ ㄗˇ'],
  ['花兒', 'ㄏㄨㄚ ㄦˊ', 'ㄏㄨㄚ ㄦˊ'],
  ['咖啡', 'ㄎㄚ ㄈㄟ', 'ㄎㄚ ㄈㄟ'],
  ['捷運', 'ㄐㄧㄝˊ ㄩㄣˋ', 'ㄐㄧㄝˊ ㄩㄣˋ'],
  ['機車', 'ㄐㄧ ㄔㄜ', 'ㄐㄧ ㄔㄜ'],
  ['便利商店', 'ㄅㄧㄢˋ ㄌㄧˋ ㄕㄤ ㄉㄧㄢˋ', 'ㄅㄧㄢˋ ㄌㄧˋ ㄕㄤ ㄉㄧㄢˋ'],
  ['垃圾車', 'ㄌㄜˋ ㄙㄜˋ ㄔㄜ', 'ㄌㄜˋ ㄙㄜˋ ㄔㄜ'],
  ['你好', 'ㄋㄧˇ ㄏㄠˇ', 'ㄋㄧˇ ㄏㄠˇ'],
  ['謝謝', 'ㄒㄧㄝˋ ˙ㄒㄧㄝ', 'ㄒㄧㄝˋ ㄒㄧㄝ˙'],
  ['媽媽', 'ㄇㄚ ˙ㄇㄚ', 'ㄇㄚ ㄇㄚ˙'],
  ['一個', 'ㄧ ˙ㄍㄜ', 'ㄧ ㄍㄜ˙'],
  ['不是', 'ㄅㄨˊ ㄕˋ', 'ㄅㄨˊ ㄕˋ'],
  ['學生', 'ㄒㄩㄝˊ ˙ㄕㄥ', 'ㄒㄩㄝˊ ㄕㄥ˙'],
  ['朋友', 'ㄆㄥˊ ˙ㄧㄡ', 'ㄆㄥˊ ㄧㄡ˙'],
  ['台灣', 'ㄊㄞˊ ㄨㄢ', 'ㄊㄞˊ ㄨㄢ'],
];

describe('zhuyinToSapi', () => {
  it('moves a leading neutral mark to the end and keeps other tones', () => {
    expect(zhuyinToSapi('ㄐㄩㄝˊ ˙ㄉㄜ')).toBe('ㄐㄩㄝˊ ㄉㄜ˙');
    expect(zhuyinToSapi('ㄏㄢˋ')).toBe('ㄏㄢˋ');
  });
  it('rejects malformed zhuyin instead of guessing', () => {
    for (const bad of ['', 'hao', 'ㄏㄠ3', '˙ㄏㄠˇ', 'ㄏㄠ！']) expect(zhuyinToSapi(bad)).toBeNull();
  });
});

describe('wordSsml (snapshot: every word clip uses the MOE zhuyin shown in the app)', () => {
  it.each(WORD_SNAPSHOT)('%s %s', (headword, zhuyin, sapi) => {
    expect(wordSsml(headword, zhuyin, V)).toBe(
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-TW"><voice name="${V}">${ph(headword, sapi)}</voice></speak>`,
    );
  });
  it('makes no clip when syllables and characters disagree', () => {
    expect(wordSsml('咖啡', 'ㄎㄚ', V)).toBeNull();
  });
});

describe('sentenceSsml', () => {
  const lex = buildFixtureLexicon();
  const body = (s: string) => s.replace(/^.*?<voice[^>]*>/, '').replace('</voice></speak>', '');

  it('forces only heteronyms with a certain reading; 不/是 tone sandhi is left to the voice', () => {
    const plan = sentenceSsml('我不是在銀行', lex, V);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.forced).toEqual([{ text: '銀行', zhuyin: 'ㄧㄣˊ ㄏㄤˊ' }]);
    expect(body(plan.ssml)).toBe(`我不是在${ph('銀行', 'ㄧㄣˊ ㄏㄤˊ')}`);
  });

  it('forces nothing in a sentence with no heteronyms', () => {
    const plan = sentenceSsml('你好', lex, V);
    expect(plan.ok && plan.forced).toEqual([]);
    expect(plan.ok && body(plan.ssml)).toBe('你好');
  });

  it('skips the sentence when a heteronym reading is not high-confidence', () => {
    // bare 長 has two readings and no context rule fires -> low
    const plan = sentenceSsml('他長', lex, V);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.tokens).toContain('長');
  });

  it('medium (a context rule fired) is only used with acceptMedium', () => {
    expect(sentenceSsml('他還錢', lex, V).ok).toBe(false);
    const plan = sentenceSsml('他還錢', lex, V, { acceptMedium: true });
    expect(plan.ok && plan.forced.map((f) => f.text)).toEqual(['還']);
  });

  it('escapes XML in the spoken text', () => {
    const plan = sentenceSsml('你好 & <我>', lex, V);
    expect(plan.ok && plan.ssml).toContain('&amp; &lt;');
  });
});

describe('clip status gating', () => {
  const entry = (status: 'auto_ok' | 'suspect', hash = 'a'.repeat(64)) => ({
    file: 'words/w1.mp3',
    voice: V,
    hash,
    status,
    text: '好',
  });
  const manifest = (status: 'auto_ok' | 'suspect', hash?: string): AudioManifest => ({
    meta: { version: 1, builtAt: '2026-01-01', voice: V },
    words: { w1: entry(status, hash) },
    sentences: {},
  });
  const mark = (status: AudioMark['status'], hash = 'a'.repeat(64)): AudioMark => ({
    status,
    hash,
    by: 'ron',
    at: '2026-01-02',
    kind: 'word',
    text: '好',
  });

  it('plays auto_ok and verified', () => {
    expect(playableClip(manifest('auto_ok'), {}, 'word', 'w1')?.url).toBe('words/w1.mp3?v=aaaaaaaaaa');
    expect(playableClip(manifest('suspect'), { 'word:w1': mark('verified') }, 'word', 'w1')).not.toBeNull();
  });
  it('never plays suspect or flagged', () => {
    expect(playableClip(manifest('suspect'), {}, 'word', 'w1')).toBeNull();
    expect(playableClip(manifest('auto_ok'), { 'word:w1': mark('flagged') }, 'word', 'w1')).toBeNull();
  });
  it('with allowSuspect, suspect clips play (still marked suspect) but flagged ones never do', () => {
    const policy = { allowSuspect: true };
    const clip = playableClip(manifest('suspect'), {}, 'word', 'w1', policy);
    expect(clip?.status).toBe('suspect');
    expect(playableClip(manifest('suspect'), { 'word:w1': mark('flagged') }, 'word', 'w1', policy)).toBeNull();
    expect(playableClip(manifest('auto_ok'), { 'word:w1': mark('flagged') }, 'word', 'w1', policy)).toBeNull();
  });
  it('a flag about an older version of the clip no longer applies after a rebuild', () => {
    const m = manifest('auto_ok', 'b'.repeat(64));
    expect(effectiveStatus(m.words.w1!, mark('flagged', 'a'.repeat(64)))).toBe('auto_ok');
    expect(playableClip(m, { 'word:w1': mark('flagged') }, 'word', 'w1')).not.toBeNull();
  });
  it('unknown clips and a missing manifest play nothing', () => {
    expect(playableClip(manifest('auto_ok'), {}, 'word', 'nope')).toBeNull();
    expect(playableClip(null, {}, 'word', 'w1')).toBeNull();
  });
});
