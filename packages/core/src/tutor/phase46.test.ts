import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { GrammarItem } from '../types.js';
import { matchTutorGrammar } from './draft.js';
import { recheckTutorGrammar, setTutorGrammarMatch, toTaiwanRuns, tutorGrammarPoints } from './grammar-recheck.js';
import { tutorLessonOf, type TutorSessionGrammar } from './session.js';

const g = (id: string, pattern: string): GrammarItem => ({ id, pattern, level: 'L1', explanationEn: '', examples: [] });
const ITEMS = [
  g('gram-ganggang-just', 'S + 剛剛 / 剛 + V (O)'),
  g('gram-hai-still', 'S + 還 + V / Vs ；S + 還沒 / 還不 + V'),
  g('gram-de-shihou', 'Clause + 的時候，……'),
  g('gram-gen-yiqi', 'S + 跟 + someone + 一起 + V (O)'),
  g('gram-keyi-permission', 'S + 可以 + V (O)'),
  g('gram-neng-possibility', 'S + (Adv) + 能 + V (O)'),
  g('gram-shenme-question', 'S + V + 什麼(名字)？'),
  g('gram-le-completion', 'S + V + O + 了'),
  g('gram-hui-can', 'S + 會 / 不會 + V (O)'),
  g('gram-guo-experience', 'S + V + 過 + O'),
  g('gram-bi-comparison', 'A + 比 + B + Vs'),
  g('gram-ba-directional', 'S + 把 + O + V + 上 / 下 + 來 / 去'),
];
const lexicon = new Lexicon([], ITEMS);
const ids = (name: string, ex: string) => matchTutorGrammar(name, ex, lexicon).map((x) => x.id);

describe('Phase 46 Part D: stricter tutor grammar matching', () => {
  it.each([
    ['剛剛在動詞', '我剛剛在吃飯。', ['gram-ganggang-just']],
    ['還沒還沒有動詞', '我還沒吃飯。', ['gram-hai-still']],
    ['的時候', '吃飯的時候，我喜歡看電視。', ['gram-de-shihou']],
    ['跟人一起或動詞', '我跟朋友一起吃飯。', ['gram-gen-yiqi']],
    ['什麼在疑問句中的用法', '你在看什麼？', ['gram-shenme-question']],
    ['省略成分', '吃飯了嗎？', []],
    // fuller markers for 了 / 會 / 過 / 比 / 把
    ['V + 了', '我吃了。', ['gram-le-completion']],
    ['會 + V', '我會說中文。', ['gram-hui-can']],
    ['V + 過', '我去過臺北。', ['gram-guo-experience']],
    ['A + 比 + B', '我比你高。', ['gram-bi-comparison']],
    ['把 + O + V', '請把書拿過來。', ['gram-ba-directional']],
  ])('%s (%s) → %j', (name, ex, want) => expect(ids(name, ex)).toEqual(want));

  it('no point matches 了 or 會 just because the character appears', () => {
    expect(ids('了解中文', '我了解。')).toEqual([]);
    expect(ids('吃飯了嗎', '吃飯了嗎？')).toEqual([]);
    expect(ids('開會', '我們開會。')).toEqual([]);
    expect(ids('我會說', '我會說中文。')).toEqual([]);
  });

  it('可以 vs 能不能 matches both items (each practises its own marker), never only 能', () => {
    expect(ids('可以 vs 能不能', '我可以去廁所嗎？')).toEqual(['gram-keyi-permission', 'gram-neng-possibility']);
    // one of the compared items missing from the word list → a note
    const without = new Lexicon([], ITEMS.filter((x) => x.id !== 'gram-keyi-permission'));
    expect(matchTutorGrammar('可以 vs 能不能', '我可以去廁所嗎？', without)).toEqual([]);
  });

  it('the marker must be in the class example too', () => {
    expect(ids('剛剛在動詞', '我在吃飯。')).toEqual([]);
    expect(ids('跟人一起或動詞', '我跟朋友吃飯。')).toEqual([]);
  });
});

