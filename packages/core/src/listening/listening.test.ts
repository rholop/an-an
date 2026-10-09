import { describe, expect, it } from 'vitest';
import { createEmptyCard, State } from 'ts-fsrs';
import type { AudioManifest, AudioMark } from '../audio/clips.js';
import { applyEvidence } from '../learner/apply-evidence.js';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import type { SentenceBankEntry } from '../cloze/sentence.js';
import type { Word } from '../types.js';
import { DEFAULT_STUDY_SETTINGS, getStudyFocus } from '../study/study-focus.js';
import { listeningClip, makeClipLookup } from './clips.js';
import {
  buildHearPick,
  buildListenUnderstand,
  buildToneCheck,
  generateTonePairs,
  listeningCardsToCreate,
  planListenSession,
  soundAlikeDistractors,
  unlockedTypes,
} from './exercises.js';
import { gradeSentenceDictation, gradeWordDictation, listeningEvidenceKind } from './grading.js';
import { toneCheckEligible, tonePattern, wordTones } from './tones.js';

const NOW = new Date('2026-10-04T00:00:00Z');
const w = (id: string, headword: string, pinyin: string, zhuyin: string, over: Partial<Word> = {}): Word => ({
  id,
  headword,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: pinyin,
  zhuyin,
  glossEn: id,
  chars: [...headword],
  tags: [],
  ...over,
});
const MAI3 = w('mai3', '買', 'mai3', 'ㄇㄞˇ');
const MAI4 = w('mai4', '賣', 'mai4', 'ㄇㄞˋ');
const TANG1 = w('tang1', '湯', 'tang1', 'ㄊㄤ');
const TANG2 = w('tang2', '糖', 'tang2', 'ㄊㄤˊ');
const LS = w('ls', '老師', 'lao3 shi1', 'ㄌㄠˇ ㄕ');
const LSH = w('lsh', '老實', 'lao3 shi2', 'ㄌㄠˇ ㄕˊ');
const KF = w('kf', '咖啡', 'ka1 fei1', 'ㄎㄚ ㄈㄟ');
const GG = w('gg', '哥哥', 'ge1 ge5', 'ㄍㄜ ˙ㄍㄜ');
const NI = w('ni', '你好', 'ni3 hao3', 'ㄋㄧˇ ㄏㄠˇ');
const BU = w('bu', '不是', 'bu2 shi4', 'ㄅㄨˊ ㄕˋ');
const YI = w('yi', '一個', 'yi2 ge5', 'ㄧˊ ˙ㄍㄜ');
const WORDS = [MAI3, MAI4, TANG1, TANG2, LS, LSH, KF, GG, NI, BU, YI];
const lexicon = new Lexicon(WORDS);

describe('tones', () => {
  it('reads MOE tones and formats the answer ("3 + 4")', () => {
    expect(wordTones(LS)).toEqual([3, 1]);
    expect(tonePattern(LS)).toBe('3 + 1');
    expect(tonePattern(GG)).toBe('1 + 5'); // Phase 21: neutral shown as 5, like typed pinyin
  });
  it('tone check never includes 一/不 words or 3rd + 3rd sequences', () => {
    expect(toneCheckEligible(BU)).toBe(false);
    expect(toneCheckEligible(YI)).toBe(false);
    expect(toneCheckEligible(NI)).toBe(false); // 3 + 3
    expect(toneCheckEligible(LS)).toBe(true);
    expect(buildToneCheck(NI)).toBeUndefined();
    expect(buildToneCheck(BU)).toBeUndefined();
  });
});

describe('distractors sound alike', () => {
  it('same syllables with different tones come first (買/賣, 湯/糖), then shared syllables (老師/老實)', () => {
    const d = soundAlikeDistractors(MAI3, WORDS, 3, () => 0.5).map((x) => x.headword);
    expect(d[0]).toBe('賣');
    const t = soundAlikeDistractors(LS, WORDS, 1, () => 0.5).map((x) => x.headword);
    expect(t).toEqual(['老實']);
    const pick = buildHearPick(TANG1, WORDS, () => 0.5)!;
    expect(pick.options).toContain('糖');
    expect(pick.options).toContain('湯');
    expect(new Set(pick.options).size).toBe(4);
  });
});

