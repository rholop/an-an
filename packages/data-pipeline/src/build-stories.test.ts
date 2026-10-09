import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Textbook } from '@anan/core';
import { lessonStoryLadder } from './build-stories.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const book1 = (JSON.parse(readFileSync(path.join(REPO, 'data/curriculum/laixue-1/book.json'), 'utf8')) as { textbook: Textbook }).textbook;

describe('Phase 26 Part E: lesson stories use only this lesson, the lessons before and the gate', () => {
  it('book 1 lesson 4: lesson 3 words are known, lesson 4 words are rung 2, lesson 5 words are outside', () => {
    const [l3, l4, l5] = [3, 4, 5].map((n) => book1.lessons.find((l) => l.n === n)!);
    const { ladder, level } = lessonStoryLadder(1, l4!.id);
    expect(level).toBe('N1');
    const only = (ids: string[], other: string[]) => ids.filter((id) => !other.includes(id));
    expect(ladder.rung(only(l3!.vocab, l4!.vocab)[0]!)).toBe(1);
    expect(ladder.rung(only(l4!.vocab, l3!.vocab)[0]!)).toBe(2);
    const later = only(l5!.vocab, [...l3!.vocab, ...l4!.vocab, ...book1.lessons.filter((l) => l.n < 4).flatMap((l) => l.vocab)]);
    expect(ladder.rung(later[0]!)).toBe(6);
    expect([...ladder.ids[3], ...ladder.ids[4], ...ladder.ids[5]]).toEqual([]);
  });
});
