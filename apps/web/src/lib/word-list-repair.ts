import { useEffect, useState } from 'react';
import type { ItemRef, Lexicon, Skill, SkillCard } from '@anan/core';
import { currentSession, db, onSessionChange } from '../db/instance.js';
import { authHeaders, proxyBase } from './api.js';
import { getLedgerNow } from './ledger.js';
import { markStudyDirty } from './study-dirty.js';
import { dataUrl } from './data-files.js';
import { LEXICON_FILE, reloadLexicon } from './useLexicon.js';

/** Phase 38 Part B.4: a card whose word is still missing after a fresh word list: a data problem. */
export interface MissingCard {
  item: ItemRef;
  skill: Skill;
  /** The first evidence for the item (when the card was added). */
  addedAt?: Date;
  /** Where that evidence came from (review, chat, journal, …, or its kind). */
  from?: string;
}

const resolvesIn = (lexicon: Lexicon | undefined, item: ItemRef): boolean =>
  !!lexicon && (item.kind === 'word' ? lexicon.byId(item.id) : lexicon.grammarItemById(item.id)) !== undefined;

async function describe(cards: readonly SkillCard[]): Promise<MissingCard[]> {
  const ids = new Set(cards.map((c) => c.item.id));
  const first = new Map<string, { at: Date; from: string }>();
  // rare (a real data problem), so a scan of the log is fine
  await db.evidence
    .filter((e) => ids.has(e.item.id))
    .each((e) => {
      const seen = first.get(e.item.id);
      if (!seen || e.at < seen.at) first.set(e.item.id, { at: e.at, from: e.context?.source ?? e.kind });
    });
  return cards.map((c) => {
    const f = first.get(c.item.id);
    return { item: c.item, skill: c.skill, ...(f ? { addedAt: f.at, from: f.from } : {}) };
  });
}

/** Logs the missing ids to the proxy (ids, skills and sources only: no personal text). */
async function logMissing(missing: readonly MissingCard[], lexiconVersion: string | undefined): Promise<void> {
  try {
    await fetch(`${proxyBase()}/v1/client-log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        kind: 'missing-words',
        ...(lexiconVersion ? { lexicon: lexiconVersion } : {}),
        items: missing.slice(0, 200).map((m) => ({ kind: m.item.kind, id: m.item.id, skill: m.skill, ...(m.from ? { from: m.from } : {}) })),
      }),
    });
  } catch {
    /* offline: the Settings list still shows them */
  }
}

let repair: Promise<MissingCard[]> | null = null;
let missingNow: MissingCard[] = [];
const listeners = new Set<(m: MissingCard[]) => void>();
onSessionChange(() => {
  repair = null;
  missingNow = [];
  listeners.forEach((l) => l(missingNow));
});

/**
 * Phase 38 Part B.4: once per visit and profile, if any card is waiting for the word list, fetch the
 * manifest and the word list again, bypassing caches. Whatever still doesn't resolve is listed under
 * Settings → Your progress and logged to the proxy. Cards are never deleted or rescheduled.
 */
export function repairWordListOnce(
  deps: {
    unresolved?: () => Promise<SkillCard[]>;
    reload?: () => Promise<Lexicon | undefined>;
    log?: (m: readonly MissingCard[], version?: string) => Promise<void>;
  } = {},
): Promise<MissingCard[]> {
  if (!currentSession()) return Promise.resolve([]);
  repair ??= (async () => {
    const held = await (deps.unresolved ?? (async () => (await getLedgerNow()).unresolved()))();
    if (held.length === 0) return [];
    const lexicon = await (deps.reload ?? reloadLexicon)();
    markStudyDirty();
    const still = held.filter((c) => !resolvesIn(lexicon, c.item));
    if (still.length === 0) return [];
    const missing = await describe(still);
    // the word list's file name carries its content hash: which build lacks these ids
    const file = (await dataUrl(LEXICON_FILE)).split('/').pop();
    await (deps.log ?? logMissing)(missing, file);
    return missing;
  })()
    .then((m) => {
      missingNow = m;
      listeners.forEach((l) => l(m));
      return m;
    })
    .catch(() => {
      repair = null;
      return [];
    });
  return repair;
}

/** Settings → Your progress: the cards whose words are missing after a fresh word list. */
export function useMissingWordCards(): MissingCard[] {
  const [m, setM] = useState<MissingCard[]>(missingNow);
  useEffect(() => {
    listeners.add(setM);
    void repairWordListOnce();
    return () => {
      listeners.delete(setM);
    };
  }, []);
  return m;
}

/** Tests: forget this visit's repair. */
export function resetWordListRepairForTests(): void {
  repair = null;
  missingNow = [];
}
