import { describe, expect, it } from 'vitest';
import { buildMixedSession } from '../cloze/session.js';
import { applyEvidence } from '../learner/apply-evidence.js';
import { emptyCard } from '../learner/fsrs-instance.js';
import { DEFAULT_LEARNER_CONFIG, type SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import { buildFixtureLexicon, FIXTURE_WORDS } from '../test-fixtures/lexicon-fixture.js';
import type { Word } from '../types.js';
import { extractBrackets, lookupBracketInLexicon, renderBracketsInline } from './bracket.js';
import {
  buildErrorCloze,
  buildErrorItems,
  gradeErrorAnswer,
  patternCounts,
  reviewErrorItem,
  selectDueErrorItems,
  topErrorPatterns,
} from './error-bank.js';
import { planJournalEvidence } from './evidence.js';
import { dailyPrompt, findWordsUsed, isPromptWorthyWord, pickPromptWords } from './prompts.js';
import { compareSelfFix } from './self-correction.js';
import { sentenceAround, splitSentences } from './sentences.js';
import { journalSentencesFromEntry } from './sources.js';
import { errorsPer100Chars, patternRecurrence, summarizeLevels } from './summary.js';
import type { ErrorItem, JournalIssue } from './types.js';
import { validateJournalReview, JournalReviewShapeError } from './validate.js';

const lexicon = buildFixtureLexicon();
const now = new Date('2026-03-01T10:00:00Z');
const wordId = (hw: string) => lexicon.lookup(hw)[0]!.id;

const issue = (
  over: Partial<JournalIssue> & Pick<JournalIssue, 'span' | 'correction'>,
): JournalIssue => ({
  type: 'error',
  explanationEn: 'because',
  confidence: 'high',
  ...over,
});
const review = (over: Record<string, unknown> = {}) => ({
  issues: [],
  natural_rewrite: '',
  brackets: [],
  used_well: [],
  ...over,
});

describe('validateJournalReview', () => {
  const text = '昨天我去了捷運站，我喜歡咖啡，我買了一個手機。';
  /** [start, end) of the first occurrence of `sub` in `text`. */
  const at = (sub: string): [number, number] => [text.indexOf(sub), text.indexOf(sub) + sub.length];

  it('rejects out-of-range, empty and no-op spans', () => {
    const { review: r, rejected } = validateJournalReview(
      review({
        issues: [
          issue({ span: [0, 99], correction: '今天' }),
          issue({ span: [3, 3], correction: '今天' }),
          issue({ span: [-1, 2], correction: '今天' }),
          issue({ span: [0, 2], correction: '昨天' }),
        ],
      }),
      { lexicon, text },
    );
    expect(r.issues).toEqual([]);
    expect(rejected.map((x) => x.reason)).toEqual([
      'span out of range',
      'span out of range',
      'span out of range',
      'correction is empty or identical to the original',
    ]);
  });

  it('rejects simplified-character and mainland-style corrections', () => {
    const { review: r, rejected } = validateJournalReview(
      review({
        issues: [
          issue({ span: at('昨天'), correction: '今天' }), // clean
          issue({ span: at('咖啡'), correction: '软件' }), // simplified
          issue({ span: at('捷運'), correction: '公交車' }), // mainland term
          issue({ span: at('手機'), correction: '国家' }), // simplified
        ],
      }),
      { lexicon, text },
    );
    expect(r.issues.map((i) => i.correction)).toEqual(['今天']);
    expect(rejected.map((x) => x.reason)).toEqual([
      'correction contains simplified characters',
      'correction uses mainland-style wording',
      'correction contains simplified characters',
    ]);
  });

  it('never keeps more than 3 issues, and errors outrank style when capped', () => {
    const raw = review({
      issues: [
        issue({ span: at('昨天'), correction: '今天', type: 'unnatural' }),
        issue({ span: at('捷運'), correction: '地下鐵', type: 'unnatural' }),
        issue({ span: at('咖啡'), correction: '茶', type: 'unnatural' }),
        issue({ span: at('喜歡'), correction: '愛', type: 'error', confidence: 'low' }),
        issue({ span: at('買'), correction: '賣', type: 'mainland_style' }),
        issue({ span: at('手機'), correction: '電話', type: 'error', confidence: 'medium' }),
      ],
    });
    const { review: r, rejected } = validateJournalReview(raw, { lexicon, text });
    expect(r.issues).toHaveLength(3);
    expect(r.issues.map((i) => i.type).sort()).toEqual(['error', 'error', 'mainland_style']);
    expect(rejected.filter((x) => x.what === 'cap')).toHaveLength(3);
  });

  it('prefers recurring patterns within the same type when capping', () => {
    const raw = review({
      issues: [
        issue({ span: at('昨天'), correction: '今天', pattern: 'a' }),
        issue({ span: at('捷運'), correction: '地下鐵', pattern: 'b' }),
        issue({ span: at('咖啡'), correction: '茶', pattern: 'c' }),
        issue({ span: at('手機'), correction: '電話', pattern: '了-placement' }),
      ],
    });
    const { review: r } = validateJournalReview(raw, {
      lexicon,
      text,
      recurringPatterns: ['了-placement'],
    });
    expect(r.issues.some((i) => i.pattern === '了-placement')).toBe(true);
    expect(r.issues).toHaveLength(3);
  });

  it('drops overlapping spans and spans inside [English gaps]', () => {
    const t = '今天我去 [gym]，我喜歡咖啡。';
    const gaps = extractBrackets(t).map((g): [number, number] => [g.start, g.end]);
    const like = [t.indexOf('喜歡'), t.indexOf('喜歡') + 2] as [number, number];
    const { review: r } = validateJournalReview(
      review({
        issues: [
          issue({ span: [4, 9], correction: '健身房' }), // overlaps the gap
          issue({ span: like, correction: '愛', type: 'unnatural' }),
          issue({ span: [like[0] + 1, like[1] + 1], correction: '歡茶', type: 'error' }),
        ],
      }),
      { lexicon, text: t, bracketRanges: gaps },
    );
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.type).toBe('error');
  });

  it('rejects a non-traditional natural rewrite but keeps the issues', () => {
    const { review: r, rejected } = validateJournalReview(
      review({
        natural_rewrite: '我喜欢咖啡，也買了软件。',
        issues: [issue({ span: at('昨天'), correction: '今天' })],
      }),
      { lexicon, text },
    );
    expect(r.natural_rewrite).toBe('');
    expect(r.issues).toHaveLength(1);
    expect(rejected.some((x) => x.what === 'rewrite')).toBe(true);
  });

  it('keeps used_well items only when they really appear in the text', () => {
    const { review: r, rejected } = validateJournalReview(
      review({
        used_well: [
          { itemRef: { kind: 'word', id: '喜歡' }, span: at('喜歡') }, // by headword, appears
          { itemRef: { kind: 'word', id: wordId('貓') }, span: at('喜歡') }, // not in the text
          { itemRef: { kind: 'word', id: 'nope' }, span: at('昨天') }, // unknown
        ],
      }),
      { lexicon, text },
    );
    expect(r.used_well).toEqual([
      { itemRef: { kind: 'word', id: wordId('喜歡') }, span: at('喜歡') },
    ]);
    expect(rejected.filter((x) => x.what === 'used_well')).toHaveLength(2);
  });

  it('resolves headword itemRefs and infers one from the correction', () => {
    const { review: r } = validateJournalReview(
      review({
        issues: [
          issue({ span: at('喜歡'), correction: '愛', itemRef: { kind: 'word', id: '喜歡' } }),
          issue({ span: at('一個手機'), correction: '一個手機', itemRef: undefined }),
          issue({ span: at('買'), correction: '看電影' }),
        ],
      }),
      { lexicon, text },
    );
    const byStart = (n: number) => r.issues.find((i) => i.span[0] === n);
    expect(byStart(at('喜歡')[0])!.itemRef).toEqual({ kind: 'word', id: wordId('喜歡') });
    // correction introduces two fresh words (看, 電影) -> ambiguous -> none
    expect(byStart(at('買')[0])!.itemRef).toBeUndefined();
  });

  it('infers the single word a correction introduces', () => {
    const { review: r } = validateJournalReview(
      review({ issues: [issue({ span: at('一個手機'), correction: '一支手機' })] }),
      {
        lexicon,
        text,
      },
    );
    // 支 isn't in the fixture, so the only fresh lexicon word is none -> undefined
    expect(r.issues[0]!.itemRef).toBeUndefined();
    const { review: r2 } = validateJournalReview(
      review({ issues: [issue({ span: at('一個手機'), correction: '一個電腦' })] }),
      {
        lexicon,
        text,
      },
    );
    expect(r2.issues[0]!.itemRef).toEqual({ kind: 'word', id: wordId('電腦') });
  });

  it('throws on a malformed shape', () => {
    expect(() => validateJournalReview({ issues: 'x' }, { lexicon, text })).toThrow(
      JournalReviewShapeError,
    );
  });

  it('validates bracket translations (traditional only, ids resolved)', () => {
    const { review: r } = validateJournalReview(
      review({
        brackets: [
          { en: 'phone', zh: '手機' },
          { en: 'software', zh: '软件' },
        ],
      }),
      { lexicon, text },
    );
    expect(r.brackets).toEqual([{ en: 'phone', zh: '手機', wordId: wordId('手機') }]);
  });
});

