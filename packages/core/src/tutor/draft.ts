// Phase 39 Part B: a tutor's class summary (simplified, mainland, AI-written) made into Taiwan
// Mandarin and checked in code. Nothing here is saved: the draft is shown on the check screen and
// only `finalizeTutorSession` (on Save) turns it into a session record and custom words.
import { buildCustomWord } from '../anki-import.js';
import { glossFor } from '../gloss/context.js';
import { hashText } from '../hash.js';
import type { Lexicon } from '../lexicon.js';
import { pinyinToZhuyin, toPinyinNumeric } from '../pinyin.js';
import { isAlwaysAllowedWord } from '../progress/terms.js';
import { segment } from '../segment.js';
import { checkTaiwanness, replaceSimplifiedChars } from '../taiwanness.js';
import { charLevelIndex, estimateWordLevel, type CharLevelIndex } from '../level-estimate.js';
import { topicTagsFor, topicWordTag, type TopicTag } from '../topics.js';
import type { GrammarItem, ItemRef, Word } from '../types.js';
import type { TutorCheckResponse, TutorExtraction } from './schema.js';
import { TUTOR_CONFIG, TUTOR_GRAMMAR_RULES } from './tutor.config.js';

export interface TutorDraftDeps {
  lexicon: Pick<Lexicon, 'lookup' | 'byId' | 'grammarItemById' | 'allWords' | 'prefixesOf' | 'maxHeadwordLength'>;
  /** Simplified → traditional, characters only (OpenCC cn → tw). */
  toTraditional: (s: string) => string;
  /** Simplified → traditional with Taiwan phrases (OpenCC cn → twp): 意大利面 → 義大利麵. */
  toTaiwan: (s: string) => string;
  /** The ledger's Learned (an already learned word starts unticked). */
  learned: (ref: ItemRef) => boolean;
  /** The ledger's comprehensible words (Learned ∪ in session ∪ learning). */
  comprehensibleIds: ReadonlySet<string>;
  /** Phase 40 Part B: "This tutor is from Taiwan" (default on): no "mainland" chip, the Taiwan form
   * is used (the swap still happens: the AI summary writes simplified characters). */
  tutorFromTaiwan?: boolean;
  /** Phase 40 Part A: the character levels for estimates (default: built from the lexicon). */
  charLevels?: CharLevelIndex;
}

export type TutorWordStatus = 'new' | 'learned' | 'mainland' | 'custom';

export interface TutorDraftSentence {
  id: string;
  /** As printed in the notes. */
  printed: string;
  /** Traditional, Taiwan wording. */
  zh: string;
  en: string;
  /** Kept for practice (Cloze, the grammar step). False = shown with the class only. */
  practice: boolean;
  /** Why it is shown only ("uses 3 words you haven't met", "mainland wording", "didn't pass the check"). */
  reason?: string;
  /** The independent check passed (or fixed it). */
  checked?: boolean;
  /** The check rewrote it (the printed one was close but not right). */
  fixed?: boolean;
  /** The word or grammar item it is an example of. */
  wordId?: string;
  grammarId?: string;
}

export interface TutorDraftWord {
  key: string;
  /** As printed (simplified). */
  printed: string;
  printedPinyin: string;
  /** The card's form: traditional, Taiwan word. */
  zh: string;
  /** The mainland word the notes used, when the Taiwan word differs ("also said in mainland China"). */
  mainlandForm?: string;
  /** Other Taiwan words for it (普通話 → 國語, also 中文). */
  alsoTaiwan?: string[];
  wordId: string;
  /** Present when the word list doesn't have it: saved as a custom word on Save. */
  custom?: Word;
  pinyin: string;
  zhuyin: string;
  /** "your notes said …" when the notes' pinyin differs from the Taiwan reading. */
  pinyinNote?: string;
  /** Lexicon words: MOE-verified. Custom words: every syllable matched a single-character MOE reading. */
  readingChecked: boolean;
  gloss: string;
  /** A sense from the notes the word list also has, beyond its main gloss. */
  notesGloss?: string;
  example: TutorDraftSentence;
  statuses: TutorWordStatus[];
  ticked: boolean;
}

