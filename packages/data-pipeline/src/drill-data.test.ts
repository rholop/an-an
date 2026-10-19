import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildDrillRound,
  checkDrillPassage,
  ConfusableIndex,
  levelIndex,
  Lexicon,
  oddOneOut,
  SentenceBankFileSchema,
  type DistractorTable,
  type DrillItem,
  type SentenceBankEntry,
  type Word,
} from '@anan/core';

// Phase 49 Part C on the real word list, distractor table and lesson practice sentences (kept here:
// core tests may not touch Node builtins). A learner who reads everything up to L1 drills the L2 target.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LEX = path.join(REPO, 'data/build/lexicon.v2.json');
const TABLE = path.join(REPO, 'data/build/distractors.v1.json');
const BOOKS = [1, 2, 3, 4].map((n) => path.join(REPO, `data/build/sentences.textbook-laixue-${n}.json`));
const ready = existsSync(LEX) && BOOKS.every(existsSync);

describe.skipIf(!ready)('Phase 49: the test drill on real data', () => {
  const raw = ready ? JSON.parse(readFileSync(LEX, 'utf8')) : { words: [], grammar: [] };
  const lexicon = new Lexicon(raw.words as Word[], raw.grammar);
  const index = new ConfusableIndex(lexicon.allWords());
  if (existsSync(TABLE)) index.setTable(JSON.parse(readFileSync(TABLE, 'utf8')) as DistractorTable);
  const sentences: SentenceBankEntry[] = ready ? BOOKS.flatMap((f) => SentenceBankFileSchema.parse(JSON.parse(readFileSync(f, 'utf8'))).sentences) : [];
  const tocfl = lexicon.allWords().filter((w) => w.source === 'tocfl' && w.level);
  const upTo = (lv: 'L1' | 'L2') => new Set(tocfl.filter((w) => levelIndex(w.level!) <= levelIndex(lv)).map((w) => w.id));
  const known = upTo('L1');
  const test = upTo('L2');
  const input = {
    lexicon,
    sentences,
    // the learner's answered test words (here: every L1-and-below word, in a fixed order)
    wordIds: [...known].sort(),
    comprehensibleIds: known,
    testWordIds: test,
    target: 'L2' as const,
    index,
    preferred: known,
  };

  const rounds: DrillItem[][] = [];
  for (let i = 0; i < 12; i++) {
    const avoid = new Set(rounds.flat().flatMap((it) => it.sentenceIds));
    rounds.push(buildDrillRound({ ...input, seed: `round-${i}`, wordIds: input.wordIds.slice(i * 60), avoid }));
  }
  const items = rounds.flat();

  it('builds full rounds of 5 with all three item types', () => {
    for (const r of rounds) expect(r).toHaveLength(5);
    const types = new Set(items.map((i) => i.type));
    expect([...types].sort()).toEqual(['context', 'gap', 'meaning']);
  });

  it('every option set is fair: one right answer, no repeats, never the odd one out', () => {
    for (const it of items) {
      expect(it.options.length, it.id).toBeGreaterThanOrEqual(3);
      expect(new Set(it.options).size, it.id).toBe(it.options.length);
      expect(it.answer).toBeGreaterThanOrEqual(0);
      if (it.type === 'gap') {
        const right = it.options[it.answer]!;
        expect(right).toBe(lexicon.byId(it.wordId)!.headword);
        expect(oddOneOut(right, it.options), `${it.id}: ${it.options.join(' / ')}`).toBe(false);
      }
    }
  });

  it('no passage breaks the coverage rule (≥ 95% readable or test words, ≤ 2 above the target, Taiwan only)', () => {
    for (const it of items) {
      const text = it.passage.map((s) => s.map((x) => (x.mark === 'blank' ? lexicon.byId(it.wordId)!.headword : x.text)).join('')).join('');
      const check = checkDrillPassage(text, input);
      expect(check.ok, `${it.id}: ${text} ${JSON.stringify(check)}`).toBe(true);
    }
  });

  it('a gap passage is 2–4 sentences when the lesson has neighbours, and the blank hides the answer', () => {
    const gaps = items.filter((i) => i.type === 'gap');
    expect(gaps.length).toBeGreaterThan(5);
    for (const g of gaps) {
      expect(g.passage.length).toBeLessThanOrEqual(4);
      const shown = g.passage.flat().filter((x) => x.mark !== 'blank').map((x) => x.text).join('');
      expect(shown.includes(g.options[g.answer]!), g.id).toBe(false);
    }
    expect(gaps.filter((g) => g.passage.length >= 2).length).toBeGreaterThan(gaps.length / 2);
  });

  it('a round never repeats a sentence', () => {
    for (const r of rounds) {
      const ids = r.flatMap((i) => i.sentenceIds);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
