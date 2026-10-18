import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_SETTINGS,
  DEFAULT_STUDY_SETTINGS,
  checkTaiwanness,
  displayLevel,
  tutorLessonOf,
  Lexicon,
  type GrammarItem,
  type TutorCheckRequest,
  type TutorCheckResponse,
  type TutorGrammarPracticeRequest,
  type TutorGrammarPracticeResponse,
  type TutorExtraction,
  type TutoringLLM,
  type TutorScenarioRequest,
  type TutorScenarioResponse,
  type Word,
} from '@anan/core';
import { AnanDB } from '../../db/schema.js';
import { exportBackup } from '../../db/backup.js';
import { mergeBackups } from '../../db/merge.js';
import { ledgerFrom } from '../ledger.js';
import { ProxyTurnError } from '../tutor-llm.js';
import { loadTaiwanConverters } from '../opencc.js';
import { notesMainlandLine } from '../labels.js';
import { TutoringService } from './tutoring-service.js';
import { ensureTutorCards } from './introduce.js';
import { DexieLearnerRepo } from '../../db/learner-repo.js';
import { LearnerService } from '../learner-service.js';

const ROOT = path.resolve(__dirname, '../../../../..');
const lexFile = JSON.parse(readFileSync(path.join(ROOT, 'data/build/lexicon.v2.json'), 'utf8')) as {
  words: Word[];
  grammar: GrammarItem[];
};
const lexicon = new Lexicon(lexFile.words, lexFile.grammar);
/** The owner's PDF (fixtures/39-italki-summary-2026-10-13.pdf) as Gemini read it (recorded). */
const EXTRACTION = JSON.parse(
  readFileSync(path.join(ROOT, 'packages/core/src/test-fixtures/tutor-italki-2026-10-13.extraction.json'), 'utf8'),
) as TutorExtraction;
const settings = { ...DEFAULT_SESSION_SETTINGS, timeZone: 'America/New_York' };
const NOW = new Date('2026-10-13T16:00:00Z');

class FakeTutoringLLM implements TutoringLLM {
  checks: TutorCheckRequest[] = [];
  scenarios: TutorScenarioRequest[] = [];
  constructor(private readonly fail?: 'extract' | 'scenario') {}
  async extractTutorSummary(): Promise<TutorExtraction> {
    if (this.fail === 'extract') throw new ProxyTurnError('quota_exhausted', 503, true, new Date('2026-10-14T07:00:00Z'));
    return structuredClone(EXTRACTION);
  }
  async checkTutorSentences(req: TutorCheckRequest): Promise<TutorCheckResponse> {
    this.checks.push(req);
    return { results: req.sentences.map((s) => ({ id: s.id, ok: true })) };
  }
  async writeTutorScenario(req: TutorScenarioRequest): Promise<TutorScenarioResponse> {
    this.scenarios.push(req);
    if (this.fail === 'scenario') throw new ProxyTurnError('quota_exhausted', 503, true);
    return {
      title: 'Ordering a late-night snack',
      setting: 'A night market stall in Taipei at 11 pm.',
      npcName: 'Carl',
      personality: 'friendly stall owner',
      speechStyle: 'short and casual',
      goalSteps: [{ description: 'Order a late-night snack', keywordHints: ['宵夜'] }],
      opener: { zh: '你好！你要吃什麼宵夜？', en: 'Hi! What late-night snack would you like?' },
      successLine: { zh: '好，馬上來！', en: 'OK, coming right up!' },
    };
  }
}

/** A Learned card (recognition, in review, answered here). */
const learnedCard = (id: string) => ({
  pk: `word:${id}:recognition`,
  item: { kind: 'word' as const, id },
  skill: 'recognition' as const,
  card: {
    due: new Date('2026-11-01T00:00:00Z'),
    stability: 10,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 10,
    learning_steps: 0,
    reps: 3,
    lapses: 0,
    state: 2,
    last_review: new Date('2026-10-10T00:00:00Z'),
  },
  state: 'review' as const,
  lapses: 0,
  leech: false,
  leechTreatmentsTried: [],
  familiarity: 0,
  readingDependence: 0,
  flags: {},
  source: 'review' as const,
  updatedAt: new Date('2026-10-10T00:00:00Z'),
});