export interface TutorDraftGrammar {
  key: string;
  /** As printed. */
  printedName: string;
  /** Taiwan characters. */
  name: string;
  explanationEn: string;
  example: TutorDraftSentence;
  /** The app's grammar item this point is, or undefined = a session grammar note (no cards). */
  matchId?: string;
  matchPattern?: string;
}

export interface TutorDraft {
  sessionId: string;
  /** "YYYY-MM-DDTHH:MM", the class's local time as printed. */
  date: string;
  tutor: string;
  topics: Array<{ zh: string; en: string; printed: string }>;
  /** Phase 40 Part C: the app's topic tags the class's topics map to (by the table). */
  topicTags: TopicTag[];
  /** Topics the table doesn't know (the one model call at Save maps them). */
  unmappedTopics: Array<{ zh: string; en: string }>;
  words: TutorDraftWord[];
  grammar: TutorDraftGrammar[];
}

/** The same class (date and tutor) always gets the same id: a re-upload updates it. */
export function tutorSessionId(date: string, tutor: string): string {
  const day = normalizeTutorDate(date).slice(0, 10);
  return `tutor-${day}-${hashText(tutor.trim().toLowerCase() || 'tutor')}`;
}

/** "2026-10-13T07:00" / "2026-10-13 07:00" / "2026-10-13" → "YYYY-MM-DDTHH:MM" (the class's own local
 * time, as printed; the extraction prompt asks for this form); anything else → "". */