describe('brackets', () => {
  it('extracts ASCII and full-width bracket gaps with offsets', () => {
    const t = '今天我去 [gym]，然後吃［ice cream］。';
    const gaps = extractBrackets(t);
    expect(gaps.map((g) => g.en)).toEqual(['gym', 'ice cream']);
    expect(t.slice(gaps[0]!.start, gaps[0]!.end)).toBe('[gym]');
  });

  it('looks up the lowest-level whole-gloss match, lexicon first', () => {
    const lex = new Lexicon([
      {
        ...FIXTURE_WORDS[0]!,
        id: 'a',
        headword: '健身房',
        glossEn: 'gym; fitness center',
        level: 'L3',
      },
      { ...FIXTURE_WORDS[0]!, id: 'b', headword: '體操', glossEn: 'gymnastics', level: 'L2' },
      { ...FIXTURE_WORDS[0]!, id: 'c', headword: '體育館', glossEn: 'gym', level: 'L2' },
    ] as Word[]);
    expect(lookupBracketInLexicon('Gym', lex)?.headword).toBe('體育館');
    expect(lookupBracketInLexicon('gymnastic', lex)).toBeNull();
    expect(lookupBracketInLexicon('to buy', lexicon)?.headword).toBe('買');
  });

  it('renders translations inline', () => {
    expect(renderBracketsInline('我去 [gym] 和 [x]', new Map([['gym', '健身房']]))).toBe(
      '我去 健身房 和 [x]',
    );
  });
});

