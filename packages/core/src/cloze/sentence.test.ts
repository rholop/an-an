import { describe, expect, it } from 'vitest';
import { SentenceBankEntrySchema, SentenceBankFileSchema, SentenceGenRequestSchema, SentenceGenResponseSchema } from './sentence.js';

function entry(overrides: Partial<Parameters<typeof SentenceBankEntrySchema.parse>[0]> = {}) {
  return {
    id: 's-001',
    zh: '我想喝一杯珍珠奶茶。',
    en: 'I want to drink a bubble tea.',
    targetWordId: 'tocfl-abc123',
    level: 'N1',
    tokens: [{ text: '我' }, { text: '想' }, { text: '喝' }],
    source: 'generated',
    ...overrides,
  };
}

describe('SentenceBankEntrySchema', () => {
  it('accepts a well-formed entry', () => {
    expect(() => SentenceBankEntrySchema.parse(entry())).not.toThrow();
  });

  it('rejects an unknown source value', () => {
    expect(() => SentenceBankEntrySchema.parse(entry({ source: 'manual' as never }))).toThrow();
  });

  it('rejects an invalid level', () => {
    expect(() => SentenceBankEntrySchema.parse(entry({ level: 'N3' as never }))).toThrow();
  });
});

describe('SentenceBankFileSchema', () => {
  it('accepts a file with meta + sentences', () => {
    const file = {
      meta: { version: 'v1', buildDate: '2026-10-01', level: 'N1' },
      sentences: [entry()],
    };
    expect(() => SentenceBankFileSchema.parse(file)).not.toThrow();
  });
});

describe('SentenceGenRequestSchema', () => {
  it('accepts a well-formed request and defaults count to 5', () => {
    const parsed = SentenceGenRequestSchema.parse({
      word: { headword: '珍珠奶茶', pinyin: 'zhēn zhū nǎi chá', level: 'N2', glossEn: 'bubble tea' },
      allowedVocab: ['我', '要', '一杯'],
    });
    expect(parsed.count).toBe(5);
  });

  it('rejects a count above the cap', () => {
    expect(() =>
      SentenceGenRequestSchema.parse({
        word: { headword: '我', pinyin: 'wǒ', level: 'N1', glossEn: 'I' },
        allowedVocab: [],
        count: 50,
      }),
    ).toThrow();
  });
});

describe('SentenceGenResponseSchema', () => {
  it('accepts a response with multiple sentences', () => {
    const parsed = SentenceGenResponseSchema.parse({
      sentences: [
        { zh: '我想喝珍珠奶茶。', en: 'I want to drink bubble tea.', tokens: [{ text: '我' }, { text: '想' }] },
      ],
    });
    expect(parsed.sentences).toHaveLength(1);
  });
});