export function normalizeTutorDate(date: string): string {
  const m = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '00'}:${m[5] ?? '00'}` : '';
}

const VOWEL = 'aeiouüvāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ';
const SYLLABLE = new RegExp(`(?:[zcs]h|[bpmfdtnlgkhjqxrzcsyw])?[${VOWEL}]+(?:ng(?![${VOWEL}])|n(?![${VOWEL}])|r(?![${VOWEL}]))?`, 'giu');

/** The notes' pinyin ("bǐnggān", "yào jú") split into one syllable per character, or undefined. */
export function splitPinyinForChars(pinyin: string, chars: number): string[] | undefined {
  const clean = pinyin.normalize('NFC').toLowerCase().replace(/[/'’]/g, ' ').trim();
  const spaced = clean.split(/\s+/).filter(Boolean);
  if (spaced.length === chars) return spaced;
  const found = clean.replace(/\s+/g, '').match(SYLLABLE) ?? [];
  return found.length === chars ? found : undefined;
}

const squash = (p: string) => p.normalize('NFC').toLowerCase().replace(/[\s'’/-]/g, '');
const STOP = new Set(['to', 'a', 'an', 'the', 'of', 'be', 'sb', 'sth', 'something', 'someone', 'or', 'in', 'on', 'at', 'for', 'by', 'one']);
const contentWords = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .split(/[^a-z]+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
const senses = (gloss: string) => gloss.split(/[;；,，]/).map((s) => s.trim()).filter(Boolean);
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;

/** The lexicon sense that fits the notes best: pinyin first, then shared gloss words, then lowest level. */
function pickWord(candidates: readonly Word[], pinyin: string, en: string): Word | undefined {
  if (candidates.length <= 1) return candidates[0];
  const want = contentWords(en);
  const p = squash(pinyin);
  const score = (w: Word) => (squash(w.pinyin) === p ? 10 : 0) + overlap(contentWords(w.glossEn), want);
  return [...candidates].map((w, i) => ({ w, i, s: score(w) })).sort((a, b) => b.s - a.s || a.i - b.i)[0]!.w;
}

/**
 * Part B.4: the gloss is the word list's. A sense from the notes is shown too only when the word list
 * has it (another sense of the same characters) and the main gloss doesn't already say it; anything
 * else ("吃: make a living by relying on something") is dropped.
 */
function notesExtraGloss(word: Word, all: readonly Word[], notesEn: string): string | undefined {
  const main = contentWords(glossFor(word));
  const other = contentWords(all.map((w) => w.glossEn).join('; '));
  const extra = senses(notesEn).filter((s) => {
    const cw = contentWords(s);
    return cw.size > 0 && overlap(cw, main) === 0 && overlap(cw, other) > 0;
  });
  return extra.length > 0 ? extra.join('; ') : undefined;
}

/**
 * Custom words: each syllable checked against the MOE readings the word list has for that character
 * (the character's own entry, or its syllable in any word that contains it).
 */
function readingFromChars(lexicon: TutorDraftDeps['lexicon'], zh: string, syllables: string[] | undefined): boolean {
  if (!syllables) return false;
  const chars = [...zh];
  const want = new Set(chars);
  const readings = new Map<string, Set<string>>();
  const add = (ch: string, numeric: string) => {
    let set = readings.get(ch);
    if (!set) readings.set(ch, (set = new Set()));
    set.add(numeric.replace(/\d$/, ''));
    set.add(numeric);
  };
  for (const w of lexicon.allWords()) {
    const cs = [...w.headword];
    if (!cs.some((c) => want.has(c))) continue;
    const syl = (w.pinyinNumeric || toPinyinNumeric(w.pinyin)).split(' ');
    if (syl.length !== cs.length) continue;
    cs.forEach((c, i) => want.has(c) && add(c, syl[i]!));
  }
  return chars.every((ch, i) => {
    const got = toPinyinNumeric(syllables[i] ?? '');
    const set = readings.get(ch);
    return !!set && (set.has(got) || (/5$/.test(got) && set.has(got.replace(/5$/, ''))));
  });
}

/** Whole-word mainland term → its Taiwan word (the card's form). */
function mainlandSwap(zh: string): { taiwan: string; also?: string[] } | undefined {
  const hit = checkTaiwanness(zh).mainlandTerms.find((h) => h.matched === zh && h.taiwan !== zh);
  return hit ? { taiwan: hit.taiwan, ...(hit.also ? { also: hit.also } : {}) } : undefined;
}

function unknownWordsIn(zh: string, deps: TutorDraftDeps, sessionIds: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const tok of segment(zh, deps.lexicon as Lexicon)) {
    if (tok.kind === 'unknown') out.add(tok.text);
    if (tok.kind !== 'word') continue;
    const ws = deps.lexicon.lookup(tok.text);
    const known = ws.some((w) => deps.comprehensibleIds.has(w.id) || sessionIds.has(w.id) || isAlwaysAllowedWord(w.tags));
    if (!known) out.add(tok.text);
  }
  return [...out];
}

/** Part B.5: convert, check Taiwanness, and decide practice vs display only (the model check comes later). */
function draftSentence(
  id: string,
  printed: { zh: string; en: string },
  deps: TutorDraftDeps,
  swaps: ReadonlyMap<string, string>,
  sessionIds: ReadonlySet<string>,
  extra: Pick<TutorDraftSentence, 'wordId' | 'grammarId'>,
): TutorDraftSentence {
  let zh = replaceSimplifiedChars(deps.toTaiwan(printed.zh).trim());
  // The class's own mainland words are taught in their Taiwan form, so their examples use it too.
  for (const [mainland, taiwan] of swaps) zh = zh.split(mainland).join(taiwan);
  const base = { id, printed: printed.zh, zh, en: printed.en.trim(), ...extra };
  if (!zh) return { ...base, practice: false, reason: 'No example sentence' };
  const tw = checkTaiwanness(zh);
  if (tw.simplifiedChars.length > 0) return { ...base, practice: false, reason: 'Simplified characters left' };
  if (tw.mainlandTerms.length > 0)
    return { ...base, practice: false, reason: `Mainland wording (${tw.mainlandTerms.map((t) => `${t.matched} → ${t.taiwan}`).join(', ')})` };
  const unknown = unknownWordsIn(zh, deps, sessionIds);
  if (unknown.length > TUTOR_CONFIG.maxUnknownWordsInExample)
    return { ...base, practice: false, reason: `Uses ${unknown.length} words you haven't met (${unknown.join('、')})` };
  return { ...base, practice: true };
}