const row = (name: string, grammarId?: string, extra: Partial<TutorSessionGrammar> = {}): TutorSessionGrammar => ({
  name,
  explanationEn: `“${name}” is explained here.`,
  example: { zh: '我可以去廁所嗎？', en: 'Can I go to the restroom?' },
  ...(grammarId ? { grammarId } : {}),
  ...extra,
});

// A stand-in for OpenCC: the characters these tests use.
const S2T: Record<string, string> = { 刚: '剛', 还: '還', 没: '沒', 动: '動', 词: '詞', 厕: '廁', 吗: '嗎' };
const conv = {
  toTraditional: (s: string) => [...s].map((c) => S2T[c] ?? c).join(''),
  toTaiwan: (s: string) => [...s].map((c) => S2T[c] ?? c).join(''),
};

describe('Phase 46 Parts C.2 and D.5: saved classes, once', () => {
  it('converts simplified runs only, English untouched', () => {
    expect(toTaiwanRuns('“刚刚在动词” is used for 剛才.', conv)).toBe('“剛剛在動詞” is used for 剛才.');
    expect(toTaiwanRuns('“还没” or “还没有”', conv)).toBe('“還沒” or “還沒有”');
  });

  it('re-checks matches: the old 能-only match of 可以 vs 能不能 becomes both items, listed once', () => {
    const before = [row('可以 vs 能不能', 'gram-neng-possibility'), row('刚刚在动词', 'gram-ganggang-just', { example: { zh: '我刚刚在吃饭。', en: 'I was just eating.' } })];
    const { grammar, changes } = recheckTutorGrammar({ grammar: before }, lexicon, conv);
    expect(grammar.map((x) => [x.name, x.grammarId])).toEqual([
      ['可以 vs 能不能', 'gram-keyi-permission'],
      ['可以 vs 能不能', 'gram-neng-possibility'],
      ['剛剛在動詞', 'gram-ganggang-just'],
    ]);
    expect(grammar[2]!.explanationEn).toBe('“剛剛在動詞” is explained here.');
    expect(grammar[2]!.example.zh).toBe('我剛剛在吃飯。');
    expect(changes).toEqual([{ name: '可以 vs 能不能', from: ['S + (Adv) + 能 + V (O)'], to: ['S + 可以 + V (O)', 'S + (Adv) + 能 + V (O)'] }]);
    // the two rows are one class point
    expect(tutorGrammarPoints(grammar).map((p) => p.length)).toEqual([2, 1]);
    // a second run changes nothing
    expect(recheckTutorGrammar({ grammar }, lexicon, conv).changes).toEqual([]);
  });

  it('a match the owner set is never changed by the re-check', () => {
    const owned = [row('可以 vs 能不能', undefined, { matchedBy: 'owner', point: 'g0' })];
    const { grammar, changes } = recheckTutorGrammar({ grammar: owned }, lexicon, conv);
    expect(changes).toEqual([]);
    expect(grammar[0]!.grammarId).toBeUndefined();
  });

  it('"Make this a note" removes the point from the class items; Change sets one item', () => {
    const rows = [row('可以 vs 能不能', 'gram-keyi-permission', { point: 'g0' }), row('可以 vs 能不能', 'gram-neng-possibility', { point: 'g0' }), row('的時候', 'gram-de-shihou', { point: 'g1' })];
    const noted = setTutorGrammarMatch(rows, 1, null);
    expect(noted.map((x) => [x.point, x.grammarId, x.matchedBy])).toEqual([
      ['g0', undefined, 'owner'],
      ['g1', 'gram-de-shihou', undefined],
    ]);
    const lesson = (gr: TutorSessionGrammar[]) => tutorLessonOf({ id: 'c', date: '2026-10-13', words: [], grammar: gr }).grammarIds;
    expect(lesson(noted)).toEqual(['gram-de-shihou']);
    expect(lesson(setTutorGrammarMatch(noted, 0, 'gram-keyi-permission'))).toEqual(['gram-keyi-permission', 'gram-de-shihou']);
  });
});