const id = (zh: string) => lexicon.lookup(zh)[0]!.id;

let db: AnanDB;
beforeEach(async () => {
  db = new AnanDB(`anan-tutor-${Math.random()}`);
  // The fixture profile already learned 吃, 可以 and 時間.
  await db.items.bulkPut(['吃', '可以', '時間'].map((zh) => learnedCard(id(zh))) as never);
});
afterEach(async () => {
  db.close();
  await db.delete();
});

/** The app's ledger: the saved classes are its tutoring lessons (custom words resolve once stored). */
const ledgerNow = async (now: Date) =>
  ledgerFrom(db, now, {
    settings,
    study: {
      lexicon,
      resolves: () => true,
      books: [],
      settings: { ...DEFAULT_STUDY_SETTINGS, enabled: true },
      tutorLessons: (await db.tutorSessions.toArray()).map(tutorLessonOf),
    },
  });
const service = (llm: TutoringLLM) => {
  const learner = new LearnerService(new DexieLearnerRepo(db));
  return new TutoringService(db, lexicon, llm, ledgerNow, loadTaiwanConverters, (now) =>
    ensureTutorCards(now, { ledger: ledgerNow, recordBulk: (e, n) => learner.recordBulk(e, n) }),
  );
};

describe('Tutoring sessions (phase 39), the owner\'s PDF', () => {
  it('extracts 20 words and 8 grammar points in traditional characters, with Taiwan words and readings', async () => {
    const { draft, existing } = await service(new FakeTutoringLLM()).draftFromExtraction(EXTRACTION, NOW);
    expect(existing).toBeUndefined();
    expect(draft.tutor).toBe('Carl');
    expect(draft.date).toBe('2026-10-13T07:00');
    expect(draft.topics.map((t) => t.zh)).toEqual(['食物與一日三餐', '健康與就醫', '地點與服務']);
    // The printed list has 20 entries (the brief counted 19).
    expect(draft.words).toHaveLength(20);
    expect(draft.grammar).toHaveLength(8);
    for (const w of draft.words) {
      const entry = lexicon.byId(w.wordId) ?? w.custom!;
      expect([entry.headword, ...entry.variants]).toContain(w.zh);
    }
    expect(draft.words.map((w) => w.zh)).toEqual([
      '餅乾', '炒麵', '點心', '宵夜', '國語', '時間', '可以', '能', '藥物', '藥局',
      '郵局', '警察局', '早餐', '晚餐', '煮', '冰淇淋', '義大利麵', '剛剛', '吃', '跟',
    ]);
    // 普通话 → the Taiwan words 國語 / 中文; the mainland one is "also said in mainland China"
    const guoyu = draft.words.find((w) => w.printed === '普通话')!;
    expect(guoyu).toMatchObject({ zh: '國語', mainlandForm: '普通話', alsoTaiwan: ['中文'] });
    expect(guoyu.statuses).toContain('mainland');
    expect(guoyu.example.zh).toBe('我會說國語。');
    // 意大利面 → 義大利麵, not in the word list: a custom word with a reading from MOE characters
    const pasta = draft.words.find((w) => w.printed === '意大利面')!;
    expect(pasta).toMatchObject({ zh: '義大利麵', mainlandForm: '意大利麵', readingChecked: true });
    expect(pasta.statuses).toEqual(['new', 'mainland', 'custom']);
    expect(pasta.custom?.zhuyin).toBe('ㄧˋ ㄉㄚˋ ㄌㄧˋ ㄇㄧㄢˋ');
    // The Taiwan reading wins; the notes' differing one is shown
    const dianxin = draft.words.find((w) => w.zh === '點心')!;
    expect(dianxin.pinyin).toBe(lexicon.byId(dianxin.wordId)!.pinyin);
    expect(dianxin.pinyinNote).toBe('diǎnxin');
    expect(draft.words.find((w) => w.zh === '餅乾')!.pinyinNote).toBeUndefined();
    // 吃's "make a living by relying on something" is dropped
    const chi = draft.words.find((w) => w.zh === '吃')!;
    expect(chi.gloss).toMatch(/eat/);
    expect(chi.notesGloss).toBeUndefined();
    // 跟 links to its "and; with" sense
    expect(lexicon.byId(draft.words.find((w) => w.zh === '跟')!.wordId)!.glossEn).toMatch(/with/);
  });

  it('unticks 吃, 可以 and 時間 (already learned) and ticks the rest', async () => {
    const { draft } = await service(new FakeTutoringLLM()).draftFromExtraction(EXTRACTION, NOW);
    const unticked = draft.words.filter((w) => !w.ticked).map((w) => w.zh);
    expect(unticked.sort()).toEqual(['可以', '吃', '時間'].sort());
    for (const zh of ['可以', '吃', '時間']) expect(draft.words.find((w) => w.zh === zh)!.statuses[0]).toBe('learned');
  });

  it('matches 剛剛, 還沒, 的時候 and 跟…一起 to grammar items; the odd points are notes', async () => {
    const { draft } = await service(new FakeTutoringLLM()).draftFromExtraction(EXTRACTION, NOW);
    const match = Object.fromEntries(draft.grammar.map((g) => [g.name, g.matchId]));
    expect(match['剛剛在動詞']).toBe('gram-ganggang-just');
    expect(match['還沒還沒有動詞']).toBe('gram-hai-still');
    expect(match['的時候']).toBe('gram-de-shihou');
    expect(match['跟人一起或動詞']).toBe('gram-gen-yiqi');
    // Phase 46: a point comparing 可以 and 能 matches both (first 可以, the one its example uses)
    expect(match['可以 vs 能不能']).toBe('gram-keyi-permission');
    expect(match['什麼在疑問句中的用法']).toBe('gram-shenme-question');
    expect(match['省略成分']).toBeUndefined();
  });

  it('checks only sentences worth practising; the others are shown with the class', async () => {
    const llm = new FakeTutoringLLM();
    const { draft } = await service(llm).draftFromExtraction(EXTRACTION, NOW);
    expect(llm.checks).toHaveLength(1);
    const sent = llm.checks[0]!.sentences;
    for (const s of sent) expect(s.zh).not.toMatch(/[们这说饭]/);
    const all = [...draft.words.map((w) => w.example), ...draft.grammar.map((g) => g.example)];
    for (const s of all.filter((x) => x.practice)) expect(s.checked).toBe(true);
    // a beginner knows few words: most examples have more than 2 unknown words and are display-only
    const shown = all.filter((x) => !x.practice);
    for (const s of shown) expect(s.reason).toBeTruthy();
    expect(sent.length).toBe(all.length - shown.length);
  });

  it('nothing is created before Save; Save stores the session and its custom words', async () => {
    const llm = new FakeTutoringLLM();
    const svc = service(llm);
    const { draft } = await svc.draftFromExtraction(EXTRACTION, NOW);
    // Discard = never saving: no session, no custom word, no card
    expect(await db.tutorSessions.count()).toBe(0);
    expect(await db.customWords.count()).toBe(0);
    expect(await db.items.count()).toBe(3);

    const { record: rec, introduced } = await svc.save(draft, 'N1', NOW);
    expect(await db.tutorSessions.count()).toBe(1);
    expect(rec.words.filter((w) => w.ticked)).toHaveLength(17);
    expect((await db.customWords.toArray()).map((w) => w.headword)).toEqual(['義大利麵']);
    expect(rec.scenario).toMatchObject({ title: 'Ordering a late-night snack', tutor: { sessionId: rec.id } });
    expect(rec.scenario!.vocabExtras).toContain('宵夜');
    expect(rec.grammar.filter((g) => !g.grammarId).map((g) => g.name)).toEqual(['省略成分']);
    // Save adds the ticked words to study at once (owner, 2026-10-13), each as a New card
    expect(introduced).toBe(17);
    const ledger = await ledgerNow(NOW);
    expect(ledger.tutorNewCards().map((c) => c.item.id).sort()).toEqual(rec.words.filter((w) => w.ticked).map((w) => w.wordId).sort());
    // Phase 43: they lead the next session's new words (12:00 is between sessions), inside the day's
    // limit, Meaning cards only (Pick and Say it follow once Meaning is consistently known)
    const next = ledger.session({ early: true });
    const ticked = rec.words.filter((x) => x.ticked).map((w) => w.wordId);
    expect(next.fresh.length).toBeGreaterThan(0);
    expect(next.fresh.length).toBeLessThanOrEqual(15);
    expect(next.fresh.every((c) => c.skill === 'recognition' && ticked.includes(c.item.id))).toBe(true);
    expect(next.cards.some((c) => c.skill === 'production' || c.skill === 'reading')).toBe(false);
  });

  it('a quota stop during the upload saves nothing; one at Save gets the plain scenario', async () => {
    await expect(service(new FakeTutoringLLM('extract')).draftFromPages([{ mimeType: 'image/jpeg', data: 'AAAA' }], NOW)).rejects.toMatchObject({
      quota: true,
    });
    expect(await db.tutorSessions.count()).toBe(0);
    expect(await db.customWords.count()).toBe(0);

    const svc = service(new FakeTutoringLLM('scenario'));
    const { draft } = await svc.draftFromExtraction(EXTRACTION, NOW);
    const { record: rec } = await svc.save(draft, 'N1', NOW);
    expect(rec.scenario?.title).toBe('Chat about Food and Three Meals a Day');
    expect(rec.scenario?.npc.name).toBe('Carl');
  });

  it('re-uploading the same PDF updates the session (same id, no duplicates) and it syncs', async () => {
    const svc = service(new FakeTutoringLLM());
    const { record: first } = await svc.save((await svc.draftFromExtraction(EXTRACTION, NOW)).draft, 'N1', NOW);
    const cards = await db.items.count();
    const later = new Date(NOW.getTime() + 3_600_000);
    const again = await svc.draftFromExtraction(EXTRACTION, later);
    expect(again.existing?.id).toBe(first.id);
    const { record: second, introduced } = await svc.save(again.draft, 'N1', later);
    expect(second.id).toBe(first.id);
    expect(introduced).toBe(0);
    expect(await db.items.count()).toBe(cards);
    expect(second.createdAt).toEqual(first.createdAt);
    expect(await db.tutorSessions.count()).toBe(1);
    expect(await db.customWords.count()).toBe(1);

    // synced per profile: the other device's copy merges in by id (the later one wins)
    const other = new AnanDB(`anan-tutor-other-${Math.random()}`);
    try {
      const merged = mergeBackups(await exportBackup(other), await exportBackup(db));
      expect(merged.tutorSessions.map((s) => s.id)).toEqual([first.id]);
    } finally {
      other.close();
      await other.delete();
    }
  });
});