describe('clips: only verified / auto_ok; tone exercises verified only', () => {
  const entry = (status: 'verified' | 'auto_ok' | 'suspect' | 'flagged', hash = 'h') => ({ file: 'words/x.mp3', voice: 'v', hash, status, text: 'x' });
  const manifest = {
    meta: { version: 1, builtAt: '', voice: 'v' },
    words: { v: entry('verified'), a: entry('auto_ok'), s: entry('suspect'), f: entry('flagged') },
    sentences: { s1: entry('auto_ok') },
  } as unknown as AudioManifest;
  it('suspect and flagged never play; auto_ok is not enough for tone exercises', () => {
    const ok = (id: string, verifiedOnly = false) => listeningClip(manifest, {}, 'word', id, { verifiedOnly }) !== null;
    expect([ok('v'), ok('a'), ok('s'), ok('f')]).toEqual([true, true, false, false]);
    expect([ok('v', true), ok('a', true)]).toEqual([true, false]);
  });
  it('a human mark beats the automatic status for that exact clip hash', () => {
    const mark = { status: 'verified', hash: 'h', by: 'x', at: '', kind: 'word', text: 'x' } as AudioMark;
    expect(listeningClip(manifest, { 'word:s': mark }, 'word', 's', { verifiedOnly: true })).not.toBeNull();
    const flagged = { ...mark, status: 'flagged' } as AudioMark;
    expect(listeningClip(manifest, { 'word:a': flagged }, 'word', 'a')).toBeNull();
  });
  it('tone pairs need both clips verified', () => {
    const verified = new Set(['mai3']);
    const none = generateTonePairs(WORDS, { hasVerifiedClip: (x) => verified.has(x.id) });
    expect(none).toEqual([]);
    verified.add('mai4');
    expect(generateTonePairs(WORDS, { hasVerifiedClip: (x) => verified.has(x.id) })).toHaveLength(1);
  });
});

const card = (id: string, skill: SkillCard['skill'], state: SkillCard['state'], stability = 1): SkillCard => ({
  item: { kind: 'word', id },
  skill,
  card: { ...createEmptyCard(NOW), stability },
  state,
  lapses: 0,
  leech: false,
  leechTreatmentsTried: [],
  clozeRung: 1,
  clozeStreak: 0,
  familiarity: 0,
  readingDependence: 0,
  flags: {},
  updatedAt: NOW,
});

describe('listening cards and FSRS', () => {
  it('are created only once recognition is Learned, with a usable clip, and not twice', () => {
    const learned = (c: SkillCard): SkillCard => ({ ...c, card: { ...c.card, reps: 2 } });
    const cards = [
      learned(card('a', 'recognition', 'review')),
      card('f', 'recognition', 'review'), // never answered in the app: not Learned
      card('b', 'recognition', 'learning'),
      learned(card('c', 'recognition', 'mature')),
      learned(card('d', 'recognition', 'review')),
      card('d', 'listening', 'learning'),
      card('e', 'production', 'review'),
    ];
    const has = (_k: string, id: string) => id !== 'c';
    expect(listeningCardsToCreate(cards, has)).toEqual(['a']);
  });

  it('first-play correct = Good; 2+ replays, slow or a wrong tone = Hard; wrong = Again', () => {
    expect(listeningEvidenceKind('correct', { replays: 0, slow: false })).toBe('listening_correct');
    expect(listeningEvidenceKind('correct', { replays: 1, slow: false })).toBe('listening_correct');
    expect(listeningEvidenceKind('correct', { replays: 2, slow: false })).toBe('listening_correct_replayed');
    expect(listeningEvidenceKind('correct', { replays: 0, slow: true })).toBe('listening_correct_replayed');
    expect(listeningEvidenceKind('wrong_tone', { replays: 0, slow: false })).toBe('listening_correct_replayed');
    expect(listeningEvidenceKind('wrong', { replays: 0, slow: false })).toBe('listening_wrong');
  });

  it('the three kinds schedule the listening card with Good / Hard / Again', () => {
    const ev = (kind: 'listening_correct' | 'listening_correct_replayed' | 'listening_wrong') => ({
      item: { kind: 'word' as const, id: 'a' },
      skill: 'listening' as const,
      kind,
      at: NOW,
    });
    const base = {
      ...card('a', 'listening', 'review', 5),
      card: { ...createEmptyCard(new Date('2026-09-20')), state: State.Review, stability: 5, difficulty: 5, reps: 3, last_review: new Date('2026-09-26'), due: NOW },
    };
    const next = (k: Parameters<typeof ev>[0]) => applyEvidence(base, ev(k), NOW).card!;
    const good = next('listening_correct');
    const hard = next('listening_correct_replayed');
    const again = next('listening_wrong');
    expect(good.card.stability).toBeGreaterThan(hard.card.stability);
    expect(hard.card.stability).toBeGreaterThan(again.card.stability);
    expect(again.lapses).toBeGreaterThan(0);
    expect(good.skill).toBe('listening');
    expect(applyEvidence(undefined, ev('listening_correct'), NOW).card?.skill).toBe('listening');
  });

  it('listening never affects Phase 14 mastery', () => {
    const book = {
      id: 'laixue-1', titleZh: '', titleEn: '',
      lessons: [{ id: 'laixue-1-L01', n: 1, titleZh: '', titleEn: '', topic: '', objectives: [], vocab: ['mai3'], supplementary: [], properNouns: [], grammar: [], dialogueRef: '', scenarios: [], journalPrompts: [] }],
    };
    const profile = (cards: SkillCard[]) => ({
      lexicon, books: [book], cards, grammarUses: new Map(), settings: DEFAULT_STUDY_SETTINGS,
    });
    const strongListening = [card('mai3', 'listening', 'mature', 400)];
    const without = getStudyFocus(profile([]), NOW).mastery!;
    const withListening = getStudyFocus(profile(strongListening), NOW).mastery!;
    expect(withListening.mastered).toBe(without.mastered);
    expect(withListening.mastered).toBe(0);
    const done = [card('mai3', 'recognition', 'mature', 30), card('mai3', 'production', 'mature', 10)];
    // Phase 21: the lesson is mastered (the active step moves on; level steps count the rest only).
    expect(getStudyFocus(profile(done), NOW).masteredLessonIds).toContain('laixue-1-L01');
    expect(getStudyFocus(profile(strongListening), NOW).masteredLessonIds).not.toContain('laixue-1-L01');
  });
});