describe('sentences', () => {
  it('splits on terminators and keeps them', () => {
    expect(splitSentences('我來。你呢？好！')).toEqual([
      [0, 3],
      [3, 6],
      [6, 8],
    ]);
  });
  it('widens a span that crosses sentences', () => {
    expect(sentenceAround('我來。你呢？好！', [2, 4])).toEqual([0, 6]);
  });
});

describe('error bank', () => {
  const text = '今天天氣很好。我昨天去了台灣。';
  const entryIssue = issue({
    span: [8, 9],
    correction: '去',
    pattern: '了-placement',
    type: 'error',
  });
  const items = buildErrorItems('e1', text, [{ issue: entryIssue, index: 0 }], now);

  it('builds an item scoped to the sentence with a blank on the corrected span', () => {
    expect(items).toHaveLength(1);
    const it = items[0]!;
    expect(it.original).toBe('我昨天去了台灣。');
    expect(it.span).toEqual([1, 2]);
    const c = buildErrorCloze(it);
    expect(c.sentence).toBe(it.corrected);
    expect(c.sentence.slice(c.blankStart, c.blankEnd)).toBe(c.answer);
    expect(c.answer).toBe('去');
    expect(it.id).toBe('e1:0');
  });

  it('handles corrections of a different length', () => {
    const [it] = buildErrorItems(
      'e2',
      '我很喜歡咖啡。',
      [{ issue: issue({ span: [2, 4], correction: '愛喝' }), index: 0 }],
      now,
    );
    const c = buildErrorCloze(it!);
    expect(c.answer).toBe('愛喝');
    expect(c.sentence).toBe('我很愛喝咖啡。');
    const [short] = buildErrorItems(
      'e3',
      '我很喜歡咖啡。',
      [{ issue: issue({ span: [2, 4], correction: '愛' }), index: 0 }],
      now,
    );
    expect(buildErrorCloze(short!).answer).toBe('愛');
  });

  it('blocks (never shows) sentences that still hold an English gap', () => {
    const [it] = buildErrorItems(
      'e',
      '我去 [gym]。',
      [{ issue: issue({ span: [0, 1], correction: '你' }), index: 0 }],
      now,
    );
    expect(it!.status).toBe('blocked');
    expect(it!.blockedReason).toMatch(/bracket/);
  });

  it('grades typed answers and reschedules with FSRS', () => {
    const it = items[0]!;
    expect(gradeErrorAnswer(' 去 ', it)).toBe('correct');
    expect(gradeErrorAnswer('來', it)).toBe('wrong');
    const good = reviewErrorItem(it, 'correct', now);
    const bad = reviewErrorItem(it, 'wrong', now);
    expect(good.card.due.getTime()).toBeGreaterThan(bad.card.due.getTime());
    expect(good.card.reps).toBe(1);
  });

  it('prioritises recurring patterns and never serves flagged items', () => {
    const mk = (
      id: string,
      pattern: string | undefined,
      over: Partial<ErrorItem> = {},
    ): ErrorItem => ({
      ...items[0]!,
      id,
      journalEntryId: id,
      pattern,
      card: emptyCard(new Date('2026-01-01')),
      status: 'active',
      ...over,
    });
    const all = [
      mk('a', 'solo'),
      mk('b', '了-placement', { card: emptyCard(new Date('2026-02-01')) }),
      mk('c', '了-placement'),
      mk('d', '了-placement', { flagged: true }),
      mk('f', undefined),
    ];
    const due = selectDueErrorItems(all, now, 10);
    expect(due.map((d) => d.id)).toEqual(['c', 'b', 'a', 'f']);
    expect(patternCounts(all).get('了-placement')).toBe(2);
    expect(topErrorPatterns(all, 1)).toEqual(['了-placement']);
    expect(patternRecurrence(all)).toEqual([{ pattern: '了-placement', entries: 2 }]);
    expect(selectDueErrorItems(all, new Date('2025-01-01'), 10)).toEqual([]);
  });
});