describe('Phase 40: levels, topics and Taiwan wording (the owner\'s PDF)', () => {
  it('早餐, 晚餐, 藥局 and 警察局 have a level (none in "Other"); 義大利麵 gets an estimate and the food topic', async () => {
    const svc = service(new FakeTutoringLLM());
    const { draft } = await svc.draftFromExtraction(EXTRACTION, NOW);
    for (const zh of ['早餐', '晚餐', '藥局', '警察局']) {
      const w = draft.words.find((x) => x.zh === zh)!;
      expect(displayLevel(lexicon.byId(w.wordId)!), zh).not.toBeNull();
    }
    expect(draft.topicTags).toEqual(expect.arrayContaining(['food', 'health', 'places']));
    const { record } = await svc.save(draft, 'N1', NOW);
    expect(record.topicTags).toEqual(expect.arrayContaining(['food', 'health', 'places']));
    const pasta = (await db.customWords.toArray()).find((w) => w.headword === '義大利麵')!;
    expect(pasta.level).toBeNull();
    expect(pasta.estimatedLevel).toBeTruthy();
    expect(pasta.tags).toContain('topic:food');
  });

  it('炒面 → 炒麵 has no mainland label; 普通话 is labelled with 國語 / 中文', async () => {
    const { draft } = await service(new FakeTutoringLLM()).draftFromExtraction(EXTRACTION, NOW);
    const chaomian = draft.words.find((w) => w.zh === '炒麵')!;
    expect(chaomian.statuses).not.toContain('mainland');
    expect(chaomian.mainlandForm).toBeUndefined();
    const guoyu = draft.words.find((w) => w.printed === '普通话')!;
    expect(guoyu.statuses).toContain('mainland');
    expect(notesMainlandLine(guoyu.printed, [guoyu.zh, ...(guoyu.alsoTaiwan ?? [])])).toBe(
      'The notes wrote 普通话 (mainland usage) · Taiwan: 國語 / 中文',
    );
  });

  it('a sentence that differs only by character variants stays practice', async () => {
    const one: TutorExtraction = {
      ...EXTRACTION,
      vocab: [{ zh: '炒面', pinyin: 'chǎomiàn', en: 'fried noodles', example: { zh: '我吃炒面。', en: 'I eat fried noodles.' } }],
      grammar: [],
    };
    const { draft } = await service(new FakeTutoringLLM()).draftFromExtraction(one, NOW);
    expect(draft.words[0]!.example).toMatchObject({ zh: '我吃炒麵。', practice: true });
  });

  it('nothing saved from tutoring contains a simplified character', async () => {
    const svc = service(new FakeTutoringLLM());
    const { draft } = await svc.draftFromExtraction(EXTRACTION, NOW);
    const { record } = await svc.save(draft, 'N1', NOW);
    const conv = await loadTaiwanConverters();
    const saved = [
      ...record.words.filter((w) => w.ticked).map((w) => w.zh),
      ...record.sentences.filter((x) => x.practice).map((x) => x.zh),
      ...(await db.customWords.toArray()).flatMap((w) => [w.headword, ...w.variants]),
    ];
    for (const text of saved) {
      expect(checkTaiwanness(text).simplifiedChars, text).toEqual([]);
      expect(conv.toTraditional(text), text).toBe(text);
    }
  });

  it('"Re-check levels and topics" is idempotent', async () => {
    const svc = service(new FakeTutoringLLM());
    const { draft } = await svc.draftFromExtraction(EXTRACTION, NOW);
    await svc.save(draft, 'N1', NOW);
    // a class saved before Phase 40: no topics, no estimates on its custom word
    const [rec] = await db.tutorSessions.toArray();
    await db.tutorSessions.update(rec!.id, { topicTags: undefined });
    const pasta = (await db.customWords.toArray())[0]!;
    await db.customWords.put({ ...pasta, estimatedLevel: undefined, levelSource: undefined, tags: ['tutor'] } as never);
    expect(await svc.recheckLevelsAndTopics(NOW)).toBe(1);
    const after = (await db.customWords.toArray())[0]!;
    expect(after.estimatedLevel).toBeTruthy();
    expect(after.tags).toContain('topic:food');
    expect((await db.tutorSessions.toArray())[0]!.topicTags).toEqual(expect.arrayContaining(['food']));
    expect(await svc.recheckLevelsAndTopics(NOW)).toBe(0);
  });

  it('a class saved with simplified characters is fixed by the re-check (OpenCC, no AI)', async () => {
    const svc = service(new FakeTutoringLLM());
    const { draft } = await svc.draftFromExtraction(EXTRACTION, NOW);
    await svc.save(draft, 'N1', NOW);
    const [rec] = await db.tutorSessions.toArray();
    const words = rec!.words.map((w) => (w.zh === '餅乾' ? { ...w, zh: '饼干' } : w));
    const sentences = rec!.sentences.map((x, i) => (i === 0 ? { ...x, zh: '我们吃饭。' } : x));
    await db.tutorSessions.update(rec!.id, { words, sentences });
    expect(await svc.recheckLevelsAndTopics(NOW)).toBe(1);
    const after = (await db.tutorSessions.toArray())[0]!;
    expect(after.words.find((w) => w.printed === rec!.words.find((x) => x.zh === '餅乾')!.printed)!.zh).toBe('餅乾');
    expect(after.sentences[0]!.zh).toBe('我們吃飯。');
    // traditional text is never touched
    expect(after.words.map((w) => w.zh).filter((zh) => zh !== '餅乾')).toEqual(rec!.words.map((w) => w.zh).filter((zh) => zh !== '餅乾'));
  });
});

