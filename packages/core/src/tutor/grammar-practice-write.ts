// Phase 46 Part B.1.4: when a class's grammar point has fewer than 3 practice sentences from the
// textbook, the class and the banks, one call on the checker chain writes 3 from the learner's known
// words. They are converted and checked in code (traditional characters, Taiwan wording, the point's
// marker), then by a fresh check, and only then stored with the class.
import type { Lexicon } from '../lexicon.js';
import { checkTaiwanness } from '../taiwanness.js';
import { sentenceFitsGrammar } from '../textbook/grammar-practice.js';
import type { GrammarItem, Level } from '../types.js';
import { taiwanText } from './draft.js';
import type { TutorCheckRequest, TutorCheckResponse, TutorGrammarPracticeRequest, TutorGrammarPracticeResponse } from './schema.js';
import type { TutorSessionSentence } from './session.js';

/** Sentences asked for, and the most known words sent with the request. */
export const GRAMMAR_PRACTICE_WRITE = { count: 3, knownWords: 300, maxChars: 30 } as const;

const HAN_RUN = /\p{Script=Han}+/gu;

/** The point's markers: its signal words, else the pattern's fixed Chinese words. */
export const grammarMarkers = (item: Pick<GrammarItem, 'focus' | 'pattern'>): string[] =>
  (item.focus?.length ? item.focus : (item.pattern.match(HAN_RUN) ?? [])).slice(0, 6);

export function grammarPracticeRequest(
  item: GrammarItem,
  knownHeadwords: readonly string[],
  learnerLevel: Level,
  retry = false,
): TutorGrammarPracticeRequest {
  return {
    pattern: item.pattern.slice(0, 120),
    explanationEn: item.explanationEn.slice(0, 800),
    markers: grammarMarkers(item),
    knownWords: [...new Set(knownHeadwords)].filter((h) => h.length <= 20).slice(0, GRAMMAR_PRACTICE_WRITE.knownWords),
    learnerLevel,
    count: GRAMMAR_PRACTICE_WRITE.count,
    ...(retry ? { retry: true } : {}),
  };
}

/** The reply checked in code: Taiwan characters (OpenCC, never AI), clean wording, short, uses the point. */
export function draftGrammarPractice(
  res: TutorGrammarPracticeResponse,
  item: GrammarItem,
  deps: { lexicon: Lexicon; toTaiwan: (s: string) => string; idPrefix: string },
): TutorCheckRequest['sentences'] {
  const seen = new Set<string>();
  const out: TutorCheckRequest['sentences'] = [];
  for (const s of res.sentences) {
    const zh = taiwanText(s.zh, deps);
    if (!zh || seen.has(zh) || [...zh].length > GRAMMAR_PRACTICE_WRITE.maxChars) continue;
    if (!checkTaiwanness(zh).isClean || !sentenceFitsGrammar(zh, item, deps.lexicon)) continue;
    seen.add(zh);
    out.push({ id: `${deps.idPrefix}:${out.length}`, zh, en: s.en.trim().slice(0, 300) });
  }
  return out;
}

/** After the fresh check: the ones it passed (or fixed and still clean and using the point). */
export function acceptGrammarPractice(
  candidates: TutorCheckRequest['sentences'],
  check: TutorCheckResponse | undefined,
  item: GrammarItem,
  lexicon: Lexicon,
): TutorSessionSentence[] {
  const byId = new Map((check?.results ?? []).map((r) => [r.id, r]));
  return candidates.flatMap((c) => {
    const r = byId.get(c.id);
    if (!r) return [];
    const zh = r.ok ? c.zh : r.fixedZh?.trim();
    if (!zh || !checkTaiwanness(zh).isClean || !sentenceFitsGrammar(zh, item, lexicon)) return [];
    return [{ id: c.id, zh, en: c.en, grammarId: item.id, practice: true, written: true }];
  });
}