describe('word dictation grading', () => {
  it('characters, pinyin (marks or digits) and zhuyin; tones are required', () => {
    expect(gradeWordDictation('老師', LS).outcome).toBe('correct');
    expect(gradeWordDictation('lǎoshī', LS).outcome).toBe('wrong'); // no spaces between syllables isn't parsed
    expect(gradeWordDictation('lǎo shī', LS).outcome).toBe('correct');
    expect(gradeWordDictation('lao3 shi1', LS).outcome).toBe('correct');
    expect(gradeWordDictation('ㄌㄠˇ ㄕ', LS).outcome).toBe('correct');
    expect(gradeWordDictation('ㄍㄜ ˙ㄍㄜ', GG).outcome).toBe('correct');
    expect(gradeWordDictation('ㄍㄜ ㄍㄜ˙', GG).outcome).toBe('correct');
  });
  it('right syllables with a wrong or missing tone are Hard-level and say which tone was wrong', () => {
    const r = gradeWordDictation('lǎo shí', LS);
    expect(r).toMatchObject({ outcome: 'wrong_tone', toneWrongAt: [1], input: 'pinyin' });
    expect(gradeWordDictation('lao shi', LS)).toMatchObject({ outcome: 'wrong_tone', toneWrongAt: [0, 1] });
    expect(gradeWordDictation('ㄌㄠˇ ㄕˊ', LS)).toMatchObject({ outcome: 'wrong_tone', toneWrongAt: [1], input: 'zhuyin' });
    expect(gradeWordDictation('老實', LS).outcome).toBe('wrong');
    expect(gradeWordDictation('', LS).input).toBe('empty');
  });
});

describe('sentence dictation', () => {
  const lex = new Lexicon([
    w('wo', '我', 'wo3', 'ㄨㄛˇ'), w('xi', '喜歡', 'xi3 huan1', 'ㄒㄧˇ ㄏㄨㄢ'), w('ka', '咖啡', 'ka1 fei1', 'ㄎㄚ ㄈㄟ'),
    w('he', '喝', 'he1', 'ㄏㄜ'), w('ni', '你', 'ni3', 'ㄋㄧˇ'),
  ]);
  it('grades word by word with a diff: missed words highlighted, extra words shown', () => {
    const r = gradeSentenceDictation('我喜歡喝你。', '我喜歡喝咖啡。', lex);
    expect(r.words.map((x) => [x.text, x.hit])).toEqual([['我', true], ['喜歡', true], ['喝', true], ['咖啡', false]]);
    expect(r.words.find((x) => x.text === '咖啡')?.wordId).toBe('ka');
    expect(r.diff.filter((d) => d.status === 'missed').map((d) => d.text)).toEqual(['咖啡']);
    expect(r.diff.filter((d) => d.status === 'extra').map((d) => d.text)).toEqual(['你']);
    expect(r.allCorrect).toBe(false);
    expect(gradeSentenceDictation('我喜歡喝咖啡', '我喜歡喝咖啡。', lex).allCorrect).toBe(true);
  });
});

