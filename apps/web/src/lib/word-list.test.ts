// Phase 38: the browser always has the current word list. The owner's case: a browser held an old
// lexicon (before the Phase 34 extras) next to a fresh book.json, and Review showed "(unknown item)".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLedger, DEFAULT_SESSION_SETTINGS, emptyCard, type Lexicon, type SkillCard, type Word } from '@anan/core';
import { closeSession, openSession } from '../db/instance.js';
import { checkForDataUpdate, dataUrl, onDataFilesChanged, resetDataFilesForTests } from './data-files.js';
import { markStudyDirty } from './study-dirty.js';
import { currentLexicon, LEXICON_FILE, resetLexiconForTests } from './useLexicon.js';
import { repairWordListOnce, resetWordListRepairForTests } from './word-list-repair.js';

const word = (id: string, headword = id): Word => ({
  id,
  headword,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: id,
  chars: [...headword],
  tags: [],
});
const lexFile = (ids: string[]) => ({ meta: { version: 'v2', buildDate: 'x', wordCount: ids.length }, words: ids.map((id) => word(id)), grammar: [] });
const OLD = lexFile(['core-a', 'core-b']); // cached before Phase 34
const NEW = lexFile(['core-a', 'core-b', 'extra-a']);

/** A tiny server: the manifest names the current hashed lexicon file. */
let served: { manifest: Record<string, string>; files: Record<string, unknown> };
const fetchMock = vi.fn(async (url: string) => {
  const path = String(url).replace(/^\//, '');
  if (path === 'data-manifest.json') return new Response(JSON.stringify({ version: 1, files: served.manifest }));
  const body = served.files[path];
  return body ? new Response(JSON.stringify(body)) : new Response('missing', { status: 404 });
});

const until = async (ok: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out');
};
const has = async (id: string) => !!(await currentLexicon())?.byId(id);

function card(id: string, now: Date): SkillCard {
  return {
    item: { kind: 'word', id },
    skill: 'recognition',
    card: { ...emptyCard(now), reps: 1, due: now },
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
  };
}
const ledgerWith = (lexicon: Lexicon, cards: SkillCard[], now: Date) =>
  buildLedger({
    cards,
    evidence: [],
    knownItems: [],
    session: DEFAULT_SESSION_SETTINGS,
    masteryShare: 0.8,
    now,
    study: {
      lexicon,
      resolves: (i) => (i.kind === 'word' ? lexicon.byId(i.id) : lexicon.grammarItemById(i.id)) !== undefined,
      books: [],
      settings: { enabled: false } as never,
    },
  });

beforeEach(() => {
  resetDataFilesForTests();
  resetLexiconForTests();
  resetWordListRepairForTests();
  served = {
    manifest: { [LEXICON_FILE]: 'lexicon/lexicon.v2.aaaaaaaaaa.json' },
    files: { 'lexicon/lexicon.v2.aaaaaaaaaa.json': OLD },
  };
  vi.stubGlobal('fetch', fetchMock);
  openSession('ron');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  closeSession();
});

describe('versioned data files (Phase 38 Part A)', () => {
  it('data files load by their content-hashed name; a new manifest reports what changed', async () => {
    expect(await dataUrl(LEXICON_FILE)).toBe('/lexicon/lexicon.v2.aaaaaaaaaa.json');
    expect(await dataUrl('scenarios/scenarios.json')).toBe('/scenarios/scenarios.json'); // not listed: plain name
    const heard: string[][] = [];
    const off = onDataFilesChanged((c) => heard.push(c));
    served.manifest = { [LEXICON_FILE]: 'lexicon/lexicon.v2.bbbbbbbbbb.json' };
    expect(await checkForDataUpdate()).toEqual([LEXICON_FILE]);
    expect(heard).toEqual([[LEXICON_FILE]]);
    expect(await checkForDataUpdate()).toEqual([]); // same build: nothing to do
    off();
  });

  it("owner's case: the new manifest brings the new word list in the background, and the extra's card shows", async () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const cards = [card('core-a', now), card('extra-a', now)];
    expect(await has('core-a')).toBe(true);
    expect(await has('extra-a')).toBe(false);
    // the old word list: the extra's card is held ("waiting for the latest word list"), never shown
    const stale = ledgerWith((await currentLexicon())!, cards, now);
    expect(stale.unresolved().map((c) => c.item.id)).toEqual(['extra-a']);
    expect(stale.cards.map((c) => c.item.id)).toEqual(['core-a']);
    // deploy: a new lexicon and manifest; the open app checks the manifest
    served.files['lexicon/lexicon.v2.bbbbbbbbbb.json'] = NEW;
    served.manifest = { [LEXICON_FILE]: 'lexicon/lexicon.v2.bbbbbbbbbb.json' };
    await checkForDataUpdate();
    await until(() => has('extra-a'));
    const fresh = ledgerWith((await currentLexicon())!, cards, now);
    expect(fresh.unresolved()).toEqual([]);
    expect(fresh.cards.map((c) => c.item.id).sort()).toEqual(['core-a', 'extra-a']);
  });

  it('offline with only the old word list cached: it keeps working with what it has', async () => {
    expect(await has('core-a')).toBe(true);
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('offline');
    });
    expect(await checkForDataUpdate()).toEqual([]);
    expect(await has('core-a')).toBe(true);
    expect(await has('extra-a')).toBe(false);
  });
});

describe('custom words show up at once (Phase 38 Part C)', () => {
  it('a custom word added while a page is open resolves without a remount', async () => {
    const lex = await currentLexicon();
    expect(lex?.byId('custom-gym')).toBeUndefined();
    const { db } = openSession('ron');
    await db.customWords.put({ ...word('custom-gym', '健身房'), source: 'custom' } as never);
    await until(() => has('custom-gym'));
  });

  it('a custom word merged in by a sync (written without hooks) resolves after the merge marks the study state dirty', async () => {
    await currentLexicon();
    const { db } = openSession('ron');
    await db.withoutHooks(() => db.customWords.put({ ...word('custom-synced', '捷運卡'), source: 'custom' } as never));
    markStudyDirty();
    await until(() => has('custom-synced'));
  });
});

describe('self-repair at start-up (Phase 38 Part B.4)', () => {
  it('reloads the word list once; what still does not resolve is listed and logged', async () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const log = vi.fn(async () => undefined);
    const reload = vi.fn(async () => {
      served.files['lexicon/lexicon.v2.bbbbbbbbbb.json'] = NEW;
      served.manifest = { [LEXICON_FILE]: 'lexicon/lexicon.v2.bbbbbbbbbb.json' };
      await checkForDataUpdate({ reload: true });
      await until(() => has('extra-a'));
      return currentLexicon();
    });
    const unresolved = async () => [card('extra-a', now), card('gone', now)];
    const missing = await repairWordListOnce({ unresolved, reload, log });
    expect(missing.map((m) => m.item.id)).toEqual(['gone']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(await repairWordListOnce({ unresolved, reload, log })).toEqual(missing); // once per visit
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing when every card resolves', async () => {
    const reload = vi.fn(async () => currentLexicon());
    expect(await repairWordListOnce({ unresolved: async () => [], reload })).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });
});