describe('Phase 46: tutoring grammar in traditional characters, matched right, always practisable', () => {
  const SIMPLIFIED_ONLY = /[们这说饭刚还动词没时语间点么后从厕吗]/;

  it('every grammar name and explanation is traditional (還沒, 剛剛在動詞) after Save', async () => {
    const svc = service(new FakeTutoringLLM());
    const { draft } = await svc.draftFromExtraction(EXTRACTION, NOW);
    for (const g of draft.grammar) {
      expect(g.name).not.toMatch(SIMPLIFIED_ONLY);
      expect(g.explanationEn).not.toMatch(SIMPLIFIED_ONLY);
      expect(checkTaiwanness(g.explanationEn).simplifiedChars).toEqual([]);
    }
    expect(draft.grammar.find((g) => g.name === '剛剛在動詞')!.explanationEn).toContain('剛剛在動詞');
    expect(draft.grammar.find((g) => g.name === '還沒還沒有動詞')!.explanationEn).toContain('“還沒” or “還沒有”');
    const { record } = await svc.save(draft, 'N1', NOW);
    for (const g of record.grammar) expect(`${g.name} ${g.explanationEn} ${g.example.zh}`).not.toMatch(SIMPLIFIED_ONLY);
  });

  it('可以 vs 能 is two rows of one point (both items), never only 能 with a 可以 explanation; nothing matches on 了 or 會 alone', async () => {
    const svc = service(new FakeTutoringLLM());
    const { draft } = await svc.draftFromExtraction(EXTRACTION, NOW);
    const cmp = draft.grammar.find((g) => g.name === '可以 vs 能不能')!;
    expect(cmp.matches!.map((m) => m.id)).toEqual(['gram-keyi-permission', 'gram-neng-possibility']);
    for (const g of draft.grammar)
      expect(g.matches?.map((m) => m.id) ?? []).not.toEqual(expect.arrayContaining(['gram-le-completion']));
    expect(draft.grammar.find((g) => g.name === '省略成分')!.matchId).toBeUndefined();
    const { record } = await svc.save(draft, 'N1', NOW);
    const rows = record.grammar.filter((g) => g.name === '可以 vs 能不能');
    expect(rows.map((r) => r.grammarId)).toEqual(['gram-keyi-permission', 'gram-neng-possibility']);
    expect(new Set(rows.map((r) => r.point)).size).toBe(1);
    expect(tutorLessonOf(record).grammarIds).toEqual(expect.arrayContaining(['gram-keyi-permission', 'gram-neng-possibility', 'gram-ganggang-just']));
  });

  it('Save writes checked practice sentences for a point with fewer than 3, and only then', async () => {
    class WritingLLM extends FakeTutoringLLM {
      practice: TutorGrammarPracticeRequest[] = [];
      async writeGrammarPractice(req: TutorGrammarPracticeRequest): Promise<TutorGrammarPracticeResponse> {
        this.practice.push(req);
        // one simplified (converted), one without the marker (dropped), two good
        return { sentences: [{ zh: '他刚刚回家。', en: 'He just went home.' }, { zh: '我在吃飯。', en: 'I am eating.' }, { zh: '你剛剛去哪裡？', en: 'Where did you just go?' }] };
      }
    }
    const llm = new WritingLLM();
    const learner = new LearnerService(new DexieLearnerRepo(db));
    // no textbook or bank sentences at all: every matched point is short of sentences except by its
    // class example and the supplement's own
    const svc = new TutoringService(
      db,
      new Lexicon(lexFile.words, lexFile.grammar.map((g) => (g.id === 'gram-ganggang-just' ? { ...g, practice: [] } : g))),
      llm,
      ledgerNow,
      loadTaiwanConverters,
      (now) => ensureTutorCards(now, { ledger: ledgerNow, recordBulk: (e, n) => learner.recordBulk(e, n) }),
      { practiceSources: async () => ({ textbook: [], bank: [] }) },
    );
    const { draft } = await svc.draftFromExtraction(EXTRACTION, NOW);
    const { record } = await svc.save(draft, 'N1', NOW);
    const asked = llm.practice.map((r) => r.markers.join('/'));
    expect(asked).toContain('剛剛/剛');
    const written = record.sentences.filter((s) => s.written && s.grammarId === 'gram-ganggang-just').map((s) => s.zh);
    expect(written).toEqual(['他剛剛回家。', '你剛剛去哪裡？']);
    // the written ones passed the fresh check too
    expect(llm.checks.at(-1)!.sentences.map((s) => s.zh)).toContain('他剛剛回家。');
    // a point with enough sentences (its supplement ones) is not written for
    expect(asked).not.toContain('的時候');
  });

  it('the one-time fix converts a saved class\'s simplified notes and re-checks its matches (listed once)', async () => {
    const svc = service(new FakeTutoringLLM());
    const { draft } = await svc.draftFromExtraction(EXTRACTION, NOW);
    const { record } = await svc.save(draft, 'N1', NOW);
    // as Phase 39 saved it: simplified notes, 可以 vs 能 matched to 能 only
    const old = record.grammar
      .filter((g, i, all) => all.findIndex((x) => x.name === g.name) === i)
      .map(({ point: _p, ...g }) => (g.name === '可以 vs 能不能' ? { ...g, grammarId: 'gram-neng-possibility' } : g))
      // the notes' own (simplified) explanations, in the notes' order
      .map((g, i) => ({ ...g, explanationEn: EXTRACTION.grammar[i]!.explanationEn }));
    await db.tutorSessions.update(record.id, { grammar: old });
    expect(await svc.migrateGrammar(NOW)).toBe(1);
    const after = (await db.tutorSessions.get(record.id))!;
    for (const g of after.grammar) expect(g.explanationEn).not.toMatch(SIMPLIFIED_ONLY);
    expect(after.grammar.filter((g) => g.name === '可以 vs 能不能').map((g) => g.grammarId)).toEqual(['gram-keyi-permission', 'gram-neng-possibility']);
    expect(after.grammarRecheck!.changes).toEqual([{ name: '可以 vs 能不能', from: ['S + (Adv) + 能 + V (O)'], to: ['S + 可以 + V (O)', 'S + (Adv) + 能 + V (O)'] }]);
    await svc.markGrammarRecheckSeen(record.id);
    expect((await db.tutorSessions.get(record.id))!.grammarRecheck!.seen).toBe(true);
    // idempotent
    expect(await svc.migrateGrammar(NOW)).toBe(0);
  });

  it('"Make this a note" removes the point\'s exercise and keeps the answers already recorded', async () => {
    const svc = service(new FakeTutoringLLM());
    const { draft } = await svc.draftFromExtraction(EXTRACTION, NOW);
    const { record } = await svc.save(draft, 'N1', NOW);
    const learner = new LearnerService(new DexieLearnerRepo(db));
    const ev = { item: { kind: 'grammar' as const, id: 'gram-neng-possibility' }, skill: 'recognition' as const, kind: 'cloze_correct_nohint' as const, at: NOW, context: { source: 'tutor' as const, refId: record.id } };
    await learner.record(ev, NOW);
    const before = await db.evidence.count();
    const idx = record.grammar.findIndex((g) => g.grammarId === 'gram-neng-possibility');
    const next = (await svc.setGrammarMatch(record.id, idx, null, NOW))!;
    expect(next.grammar.filter((g) => g.name === '可以 vs 能不能')).toEqual([expect.objectContaining({ matchedBy: 'owner' })]);
    expect(next.grammar.find((g) => g.name === '可以 vs 能不能')!.grammarId).toBeUndefined();
    expect(tutorLessonOf(next).grammarIds).not.toContain('gram-neng-possibility');
    expect(await db.evidence.count()).toBeGreaterThanOrEqual(before);
    expect((await db.evidence.toArray()).some((e) => e.item.id === 'gram-neng-possibility' && e.kind === 'cloze_correct_nohint')).toBe(true);
    // the re-check never undoes the owner's choice
    await svc.migrateGrammar(NOW);
    expect((await db.tutorSessions.get(record.id))!.grammar.find((g) => g.name === '可以 vs 能不能')!.grammarId).toBeUndefined();
  });
});
