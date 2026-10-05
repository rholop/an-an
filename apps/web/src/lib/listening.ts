import { useMemo } from 'react';
import {
  blankListeningCard,
  listeningClip,
  listeningCardsToCreate,
  makeClipLookup,
  type AudioKind,
  type ClipLookup,
  type Evidence,
  type Lexicon,
  type SkillCard,
} from '@anan/core';
import { db, learnerService } from '../db/instance.js';
import type { AnanDB } from '../db/schema.js';
import { allTouchedCards } from '../db/queries.js';
import { audioBase, useAudioState } from './audio.js';
import { useSetting } from './useSetting.js';

/** Phase 15: clips for listening. Only verified/auto_ok (tone exercises: verified) — never the
 * "suspect clips play" policy of the speaker buttons. */
export function useListeningClips() {
  const audio = useAudioState();
  return useMemo(() => {
    const hasClip: ClipLookup = makeClipLookup(audio.manifest, audio.marks);
    const urlFor = (kind: AudioKind, id: string, verifiedOnly = false): string | null => {
      const c = listeningClip(audio.manifest, audio.marks, kind, id, { verifiedOnly });
      return c ? `${audioBase()}${c.url}` : null;
    };
    const clipInfo = (kind: AudioKind, id: string) => {
      const c = listeningClip(audio.manifest, audio.marks, kind, id);
      return c ? { kind, id, hash: c.hash, text: c.text } : null;
    };
    return { hasClip, urlFor, clipInfo, ready: audio.manifest !== null };
  }, [audio.manifest, audio.marks]);
}

/** Profile setting: Listening on/off. On by default when audio is on. */
export function useListeningEnabled(): boolean {
  const [audioOn] = useSetting<boolean>('audioEnabled', true);
  const [listeningOn] = useSetting<boolean>('listeningEnabled', true);
  return audioOn && listeningOn && !testSwitchOff();
}

/** E2E hook (like anan.study.disabled): specs written without listening switch it off. */
function testSwitchOff(): boolean {
  try {
    return localStorage.getItem('anan.listening.disabled') === '1';
  } catch {
    return false;
  }
}

/**
 * Creates listening cards for items whose recognition card reached `review` and which have a
 * usable word clip (Phase 15). Returns every listening card afterwards.
 */
export async function ensureListeningCards(
  hasClip: ClipLookup,
  now: Date = new Date(),
  deps: { db: AnanDB; putCard: (c: SkillCard) => Promise<unknown> } = { db, putCard: (c) => learnerService.putCard(c) },
): Promise<SkillCard[]> {
  const cards = await allTouchedCards(deps.db);
  const create = listeningCardsToCreate(cards, hasClip);
  for (const id of create) await deps.putCard(blankListeningCard(id, now));
  const rows = await deps.db.items.filter((r) => r.skill === 'listening').toArray();
  return rows.map(({ pk: _pk, ...c }) => c);
}

/** Records an exercise's evidence for items that have a listening card; an empty list ("Sounds wrong") writes nothing. */
export async function recordListeningEvidence(
  record: (e: Evidence, now: Date) => Promise<unknown>,
  cardIds: ReadonlySet<string>,
  evidence: readonly { wordId: string; kind: Evidence['kind'] }[],
  now: Date,
): Promise<number> {
  let n = 0;
  for (const e of evidence)
    if (cardIds.has(e.wordId)) {
      await record({ item: { kind: 'word', id: e.wordId }, skill: 'listening', kind: e.kind, at: now }, now);
      n++;
    }
  return n;
}

/** Warm the service-worker cache so a Listen session works offline (best effort). */
export function prefetchClips(urls: readonly string[]): void {
  for (const u of urls) void fetch(u).catch(() => undefined);
}

export type { Lexicon };