describe('mixed session', () => {
  const errorItem = buildErrorItems(
    'e1',
    '我昨天去了台灣。',
    [{ issue: issue({ span: [2, 4], correction: '今天', pattern: 'p' }), index: 0 }],
    now,
  ).map((i): ErrorItem => ({ ...i, status: 'active' }))[0]!;
  const dueCard = (hw: string, over: Partial<SkillCard> = {}): SkillCard => ({
    item: { kind: 'word', id: wordId(hw) },
    skill: 'recognition',
    card: emptyCard(new Date('2026-01-01')),
    state: 'introduced',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: now,
    ...over,
  });

  it('includes error clozes and puts priority gap words first among new items', () => {
    const cards = ['我', '你', '他', '她', '我們', '搭', '去'].map((hw) => dueCard(hw));
    cards.push(dueCard('貓', { flags: { priority: true } }));
    const session = buildMixedSession(cards, {
      lexicon,
      knownIds: new Set(),
      learnerLevel: 'L1',
      errorItems: [errorItem],
      now,
      config: { maxNewItems: 1 },
      rng: () => 0.5,
    });
    expect(session.some((e) => e.kind === 'error')).toBe(true);
    const words = session.flatMap((e) => (e.kind === 'card' ? [e.item.word.headword] : []));
    expect(words).toEqual(['貓']);
  });

  it('leads with recurring-pattern error items', () => {
    const second = { ...errorItem, id: 'e2:0', journalEntryId: 'e2' };
    const solo = { ...errorItem, id: 'e3:0', journalEntryId: 'e3', pattern: 'other' };
    const session = buildMixedSession([dueCard('貓')], {
      lexicon,
      knownIds: new Set(),
      learnerLevel: 'L1',
      errorItems: [solo, errorItem, second],
      now,
    });
    expect(session[0]).toMatchObject({ kind: 'error' });
    expect(session[1]).toMatchObject({ kind: 'error' });
    expect(session.filter((e) => e.kind === 'error')).toHaveLength(3);
  });
});

