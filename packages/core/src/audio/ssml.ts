import { HETERONYM_TABLE } from '../heteronyms.js';
import type { Lexicon } from '../lexicon.js';
import { resolveReading } from '../reading.js';
import { segment } from '../segment.js';
import { zhuyinToSapi } from './zhuyin-sapi.js';

// Phase 10: SSML for Azure zh-TW neural voices. Words are forced to their MOE
// zhuyin; sentences are left to the voice (so 不是 / 一個 / 你好 tone changes
// stay natural) except for heteronyms whose reading we are sure of.

export const AUDIO_VOICES = {
  female: 'zh-TW-HsiaoChenNeural',
  male: 'zh-TW-YunJheNeural',
} as const;
export type AudioVoice = (typeof AUDIO_VOICES)[keyof typeof AUDIO_VOICES];

/** Characters whose reading depends on the word or context. The resolver's
 * own table plus common others; a token containing one is "reading-sensitive". */
export const AUDIO_HETERONYM_CHARS: ReadonlySet<string> = new Set([
  ...Object.keys(HETERONYM_TABLE).filter((c) => c !== '的'), // 的 is always de in running text
  ...'和行數種假差便乾傳背擔當處量難教轉藏參率降',
]);

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const speak = (voice: string, body: string): string =>
  `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-TW"><voice name="${voice}">${body}</voice></speak>`;

const phoneme = (text: string, sapi: string): string =>
  `<phoneme alphabet="sapi" ph="${sapi}">${escapeXml(text)}</phoneme>`;

/** One headword, wrapped in its MOE zhuyin so the citation reading is exactly
 * what the app displays. null if the zhuyin is malformed or its syllable count
 * doesn't match the characters (no clip rather than a guessed one). */
export function wordSsml(headword: string, zhuyin: string, voice: string): string | null {
  const sapi = zhuyinToSapi(zhuyin);
  if (!sapi) return null;
  if (sapi.split(' ').length !== [...headword].length) return null;
  return speak(voice, phoneme(headword, sapi));
}

export interface SentenceSsmlOptions {
  /** Also force readings that a context rule chose ('medium'). Off by default:
   * the brief says high confidence only. */
  acceptMedium?: boolean;
}

export type SentenceSsmlPlan =
  | { ok: true; ssml: string; forced: { text: string; zhuyin: string }[] }
  | { ok: false; reason: string; tokens: string[] };

export function sentenceSsml(
  text: string,
  lexicon: Lexicon,
  voice: string,
  opts: SentenceSsmlOptions = {},
): SentenceSsmlPlan {
  const tokens = segment(text, lexicon);
  const forced: { text: string; zhuyin: string }[] = [];
  const unsure: string[] = [];
  let body = '';
  tokens.forEach((token, i) => {
    if (token.kind !== 'word') {
      body += escapeXml(token.text);
      return;
    }
    const candidates = lexicon.lookup(token.text);
    const ambiguous = new Set(candidates.map((w) => w.pinyin)).size > 1;
    const hasHeteronym = [...token.text].some((c) => AUDIO_HETERONYM_CHARS.has(c));
    if (!ambiguous && !hasHeteronym) {
      body += escapeXml(token.text);
      return;
    }
    const reading = resolveReading(
      token,
      { prevToken: tokens[i - 1], nextToken: tokens[i + 1] },
      lexicon,
    );
    const sure = reading.confidence === 'high' || (opts.acceptMedium && reading.confidence === 'medium');
    const sapi = sure ? zhuyinToSapi(reading.zhuyin) : null;
    if (!sapi || sapi.split(' ').length !== [...token.text].length) {
      unsure.push(token.text);
      body += escapeXml(token.text);
      return;
    }
    forced.push({ text: token.text, zhuyin: reading.zhuyin });
    body += phoneme(token.text, sapi);
  });
  if (unsure.length > 0) {
    return {
      ok: false,
      reason: `reading not certain for: ${[...new Set(unsure)].join(' ')}`,
      tokens: [...new Set(unsure)],
    };
  }
  return { ok: true, ssml: speak(voice, body), forced };
}
