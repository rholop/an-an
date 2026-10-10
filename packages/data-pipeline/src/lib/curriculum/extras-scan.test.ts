import { describe, expect, it } from 'vitest';
import { bareLabels, newCandidates, printedPage, scanBlockPage, scanLayoutPage, scanPage } from './extras-scan.js';
import { ExtraEntrySchema, mergeExtras, activeExtras } from './extras-file.js';

// Synthetic pages in the shapes the two extractors give (not book text).
const LAYOUT = `
   List of Occupations
     1.   工程師                    gōngchéngshī                       engineer
     2.   廚師                     chúshī                             chef
     3.   服務員                    fúwùyuán                           server, waiter, waitress
     4.   醫生                     yīshēng                            doctor
     5.   老師                     lǎoshī                             teacher
    10.   退休了                    tuìxiū le                          retired
 ※ If the occupation is not listed above, please ask your teacher.
 (1) 他們忙不忙？
 Q：你爸爸在哪裡工作？\u3000\u3000\u3000A：我爸爸是老師。
     1. 爸爸   工程師   很忙   很累
 生詞 Vocabulary
                                                                                          053
`;
const BLOCK = `053
List of Occupations
1.
工程師
gōngchéngshī
engineer
2.
醫生
yīshēng
doctor
明文，請問你爸爸、媽媽在哪裡工作？
Míngwén, qǐng wèn nǐ bàba, māma zài nǎlǐ gōngzuò?
`;

describe('extras scan (Phase 34 B)', () => {
  it('reads a labelled occupations table and nothing from dialogue, grids or headings', () => {
    const heads = scanPage(LAYOUT, '').map((c) => c.headword);
    expect(heads).toEqual(['工程師', '廚師', '服務員', '醫生', '老師', '退休了']);
  });
  it('reads blocks of term / pinyin / gloss, one cell per line', () => {
    const c = scanBlockPage(BLOCK);
    expect(c.map((x) => [x.headword, x.pinyin, x.glossEn])).toEqual([
      ['工程師', 'gōngchéngshī', 'engineer'],
      ['醫生', 'yīshēng', 'doctor'],
    ]);
  });
  it('proposes exactly the occupations that are not already lesson words', () => {
    const known = new Set(['老師', '爸爸', '媽媽', '醫生']); // 生詞 of this lesson or earlier
    const out = newCandidates(scanPage(LAYOUT, BLOCK), known).map((c) => c.headword);
    expect(out).toEqual(['工程師', '廚師', '服務員', '退休了']);
  });
  it('keeps names and places out (capitalised reading) and flags them', () => {
    const c = scanLayoutPage('  1.  德國   Déguó   Germany\n  2.  日本   Rìběn   Japan');
    expect(c.every((x) => x.proper)).toBe(true);
    expect(newCandidates(c, new Set())).toEqual([]);
  });
  it('cleans ruby duplicates and alternates', () => {
    const c = scanPage('  1.  名字子   míngzi   N name\n  2.  她/他   tā   she / he', '');
    expect(c[0]).toMatchObject({ headword: '名字', glossEn: 'name' });
    expect(c[1]).toMatchObject({ headword: '她', variants: ['他'] });
  });
  it('rejects a ruby carrier glued to a short word (午 wǔān) and section headings', () => {
    expect(scanLayoutPage('  午   wǔān   Good afternoon')).toEqual([]);
    expect(scanPage('生詞 Vocabulary\n課文 Text', '')).toEqual([]);
  });
  it('finds the printed page number and unexplained Chinese labels', () => {
    expect(printedPage(BLOCK)).toBe(53);
    expect(bareLabels('買菜\n散步\n跑步\n你好嗎？', new Set(['散步']))).toEqual(['買菜', '跑步']);
  });
});

describe('extras.yaml', () => {
  const e = (lesson: number, headword: string, status: 'proposed' | 'keep' | 'drop' = 'proposed') =>
    ExtraEntrySchema.parse({ lesson, page: 53, headword, status });
  it('re-runs keep drops and hand-added lines and only add new candidates', () => {
    const existing = [e(4, '醫生', 'drop'), e(4, '公車司機', 'keep')];
    const { merged, added } = mergeExtras(existing, [e(4, '醫生'), e(4, '護士')]);
    expect(added.map((x) => x.headword)).toEqual(['護士']);
    expect(merged.find((x) => x.headword === '醫生')!.status).toBe('drop');
    expect(activeExtras(merged).map((x) => x.headword)).toEqual(['公車司機', '護士']);
  });
  it('a hand-written line needs only lesson, page and headword', () => {
    expect(ExtraEntrySchema.parse({ lesson: 4, page: 53, headword: '消防員' }).status).toBe('keep');
  });
});
