import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { GrammarItem } from '../types.js';
import {
  applyTutorCheck,
  matchTutorGrammar,
  normalizeTutorDate,
  splitPinyinForChars,
  tutorSessionId,
  type TutorDraft,
  type TutorDraftSentence,
} from './draft.js';
import { tutorClozeSentences, tutorLessonItems, tutorLessonOf, type TutorSessionRecord } from './session.js';

const g = (id: string, pattern: string): GrammarItem => ({ id, pattern, level: 'L1', explanationEn: '', examples: [] });
const lexicon = new Lexicon([], [g('gram-ganggang-just', 'S + 剛剛 + V'), g('gram-hai-still', '還沒 V'), g('gram-time-place-order', 'S + Time + Place + V')]);

describe('tutor session ids and dates', () => {
  it.each([
    ['2026-10-13T07:00', '2026-10-13T07:00'],
    ['2026-10-13 19:30', '2026-10-13T19:30'],
    ['2026-10-13', '2026-10-13T00:00'],
    ['not a date', ''],
  ])('normalizeTutorDate(%s) = %s', (raw, want) => expect(normalizeTutorDate(raw)).toBe(want));

  it('the same day and tutor give the same id (re-upload updates), another tutor another id', () => {
    expect(tutorSessionId('2026-10-13T07:00', 'Carl')).toBe(tutorSessionId('2026-10-13 19:00', ' carl '));
    expect(tutorSessionId('2026-10-13T07:00', 'Carl')).not.toBe(tutorSessionId('2026-10-13T07:00', 'Mei'));
    expect(tutorSessionId('2026-10-13T07:00', 'Carl')).toMatch(/^tutor-2026-10-13-/);
  });
});

describe('splitPinyinForChars', () => {
  it.each([
    ['bǐnggān', 2, ['bǐng', 'gān']],
    ['yào jú', 2, ['yào', 'jú']],
    ['jiéyùn', 2, ['jié', 'yùn']],
    ['biànlì shāngdiàn', 4, ['biàn', 'lì', 'shāng', 'diàn']],
    ['chī', 2, undefined],
  ] as const)('%s → %j', (p, n, want) => expect(splitPinyinForChars(p, n)).toEqual(want));
});

describe('matchTutorGrammar (names in Taiwan characters)', () => {
  it.each([
    ['剛剛 + 動詞', 'gram-ganggang-just'],
    ['還沒 + 動詞', 'gram-hai-still'],
    ['主語 + 時間 + 地點 + 動作', 'gram-time-place-order'],
    ['省略成分', undefined],
  ])('%s → %s', (name, id) => expect(matchTutorGrammar(name, lexicon)?.id).toBe(id));

  it('a rule whose item the lexicon lacks is skipped (a note, not a broken id)', () => {
    expect(matchTutorGrammar('的時候', lexicon)).toBeUndefined();
  });
});

describe('applyTutorCheck', () => {
  const s = (id: string, zh: string): TutorDraftSentence => ({ id, printed: zh, zh, en: 'x', practice: true });
  const draft = {
    sessionId: 't',
    date: '2026-10-13T07:00',
    tutor: 'Carl',
    topics: [],
    grammar: [],
    words: ['ok', 'fixed', 'bad-fix', 'no-answer'].map((id) => ({ zh: '捷運', example: s(id, '我搭捷運') })),
  } as unknown as TutorDraft;
  const out = applyTutorCheck(draft, {
    results: [
      { id: 'ok', ok: true },
      { id: 'fixed', ok: false, fixedZh: '我坐捷運去學校' },
      { id: 'bad-fix', ok: false, fixedZh: '我坐地铁', reason: 'odd' },
    ],
  });
  const ex = Object.fromEntries(out.words.map((w) => [w.example.id, w.example]));
  it('ok → checked; a clean fix that keeps the word → fixed and practised', () => {
    expect(ex.ok).toMatchObject({ checked: true, practice: true });
    expect(ex.fixed).toMatchObject({ zh: '我坐捷運去學校', fixed: true, practice: true });
  });
  it('a fix that is simplified or drops the word, or no answer → shown only, never practised', () => {
    expect(ex['bad-fix']).toMatchObject({ practice: false, checked: false });
    expect(ex['no-answer']).toMatchObject({ practice: false, reason: 'Not checked (try again later)' });
  });
});

describe('a saved session in study and Cloze', () => {
  const rec: TutorSessionRecord = {
    id: 'tutor-2026-10-13-x',
    date: '2026-10-13T07:00',
    tutor: 'Carl',
    topics: [],
    words: [
      { wordId: 'w1', zh: '機車', ticked: true },
      { wordId: 'w2', zh: '垃圾車', ticked: false },
    ],
    grammar: [{ name: '還沒', explanationEn: '', example: { zh: '', en: '' }, grammarId: 'gram-hai-still' }],
    sentences: [
      { id: 's1', zh: '我騎機車。', en: 'I ride a scooter.', wordId: 'w1', practice: true },
      { id: 's2', zh: '垃圾車來了。', en: 'The garbage truck is here.', wordId: 'w2', practice: false },
    ],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as TutorSessionRecord;

  it('only ticked words and matched grammar are the lesson', () => {
    expect(tutorLessonItems(tutorLessonOf(rec))).toEqual([
      { kind: 'word', id: 'w1' },
      { kind: 'grammar', id: 'gram-hai-still' },
    ]);
  });

  it('only practised sentences go to Cloze, labelled with the tutor', () => {
    const bank = tutorClozeSentences(rec, () => 'L1');
    expect(bank.map((b) => b.id)).toEqual(['s1']);
    expect(bank[0]).toMatchObject({ source: 'tutor', sourceLabel: 'from your class with Carl', targetWordId: 'w1' });
  });
});