/** Part B.6: the app's grammar item a point is, by its name. */
export function matchTutorGrammar(
  name: string,
  lexicon: Pick<Lexicon, 'grammarItemById'>,
): GrammarItem | undefined {
  for (const r of TUTOR_GRAMMAR_RULES) {
    if (!r.match.test(name)) continue;
    const g = lexicon.grammarItemById(r.id);
    if (g) return g;
  }
  return undefined;
}

/** Parts B.1–B.6: the draft the check screen shows. Pure; nothing is stored. */
export function buildTutorDraft(extraction: TutorExtraction, deps: TutorDraftDeps): TutorDraft {
  const date = normalizeTutorDate(extraction.date);
  const tutor = extraction.tutor.trim();
  const sessionId = tutorSessionId(date || extraction.date, tutor);
  const { lexicon } = deps;

  const swaps = new Map<string, string>();
  const fromTaiwan = deps.tutorFromTaiwan !== false;
  let charLevels = deps.charLevels;
  const topics = extraction.topics.map((t) => ({ printed: t.zh, zh: replaceSimplifiedChars(deps.toTaiwan(t.zh).trim()), en: t.en.trim() }));
  const topicTags = [...new Set(topics.flatMap((t) => topicTagsFor(t)))];
  const unmappedTopics = topics.filter((t) => topicTagsFor(t).length === 0).map((t) => ({ zh: t.zh, en: t.en }));
  const drafted: Array<{ word: Omit<TutorDraftWord, 'example'>; example: { zh: string; en: string } }> = [];
  const seen = new Set<string>();
  extraction.vocab.forEach((v, i) => {
    const printed = v.zh.trim();
    // OpenCC (deterministic), then any simplified character it left replaced from the table: a card
    // never shows simplified characters.
    const trad = replaceSimplifiedChars(deps.toTraditional(printed).trim());
    const tw = replaceSimplifiedChars(deps.toTaiwan(printed).trim());
    const swap = mainlandSwap(tw) ?? mainlandSwap(trad);
    const zh = swap?.taiwan ?? tw;
    // Phase 40 Part B: "mainland" only for a real mainland word (the Taiwanness table has it:
    // 普通话 → 國語). A character variant (炒麪 / 炒麵, 裏 / 裡) is corrected silently.
    const mainlandForm = swap && zh !== trad ? trad : undefined;
    if (zh !== trad) swaps.set(trad, zh);
    if (tw !== zh && tw !== trad) swaps.set(tw, zh);
    if (seen.has(zh)) return;
    seen.add(zh);
    const candidates = lexicon.lookup(zh);
    // The notes' pinyin is for the printed word: a swapped word keeps only the Taiwan reading.
    const notesPinyin = swap ? '' : v.pinyin;
    const word = pickWord(candidates, notesPinyin, v.en);
    const statuses: TutorWordStatus[] = [];
    if (mainlandForm && !fromTaiwan) statuses.push('mainland');
    let entry: Omit<TutorDraftWord, 'example' | 'ticked' | 'statuses'>;
    if (word) {
      const differs = notesPinyin && squash(notesPinyin) !== squash(word.pinyin);
      const notesGloss = swap ? undefined : notesExtraGloss(word, candidates, v.en);
      entry = {
        key: `v${i}`,
        printed,
        printedPinyin: v.pinyin,
        zh,
        ...(mainlandForm ? { mainlandForm } : {}),
        ...(swap?.also ? { alsoTaiwan: swap.also } : {}),
        wordId: word.id,
        pinyin: word.pinyin,
        zhuyin: word.zhuyin,
        ...(differs ? { pinyinNote: v.pinyin } : {}),
        readingChecked: true,
        gloss: glossFor(word),
        ...(notesGloss ? { notesGloss } : {}),
      };
    } else {
      const syllables = splitPinyinForChars(v.pinyin, [...zh].length);
      const pinyin = syllables ? syllables.join(' ') : v.pinyin.trim();
      charLevels ??= charLevelIndex(lexicon.allWords());
      const estimate = estimateWordLevel({ headword: zh, level: null }, { chars: charLevels });
      const custom: Word = {
        ...buildCustomWord(zh, pinyin, v.en.trim()),
        pinyinNumeric: syllables ? toPinyinNumeric(pinyin) : '',
        zhuyin: syllables ? pinyinToZhuyin(pinyin) : '',
        tags: ['tutor', `tutor:${sessionId}`, ...topicTags.map(topicWordTag)],
        ...(estimate ?? {}),
      };
      statuses.push('custom');
      entry = {
        key: `v${i}`,
        printed,
        printedPinyin: v.pinyin,
        zh,
        ...(mainlandForm ? { mainlandForm } : {}),
        ...(swap?.also ? { alsoTaiwan: swap.also } : {}),
        wordId: custom.id,
        custom,
        pinyin: custom.pinyin,
        zhuyin: custom.zhuyin,
        readingChecked: readingFromChars(lexicon, zh, syllables),
        gloss: custom.glossEn,
      };
    }
    const learned = !entry.custom && deps.learned({ kind: 'word', id: entry.wordId });
    statuses.unshift(learned ? 'learned' : 'new');
    drafted.push({ word: { ...entry, statuses, ticked: !learned }, example: v.example });
  });

  const sessionIds = new Set(drafted.map((d) => d.word.wordId));
  const words: TutorDraftWord[] = drafted.map(({ word, example }) => {
    const ex = draftSentence(`${sessionId}:${word.key}`, example, deps, swaps, sessionIds, { wordId: word.wordId });
    // A practice sentence must actually contain the word it practises.
    return {
      ...word,
      example: ex.practice && !ex.zh.includes(word.zh) ? { ...ex, practice: false, reason: `Doesn't use ${word.zh}` } : ex,
    };
  });

  const grammar: TutorDraftGrammar[] = extraction.grammar.map((g, i) => {
    const name = replaceSimplifiedChars(deps.toTaiwan(g.name).trim());
    const match = matchTutorGrammar(name, lexicon);
    return {
      key: `g${i}`,
      printedName: g.name,
      name,
      explanationEn: g.explanationEn.trim(),
      example: draftSentence(`${sessionId}:g${i}`, g.example, deps, swaps, sessionIds, match ? { grammarId: match.id } : {}),
      ...(match ? { matchId: match.id, matchPattern: match.pattern } : {}),
    };
  });

  return {
    sessionId,
    date,
    tutor,
    topics,
    topicTags,
    unmappedTopics,
    words,
    grammar,
  };
}