describe('session planning', () => {
  const sentences = [
    { id: 's1', zh: '我喝咖啡。', en: 'I drink coffee.', targetWordId: 'kf', level: 'N1', tokens: [], source: 'generated', doubtful: false, lesson: 1 },
    { id: 's2', zh: '你好。', en: 'Hello.', targetWordId: 'ni', level: 'N1', tokens: [], source: 'generated', doubtful: false, lesson: 1 },
    { id: 's3', zh: '她買湯。', en: 'She buys soup.', targetWordId: 'tang1', level: 'N1', tokens: [], source: 'generated', doubtful: false, lesson: 1 },
  ] as SentenceBankEntry[];
  const clips = { word: new Set(WORDS.map((x) => x.id)), sentence: new Set(['s1', 's2', 's3']) };
  const hasClip = (k: string, id: string) => (k === 'word' ? clips.word : clips.sentence).has(id);

  it('harder exercise types unlock with listening stability', () => {
    expect(unlockedTypes(0)).toEqual(['hear_pick']);
    expect(unlockedTypes(3)).toContain('tone_check');
    expect(unlockedTypes(7)).toContain('hear_type');
    expect(unlockedTypes(20)).toContain('sentence_dictation');
  });

  it('new items start with hear-and-pick; due cards come first; sessions mix types as stability grows', () => {
    const plan = planListenSession({
      lexicon, dueListening: [card('mai3', 'listening', 'review', 20)], newWordIds: ['tang1'], newAllowed: 4, hasClip, sentences, rng: () => 0.3,
    });
    expect(plan[0]!.card?.item.id).toBe('mai3');
    expect(plan.find((p) => p.wordIds[0] === 'tang1')!.exercise.type).toBe('hear_pick');
    const strong = Array.from({ length: 30 }, (_, i) =>
      planListenSession({ lexicon, dueListening: [card('kf', 'listening', 'review', 30)], newWordIds: [], newAllowed: 4, hasClip, sentences, rng: () => i / 30 })[0]!.exercise.type);
    expect(new Set(strong).size).toBeGreaterThan(2);
  });

  it('skips items whose clip is not usable, and tone exercises need verified clips', () => {
    const noClip = planListenSession({ lexicon, dueListening: [card('kf', 'listening', 'review', 30)], newWordIds: [], newAllowed: 4, hasClip: () => false, sentences });
    expect(noClip).toEqual([]);
    const autoOnly = (k: string, id: string, verified?: boolean) => !verified && hasClip(k, id);
    for (let i = 0; i < 20; i++) {
      const p = planListenSession({ lexicon, dueListening: [card('ls', 'listening', 'review', 30)], newWordIds: [], newAllowed: 4, hasClip: autoOnly, sentences, rng: () => i / 20 });
      for (const item of p) expect(['tone_check', 'tone_pair']).not.toContain(item.exercise.type);
    }
  });

  it('listen-and-understand offers 3 English options from the same lesson, answer included', () => {
    const ex = buildListenUnderstand(sentences[0]!, sentences, () => 0.5)!;
    expect(ex.options).toHaveLength(3);
    expect(ex.options).toContain('I drink coffee.');
    expect(ex.answer).toBe('I drink coffee.');
  });

  it('restricts a lesson round to the lesson’s words', () => {
    const plan = planListenSession({ lexicon, dueListening: [card('kf', 'listening', 'review'), card('mai3', 'listening', 'review')], newWordIds: [], newAllowed: 4, hasClip, sentences, onlyWordIds: new Set(['kf']), rng: () => 0.2 });
    expect(plan.map((p) => p.wordIds[0])).toEqual(['kf']);
    expect(makeClipLookup(null, {})('word', 'x')).toBe(false);
  });
});
