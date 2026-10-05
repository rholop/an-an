import { describe, expect, it } from 'vitest';
import { journalLexicon } from '../test-fixtures/journal-llm.js';
import {
  applyResolvedEdits,
  diffHunks,
  editShape,
  locateEdit,
  locateModelEdits,
  resolveEdits,
} from './edits.js';
import { splitReviewSentences } from './sentences.js';
import type { SentenceEdit } from './types.js';

const lexicon = journalLexicon();
const edit = (over: Partial<SentenceEdit>): SentenceEdit => ({
  before: '',
  after: '',
  contextBefore: '',
  kind: 'other',
  explanationEn: 'because',
  ...over,
});

describe('locateEdit: edits are found by text, never by offsets', () => {
  const original = '我的姓印名字印羅恩。';
  it('finds an insertion by its context', () => {
    expect(locateEdit(original, edit({ after: '是', contextBefore: '我的姓' }))).toMatchObject({
      start: 3,
      end: 3,
    });
  });
  it('finds a replacement by context + before, picking the right repeat', () => {
    expect(
      locateEdit(original, edit({ before: '印', after: '叫', contextBefore: '名字' })),
    ).toMatchObject({ start: 6, end: 7 });
  });
  it('falls back to the bare text when the context is wrong', () => {
    expect(
      locateEdit(original, edit({ before: '的', after: '', contextBefore: 'zz' })),
    ).toMatchObject({ start: 1 });
  });
  it('returns null when the text is not there', () => {
    expect(locateEdit(original, edit({ before: '嗎', after: '' }))).toBeNull();
  });
});

describe('locateModelEdits: the edits must rebuild `corrected` exactly', () => {
  const original = '我的姓印名字印羅恩。';
  const good = [
    edit({ after: '是', contextBefore: '我的姓', kind: 'missing_word' }),
    edit({ after: '，', contextBefore: '姓印' }),
    edit({ before: '印', after: '是', contextBefore: '名字', kind: 'wrong_word' }),
  ];
  it('accepts edits that reproduce the corrected sentence', () => {
    expect(locateModelEdits(original, '我的姓是印，名字是羅恩。', good)).toHaveLength(3);
  });
  it('refuses edits that do not (so the diff is used instead)', () => {
    expect(locateModelEdits(original, '我的姓是印，名字叫羅恩。', good)).toBeNull();
    expect(locateModelEdits(original, '我的姓是印，名字是羅恩。', [])).toBeNull();
  });
});

describe('diffHunks / resolveEdits: smallest token-level edits', () => {
  it('an inserted 是 is an insertion of 是, not 印 -> 是印', () => {
    const r = resolveEdits('我的姓印名字印羅恩。', '我的姓是印，名字是羅恩。', [], lexicon)!;
    const shapes = r.edits.map((e) => [editShape(e), e.before, e.after]);
    expect(shapes).toContainEqual(['insertion', '', '是']);
    expect(shapes).toContainEqual(['replacement', '印', '是']);
    expect(shapes).not.toContainEqual(['replacement', '印', '是印']);
    expect(r.modelEditsUsable).toBe(false);
  });
  it('always rebuilds the corrected sentence from the original', () => {
    for (const [o, c] of [
      ['我的姓印名字印羅恩。', '我姓印，名字叫羅恩。'],
      ['我喜歡咖啡。', '我喜歡咖啡。'],
      ['我昨天去了台灣。', '我今天去了台灣。'],
    ] as const) {
      const r = resolveEdits(o, c, [], lexicon)!;
      expect(applyResolvedEdits(o, r.edits)).toBe(c);
    }
  });
  it('carries the model\'s notes onto the diff edit it overlaps, when its edits were usable', () => {
    const notes = [
      edit({ after: '是', contextBefore: '我的姓', kind: 'missing_word', explanationEn: 'Need 是.' }),
    ];
    const r = resolveEdits('我的姓印。', '我的姓是印。', notes, lexicon)!;
    expect(r.modelEditsUsable).toBe(true);
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]).toMatchObject({ kind: 'missing_word', explanationEn: 'Need 是.' });
  });
  it('treats moved words as one word-order change', () => {
    const r = resolveEdits('我去昨天台灣。', '我昨天去台灣。', [], lexicon)!;
    expect(r.edits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(r.edits.map((e) => e.kind))).toEqual(new Set(['word_order']));
  });
  it('diffHunks is null-safe on identical text', () => {
    expect(diffHunks('我去。', '我去。', lexicon)).toEqual([]);
  });
});

describe('splitReviewSentences', () => {
  it('splits on 。！？ and line breaks, keeping quotes together', () => {
    const text = '我去了。你呢？\n他說：「好。走吧！」我們走。';
    expect(splitReviewSentences(text).map(([a, b]) => text.slice(a, b))).toEqual([
      '我去了。',
      '你呢？',
      '他說：「好。走吧！」',
      '我們走。',
    ]);
  });
});