/** Every sentence of a draft the independent check should read (the practice ones). */
export function draftSentencesToCheck(draft: TutorDraft): TutorDraftSentence[] {
  return [...draft.words.map((w) => w.example), ...draft.grammar.map((g) => g.example)].filter((s) => s.practice);
}

/**
 * Part B.5: the one fresh check on the checker chain. A sentence it rejects is fixed when its fix is
 * clean Taiwan Mandarin that still uses the word, else shown with the class only. Sentences it never
 * answered stay unchecked (and are not practised).
 */
export function applyTutorCheck(draft: TutorDraft, res: TutorCheckResponse | undefined): TutorDraft {
  const byId = new Map((res?.results ?? []).map((r) => [r.id, r]));
  const fix = (s: TutorDraftSentence, mustContain?: string): TutorDraftSentence => {
    if (!s.practice) return s;
    const r = byId.get(s.id);
    if (!r) return { ...s, practice: false, checked: false, reason: 'Not checked (try again later)' };
    if (r.ok) return { ...s, checked: true };
    const fixed = r.fixedZh?.trim();
    if (fixed && checkTaiwanness(fixed).isClean && (!mustContain || fixed.includes(mustContain)))
      return { ...s, zh: fixed, checked: true, fixed: true };
    return { ...s, practice: false, checked: false, reason: `Didn't pass the check${r.reason ? `: ${r.reason}` : ''}` };
  };
  return {
    ...draft,
    words: draft.words.map((w) => ({ ...w, example: fix(w.example, w.zh) })),
    grammar: draft.grammar.map((g) => ({ ...g, example: fix(g.example) })),
  };
}
