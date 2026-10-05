import { Lexicon } from '../lexicon.js';
import type {
  JournalSentenceFixRequest,
  JournalSolveRequest,
  JournalSolveResponse,
  JournalVerifyRequest,
  JournalVerifyResponse,
  ModelSentenceReview,
} from '../journal/types.js';
import type { JournalLLM } from '../journal/verifyCorrected.js';
import type { Word } from '../types.js';
import { FIXTURE_WORDS } from './lexicon-fixture.js';

/** Words the Phase 17 fixtures need on top of the shared fixture lexicon. */
const EXTRA = ['是', '叫', '姓', '名字', '我', '的', '朋友', '三', '二', '個', '昨天', '今天', '前天', '喜歡', '咖啡', '很', '重要', '捷運'];

let n = 0;
const word = (headword: string): Word => ({
  id: `j17-${++n}-${headword}`,
  headword,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin: 'x',
  pinyinNumeric: 'x1',
  zhuyin: 'ㄒ',
  glossEn: headword,
  chars: [...headword],
  tags: [],
});

export const journalLexicon = (): Lexicon => new Lexicon([...FIXTURE_WORDS, ...EXTRA.map(word)]);

export interface ScriptedLLM extends JournalLLM {
  calls: { fix: number; verify: JournalVerifyRequest[]; solve: JournalSolveRequest[] };
}

/** A scripted stand-in for the proxy: no network, every call recorded. */
export function scriptedJournalLLM(
  script: {
    fix?: (req: JournalSentenceFixRequest) => ModelSentenceReview;
    verify?: (req: JournalVerifyRequest) => JournalVerifyResponse;
    solve?: (req: JournalSolveRequest) => JournalSolveResponse;
  } = {},
): ScriptedLLM {
  const calls: ScriptedLLM['calls'] = { fix: 0, verify: [], solve: [] };
  return {
    calls,
    async fixJournalSentence(req) {
      calls.fix++;
      if (!script.fix) throw new Error('no fix scripted');
      return { review: script.fix(req), servedBy: 'gemini' };
    },
    async verifyJournalSentence(req) {
      calls.verify.push(req);
      return (script.verify ?? (() => ({ ok: true, problem: '', meaningMatches: true })))(req);
    },
    async solveJournalCloze(req) {
      calls.solve.push(req);
      return (script.solve ?? (() => ({ answers: [], confident: false })))(req);
    },
  };
}