describe('self-correction', () => {
  it('compares an edit with the suggested correction', () => {
    expect(compareSelfFix({ correction: '去了' }, '去', '去了。')).toBe('fixed');
    expect(compareSelfFix({ correction: '去了' }, '去', '去')).toBe('unchanged');
    expect(compareSelfFix({ correction: '去了' }, '去', '')).toBe('unchanged');
    expect(compareSelfFix({ correction: '去了' }, '去', '去過')).toBe('needs_check');
  });
});

describe('evidence', () => {
  const ref = { kind: 'word', id: 'w1' } as const;
  const used = { kind: 'word', id: 'w2' } as const;

  it('maps used_well, prompt words and misuse to production evidence', () => {
    const ev = planJournalEvidence({
      entryId: 'e',
      now,
      usedWell: [{ itemRef: used, span: [0, 1] }],
      promptWordsUsed: ['w3', 'w2', 'w1'],
      issues: [{ issue: issue({ span: [0, 1], correction: 'x', itemRef: ref }), selfFixed: true }],
    });
    expect(ev.map((e) => [e.item.id, e.kind, e.skill])).toEqual([
      ['w1', 'journal_misuse', 'production'],
      ['w2', 'journal_correct_use', 'production'],
      ['w3', 'journal_correct_use', 'production'],
    ]);
    expect(ev[0]!.context).toMatchObject({ source: 'journal', refId: 'e', selfFixed: true });
  });

  it('gives a self-fixed misuse a milder effect than an unaided one', () => {
    const base = { item: ref, skill: 'production', kind: 'journal_misuse', at: now } as const;
    const unaided = applyEvidence(undefined, base, now);
    expect(unaided.appliedEffect).toBe('fsrs:hard');
    const fixed = applyEvidence(
      undefined,
      { ...base, context: { source: 'journal', selfFixed: true } },
      now,
    );
    expect(fixed.appliedEffect).toContain('self-fixed');
    expect(fixed.card?.state).toBe('introduced');
    const asHard = applyEvidence(
      undefined,
      { ...base, context: { source: 'journal', selfFixed: true } },
      now,
      {
        ...DEFAULT_LEARNER_CONFIG,
        selfFixedMisuseEffect: 'hard',
      },
    );
    expect(asHard.appliedEffect).toBe('fsrs:hard');
  });
});

