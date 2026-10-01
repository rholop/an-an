import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCustomWord, matchAnkiRows, parseDelimitedText, summarizeAnkiMatch } from '@anan/core';
import { Lexicon, type Word } from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { LearnerService } from './learner-service.js';

let db: AnanDB;
let service: LearnerService;

beforeEach(() => {
  db = new AnanDB(`anan-perf-test-${Math.random()}`);
  service = new LearnerService(new DexieLearnerRepo(db));
});

afterEach(async () => {
  await db.delete();
});

function word(id: string, headword: string): Word {
  return {
    id,
    headword,
    variants: [],
    pos: ['N'],
    level: 'N1',
    source: 'tocfl',
    pinyin: '',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn: '',
    chars: [...headword],
    tags: [],
  };
}

describe('Anki import at 3,000-row scale (phase-2 acceptance criterion)', () => {
  it('parses, matches, and bulk-persists 3,000 rows in well under the "a few seconds" bar', async () => {
    // Half the rows exactly match real lexicon words, half are unmatched —
    // a realistic mixed deck, not a best case.
    const lexiconWords = Array.from({ length: 1500 }, (_, i) => word(`w${i}`, `詞${i}`));
    const lexicon = new Lexicon(lexiconWords);

    const deckLines = [
      ...lexiconWords.map((w, i) => `${w.headword}\tpy${i}\tgloss${i}`),
      ...Array.from({ length: 1500 }, (_, i) => `生${i}詞\tpy${i}\tunmatched gloss${i}`),
    ];
    const raw = deckLines.join('\n');

    const t0 = performance.now();

    const rows = parseDelimitedText(raw);
    expect(rows).toHaveLength(3000);

    const results = matchAnkiRows(rows, 0, lexicon);
    const summary = summarizeAnkiMatch(results);
    expect(summary).toEqual({ total: 3000, matched: 1500, ambiguous: 0, unmatched: 1500 });

    const now = new Date();
    const matchedEvents = results
      .filter((r) => r.status === 'matched')
      .map((r) => ({
        item: { kind: 'word' as const, id: r.word!.id },
        skill: 'recognition' as const,
        kind: 'anki_import_seen' as const,
        at: now,
      }));
    await service.recordBulk(matchedEvents, now);

    const customWords = results.filter((r) => r.status === 'unmatched').map((r) => buildCustomWord(r.headword, r.row[1], r.row[2]));
    await db.customWords.bulkPut(customWords);

    const elapsedMs = performance.now() - t0;

    expect(await db.items.count()).toBe(1500);
    expect(await db.customWords.count()).toBe(1500);
    // "completes in seconds" — assert well inside that, with headroom for
    // slower CI machines (fake-indexeddb in Node is already faster than a
    // real browser's IndexedDB, so this is a conservative, not optimistic, bound).
    expect(elapsedMs).toBeLessThan(5000);
  });
});
