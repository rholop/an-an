import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LEARNER_CONFIG,
  gradeSentenceDictation,
  listeningEvidenceKind,
  type AudioManifest,
  type Evidence,
  type Word,
} from '@anan/core';
import { Lexicon, makeClipLookup } from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { LearnerService } from './learner-service.js';
import { ensureListeningCards, recordListeningEvidence } from './listening.js';

let db: AnanDB;
let learner: LearnerService;
const now = new Date('2026-03-10T12:00:00Z');

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  learner = new LearnerService(new DexieLearnerRepo(db), DEFAULT_LEARNER_CONFIG);
});
afterEach(async () => {
  await db.delete();
});

const w = (id: string, headword: string, pinyinNumeric: string): Word => ({
  id, headword, variants: [], pos: ['N'], level: 'N1', source: 'tocfl', pinyin: pinyinNumeric,
  pinyinNumeric, zhuyin: '', glossEn: id, chars: [...headword], tags: [],
});
const words = [w('w-cafe', '咖啡', 'ka1 fei1'), w('w-ni', '你', 'ni3'), w('w-hao', '好', 'hao3')];
const manifest = {
  meta: { version: 1, builtAt: '', voice: 'v' },
  words: Object.fromEntries(
    ['w-cafe', 'w-ni'].map((id) => [id, { file: `${id}.mp3`, voice: 'v', hash: `h-${id}`, status: 'auto_ok', text: id, zhuyin: '' }]),
  ),
  sentences: {},
} as unknown as AudioManifest;
const hasClip = makeClipLookup(manifest, {});

async function reviewCard(id: string) {
  await learner.record({ item: { kind: 'word', id }, skill: 'recognition', kind: 'review_good', at: now }, now);
}

describe('ensureListeningCards', () => {
  it('creates a listening card only for a reviewed item with a usable clip, once', async () => {
    const deps = { db, recordBulk: (e: Parameters<typeof learner.recordBulk>[0], n: Date) => learner.recordBulk(e, n) };
    // Not yet in review: nothing created.
    await reviewCard('w-cafe');
    expect(await ensureListeningCards(hasClip, now, deps)).toEqual([]);
    // Bring recognition up to the review state, plus one item without a clip.
    for (const id of ['w-cafe', 'w-hao']) {
      for (let i = 0; i < 6; i++) await reviewCard(id);
    }
    const created = await ensureListeningCards(hasClip, now, deps);
    const ids = created.map((c) => c.item.id);
    expect(ids).toContain('w-cafe');
    expect(ids).not.toContain('w-hao'); // no clip
    expect(created.every((c) => c.skill === 'listening' && c.card.reps === 0)).toBe(true);
    expect((await ensureListeningCards(hasClip, now, deps)).length).toBe(created.length);
  });
});

describe('recordListeningEvidence', () => {
  const rec = (e: Evidence, at: Date) => learner.record(e, at);

  it('writes nothing for a skipped exercise ("Sounds wrong")', async () => {
    expect(await recordListeningEvidence(rec, new Set(['w-cafe']), [], now)).toBe(0);
    expect(await db.evidence.count()).toBe(0);
  });

  it('records only for items that have a listening card', async () => {
    const n = await recordListeningEvidence(
      rec,
      new Set(['w-cafe']),
      [
        { wordId: 'w-cafe', kind: 'listening_correct' },
        { wordId: 'w-ni', kind: 'listening_wrong' },
      ],
      now,
    );
    expect(n).toBe(1);
    const rows = await db.evidence.toArray();
    expect(rows.map((r) => [r.item.id, r.skill, r.kind])).toEqual([['w-cafe', 'listening', 'listening_correct']]);
  });

  it('sentence dictation gives per-word evidence: right words Good, a missed word Again', async () => {
    const lex = new Lexicon(words);
    const g = gradeSentenceDictation('你', '你好', lex);
    const evidence = g.words.map((x) => ({
      wordId: x.wordId!,
      kind: listeningEvidenceKind(x.hit ? 'correct' : 'wrong', { replays: 0, slow: false }),
    }));
    await recordListeningEvidence(rec, new Set(['w-ni', 'w-hao']), evidence, now);
    const rows = await db.evidence.toArray();
    expect(rows.find((r) => r.item.id === 'w-ni')?.kind).toBe('listening_correct');
    expect(rows.find((r) => r.item.id === 'w-hao')?.kind).toBe('listening_wrong');
  });
});
