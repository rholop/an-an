import { createHash } from 'node:crypto';
import {
  AUDIO_VOICES,
  COURSE_BOOK_IDS,
  isTextbookTagged,
  Lexicon,
  sentenceSsml,
  wordSsml,
  type AudioKind,
  type Level,
  type SentenceBankEntry,
  type Word,
} from '@anan/core';

/** One thing to say. `buildSsml(voice, explicit)` returns null when no trustworthy SSML exists. */
export interface AudioJob {
  kind: AudioKind;
  id: string;
  text: string;
  zhuyin?: string;
  /** The clip's path under the audio root. Default `words/<id>.mp3` / `sentences/<id>.mp3`. */
  file?: string;
  buildSsml(voice: string, explicit: boolean): string | null;
}

export interface SkippedClip {
  kind: AudioKind;
  id: string;
  text: string;
  reason: string;
}

/** Phase 35: a word in any textbook of the course (core, supplementary or extra lesson words). */
const inAnyTextbook = (tags: readonly string[]): boolean => COURSE_BOOK_IDS.some((b) => isTextbookTagged(tags, b));

/** One headword in its MOE zhuyin (`explicit`: every character tagged on its own), or null. */
export function wordJob(id: string, headword: string, zhuyin: string, file?: string): AudioJob | null {
  const build = (voice: string, explicit: boolean) =>
    explicit ? perSyllableSsml(headword, zhuyin, voice) : wordSsml(headword, zhuyin, voice);
  if (!build(AUDIO_VOICES.female, false)) return null;
  return { kind: 'word', id, text: headword, zhuyin, ...(file ? { file } : {}), buildSsml: build };
}

/** Words in `levels`, plus every textbook word whatever its level (Phase 35).
 * `textbook` counts the jobs that are textbook words. */
export function wordJobs(
  lexicon: Lexicon,
  levels: readonly Level[],
): { jobs: AudioJob[]; skipped: SkippedClip[]; textbook: number } {
  const jobs: AudioJob[] = [];
  const skipped: SkippedClip[] = [];
  const seen = new Set<string>();
  let textbook = 0;
  for (const w of lexicon.allWords()) {
    if (seen.has(w.id)) continue;
    const fromBook = inAnyTextbook(w.tags);
    if (!fromBook && (!w.level || !levels.includes(w.level))) continue;
    seen.add(w.id);
    const job = wordJob(w.id, w.headword, w.zhuyin);
    if (!job) {
      skipped.push({ kind: 'word', id: w.id, text: w.headword, reason: `zhuyin "${w.zhuyin}" doesn't fit the characters` });
      continue;
    }
    jobs.push(job);
    if (fromBook) textbook++;
  }
  return { jobs, skipped, textbook };
}