describe('prompts, summary and sources', () => {
  it('rotates the daily prompt by date', () => {
    expect(dailyPrompt(new Date(2026, 2, 1)).id).not.toBe(dailyPrompt(new Date(2026, 2, 2)).id);
    expect(dailyPrompt(new Date(2026, 2, 1)).id).toBe(dailyPrompt(new Date(2026, 2, 1, 23)).id);
  });

  it('picks due words, production first, one per word', () => {
    const mk = (hw: string, skill: SkillCard['skill'], due: string): SkillCard => ({
      item: { kind: 'word', id: wordId(hw) },
      skill,
      card: emptyCard(new Date(due)),
      state: 'learning',
      lapses: 0,
      leech: false,
      leechTreatmentsTried: [],
      clozeRung: 1,
      clozeStreak: 0,
      familiarity: 0,
      readingDependence: 0,
      flags: {},
      updatedAt: now,
    });
    const picked = pickPromptWords(
      [
        mk('貓', 'recognition', '2026-01-01'),
        mk('買', 'production', '2026-02-01'),
        mk('買', 'recognition', '2026-01-01'),
        mk('錢', 'production', '2030-01-01'),
        mk('手機', 'production', '2026-02-10'),
      ],
      lexicon,
      now,
    );
    expect(picked.map((w) => w.headword)).toEqual(['買', '手機', '貓']);
  });

  it('never suggests numerals, measure words, particles or names as "try to use" words', () => {
    const mkWord = (id: string, headword: string, pos: string[], tags: string[] = []): Word => ({
      id, headword, variants: [], pos, level: 'N1', source: 'tocfl', pinyin: 'x', pinyinNumeric: 'x1',
      zhuyin: '', glossEn: 'g', chars: [...headword], tags,
    });
    const words = {
      kuai: mkWord('kuai', '塊', ['M']), // "dollar"
      liang: mkWord('liang', '兩', ['N']), // "two" (numerals are tagged N in TOCFL)
      shi: mkWord('shi', '二十', ['N']),
      ma: mkWord('ma', '嗎', ['Ptc']),
      he: mkWord('he', '和', ['Conj', 'Prep']),
      name: mkWord('name', '陳雅婷', ['N'], ['name']),
      dian: mkWord('dian', '點', ['M', 'N']), // keeps its noun sense
      cafe: mkWord('cafe', '咖啡', ['N']),
      eat: mkWord('eat', '吃', ['V']),
      compound: mkWord('cmp', '路上', []), // level-less compound, no POS
    };
    const lex = new Lexicon(Object.values(words));
    expect(Object.entries(words).filter(([, w]) => !isPromptWorthyWord(w)).map(([k]) => k)).toEqual([
      'kuai', 'liang', 'shi', 'ma', 'he', 'name',
    ]);
    const mk = (id: string, due: string): SkillCard => ({
      item: { kind: 'word', id }, skill: 'production', card: { ...emptyCard(now), due: new Date(due) },
      state: 'review', lapses: 0, leech: false, leechTreatmentsTried: [], clozeRung: 1, clozeStreak: 0,
      familiarity: 0, readingDependence: 0, flags: {}, updatedAt: now,
    });
    // the unsuitable words are the most overdue, yet are skipped; fewer than 3 is fine
    const picked = pickPromptWords(
      [mk('kuai', '2025-01-01'), mk('liang', '2025-01-02'), mk('ma', '2025-01-03'), mk('cafe', '2026-02-01'), mk('eat', '2026-02-02')],
      lex,
      now,
    );
    expect(picked.map((w) => w.headword)).toEqual(['咖啡', '吃']);
    expect(pickPromptWords([mk('kuai', '2025-01-01')], lex, now)).toEqual([]);
  });

  it('detects prompt words by re-segmenting (還 inside 還是 is not 還)', () => {
    const w = lexicon.lookup('買')[0]!;
    expect(findWordsUsed('我想買手機。', [w], lexicon).has(w.id)).toBe(true);
    expect(findWordsUsed('我想看電影。', [w], lexicon).size).toBe(0);
  });

  it('summarises levels and words, ignoring English gaps', () => {
    const s = summarizeLevels('我喜歡咖啡 [gym]', lexicon);
    expect(s.wordsUsed).toEqual(expect.arrayContaining(['喜歡', '咖啡']));
    expect(s.wordsUsed.join('')).not.toContain('gym');
  });

  it('computes errors per 100 characters without counting gaps', () => {
    expect(errorsPer100Chars(2, '一二三四五六七八九十'.repeat(2))).toBe(10);
    expect(errorsPer100Chars(1, '一二三四 [gym]')).toBe(25);
    expect(errorsPer100Chars(1, '  ')).toBeNull();
  });

  it('only offers journal sentences that were written correctly', () => {
    const text = '我喜歡咖啡。我昨天去了台灣。我去 [gym] 了。';
    expect(journalSentencesFromEntry(text, null, now)).toEqual([]);
    const out = journalSentencesFromEntry(text, [[8, 9]], now);
    expect(out.map((s) => s.zh)).toEqual(['我喜歡咖啡。']);
  });
});
