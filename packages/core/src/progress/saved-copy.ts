// Phase 28: what one saved copy of a profile holds, in the shared terms. The server's version list,
// `sync:inspect`, Settings → Your progress and the restore screen all describe a copy with this, so
// "1,240 cards · 412 Learned" means the same thing on the server and in the browser. Pure.

import type { SkillCard } from '../learner/types.js';
import type { ItemRef } from '../types.js';
import { ProgressIndex } from './terms.js';

export interface SavedCopySummary {
  /** Cards the learner has met (not `unseen`). */
  cards: number;
  /** Items Learned (Mastered included), and Mastered, the same counts as every tab. */
  learned: number;
  mastered: number;
  /** Evidence records (every answer, lookup and read). */
  evidence: number;
  /** The newest evidence time, ISO, or null when there is none. */
  lastEvidenceAt: string | null;
}

const asDate = (v: unknown): Date | undefined =>
  v === undefined || v === null ? undefined : new Date(v as string | number | Date);

/** A stored card with its dates revived (a copy that went through JSON has strings). */
function revive(raw: SkillCard): SkillCard {
  const card = raw.card as SkillCard['card'] & { due: unknown; last_review?: unknown };
  return {
    ...raw,
    card: {
      ...card,
      due: asDate(card.due) ?? new Date(0),
      ...(card.last_review !== undefined ? { last_review: asDate(card.last_review) } : {}),
    } as SkillCard['card'],
    flags: raw.flags ?? {},
  };
}

/** Summarise a saved copy (a backup export, as JSON or as objects). Unknown shapes count as empty. */
export function summarizeSavedCopy(data: unknown): SavedCopySummary {
  const d = (data ?? {}) as { items?: unknown; evidence?: unknown; settings?: unknown };
  const items = Array.isArray(d.items) ? (d.items as SkillCard[]).filter((c) => c && c.item && c.card) : [];
  const evidence = Array.isArray(d.evidence) ? (d.evidence as { at?: unknown }[]) : [];
  const cards = items.map(revive);
  const knownItems = knownItemsOf(d.settings);
  const index = new ProgressIndex({ cards, knownItems });
  const refs = new Map<string, ItemRef>();
  for (const c of cards) if (c.state !== 'unseen') refs.set(`${c.item.kind}:${c.item.id}`, c.item);
  let learned = 0;
  let mastered = 0;
  for (const ref of refs.values()) {
    if (index.learned(ref)) learned++;
    if (index.mastered(ref)) mastered++;
  }
  let last = -Infinity;
  for (const e of evidence) {
    const t = asDate(e?.at)?.getTime();
    if (t !== undefined && Number.isFinite(t) && t > last) last = t;
  }
  return {
    cards: cards.filter((c) => c.state !== 'unseen').length,
    learned,
    mastered,
    evidence: evidence.length,
    lastEvidenceAt: Number.isFinite(last) ? new Date(last).toISOString() : null,
  };
}

/** The study settings' legacy "known" list, from a backup's settings (`{ studyOrder: {...} }`). */
function knownItemsOf(settings: unknown): string[] {
  if (!settings || typeof settings !== 'object') return [];
  const known = ((settings as Record<string, unknown>).studyOrder as { knownItems?: unknown } | undefined)?.knownItems;
  return Array.isArray(known) ? known.filter((x): x is string => typeof x === 'string') : [];
}