/** Fallback for a word whose whole-word tag didn't help: tag every character on its own. */
function perSyllableSsml(headword: string, zhuyin: string, voice: string): string | null {
  const chars = [...headword];
  const syl = zhuyin.trim().split(/\s+/);
  if (chars.length !== syl.length) return null;
  const parts = chars.map((c, i) => wordSsml(c, syl[i]!, voice));
  if (parts.some((p) => p === null)) return null;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-TW"><voice name="${voice}">${parts
    .map((p) => p!.replace(/^.*?<voice[^>]*>/, '').replace('</voice></speak>', ''))
    .join('')}</voice></speak>`;
}

export function sentenceJobs(
  lexicon: Lexicon,
  sentences: readonly (Pick<SentenceBankEntry, 'id' | 'zh'> & { file?: string })[],
  opts: { acceptMedium?: boolean } = {},
): { jobs: AudioJob[]; skipped: SkippedClip[] } {
  const jobs: AudioJob[] = [];
  const skipped: SkippedClip[] = [];
  const seen = new Set<string>();
  for (const s of sentences) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const plan = sentenceSsml(s.zh, lexicon, AUDIO_VOICES.female, opts);
    if (!plan.ok) {
      skipped.push({ kind: 'sentence', id: s.id, text: s.zh, reason: plan.reason });
      continue;
    }
    jobs.push({
      kind: 'sentence',
      id: s.id,
      text: s.zh,
      ...(s.file ? { file: s.file } : {}),
      // `explicit` = the fallback after a flag: force every token we can read with confidence
      buildSsml: (voice, explicit) => {
        const p = sentenceSsml(s.zh, lexicon, voice, { ...opts, acceptMedium: opts.acceptMedium || explicit });
        return p.ok ? p.ssml : null;
      },
    });
  }
  return { jobs, skipped };
}

// ---- Phase 40 D.1: tutoring words and sentences ---------------------------------------------

/** One thing a tutoring class wants said (the proxy's /v1/tutor-audio and `audio:build --tutor`). */
export interface TutorAudioItem {
  kind: AudioKind;
  /** Word id (the manifest key for a word) or the class sentence id (the key for a sentence). */
  id: string;
  /** Traditional characters, as the card shows them. */
  text: string;
  /** Words: the MOE zhuyin the app displays ("ㄗㄠˇ ㄘㄢ"). */
  zhuyin?: string;
  /** Words: "zao3 can1" (kept on the stand-in lexicon entry for sentence readings). */
  pinyinNumeric?: string;
}

/** A file name that is safe on any disk and in a URL path: the id itself when it already is
 * (`tocfl-3f9a2c`), else the id with the rest replaced plus a short hash (sentence ids hold ':'). */
export function safeClipName(id: string): string {
  if (/^[A-Za-z0-9_-][\w.-]{0,119}$/.test(id)) return id;
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 10);
  return `${id.replace(/[^\w-]/g, '_').slice(0, 100)}-${hash}`;
}

export const clipFileFor = (kind: AudioKind, id: string): string =>
  `${kind === 'word' ? 'words' : 'sentences'}/${safeClipName(id)}.mp3`;

/**
 * The jobs for a tutoring class: each word in the zhuyin it was saved with (the MOE reading,
 * Phase 39), each sentence with the same reading rules as lesson sentences. Words the base
 * lexicon doesn't have (custom tutoring words) join the lexicon used for the sentences, so a
 * sentence with 義大利麵 reads the word the way its card does.
 */
export function tutorJobs(
  baseLexicon: Lexicon,
  items: readonly TutorAudioItem[],
  opts: { acceptMedium?: boolean } = {},
): { jobs: AudioJob[]; skipped: SkippedClip[] } {
  const jobs: AudioJob[] = [];
  const skipped: SkippedClip[] = [];
  const seenWords = new Set<string>();
  const extra: Word[] = [];
  for (const it of items) {
    if (it.kind !== 'word' || seenWords.has(it.id)) continue;
    seenWords.add(it.id);
    const job = it.zhuyin ? wordJob(it.id, it.text, it.zhuyin, clipFileFor('word', it.id)) : null;
    if (!job) {
      skipped.push({
        kind: 'word',
        id: it.id,
        text: it.text,
        reason: it.zhuyin ? `zhuyin "${it.zhuyin}" doesn't fit the characters` : 'no zhuyin',
      });
      continue;
    }
    jobs.push(job);
    if (!baseLexicon.byId(it.id) && baseLexicon.lookup(it.text).length === 0)
      extra.push(standInWord(it.id, it.text, it.zhuyin!, it.pinyinNumeric));
  }
  const lexicon = extra.length > 0 ? new Lexicon([...baseLexicon.allWords(), ...extra], baseLexicon.allGrammar()) : baseLexicon;
  const sentences = items
    .filter((it) => it.kind === 'sentence')
    .map((it) => ({ id: it.id, zh: it.text, file: clipFileFor('sentence', it.id) }));
  const s = sentenceJobs(lexicon, sentences, opts);
  return { jobs: [...jobs, ...s.jobs], skipped: [...skipped, ...s.skipped] };
}

/** Only what segmenting and reading a sentence need. */
const standInWord = (id: string, headword: string, zhuyin: string, pinyinNumeric = ''): Word => ({
  id,
  headword,
  variants: [],
  pos: [],
  level: null,
  source: 'custom',
  pinyin: pinyinNumeric,
  pinyinNumeric,
  zhuyin,
  glossEn: '',
  chars: [...headword],
  tags: [],
});
