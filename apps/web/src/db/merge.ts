import type { Backup } from './backup-schema.js';

/**
 * Phase 8 merge: combine this device's copy of a profile with the server's.
 * Pure — two Backups in, one Backup out — so every rule is unit-tested.
 *
 *  - APPEND-ONLY tables (evidence, turns, reward events, gloss reports, AI
 *    glosses) are unioned by their unique id and nothing is ever deleted.
 *  - IN-PLACE tables (cards, settings, journal entries/reviews, error items,
 *    conversations, custom words) keep whichever copy has the later
 *    `updatedAt`; a tie keeps the local copy.
 *  - Conversations/turns are keyed by a per-browser number, so they are matched
 *    by `uid` and the numeric ids are re-assigned (turns are renumbered in time
 *    order so "sort by id" still reads as a conversation).
 *
 * Nothing derived is stored (the due queue and garden are computed from cards),
 * so after the merged copy is written the UI simply reloads.
 */

const t = (d: Date | undefined): number => (d ? d.getTime() : 0);

/** Union by key; for a key on both sides the later `updatedAt` wins (local on a tie). */
function mergeByKey<T>(
  local: readonly T[],
  remote: readonly T[],
  keyOf: (row: T) => string,
  stamp: (row: T) => number,
): T[] {
  const out = new Map<string, T>();
  for (const row of local) out.set(keyOf(row), row);
  for (const row of remote) {
    const key = keyOf(row);
    const mine = out.get(key);
    if (!mine || stamp(row) > stamp(mine)) out.set(key, row);
  }
  return [...out.values()];
}

/** Union by key, never replacing (immutable, append-only records). */
function unionByKey<T>(local: readonly T[], remote: readonly T[], keyOf: (row: T) => string): T[] {
  const out = new Map<string, T>();
  for (const row of [...local, ...remote]) if (!out.has(keyOf(row))) out.set(keyOf(row), row);
  return [...out.values()];
}

/** Rows written before phase 8 (or by an old backup) may lack a uid: derive a
 * deterministic one from the content so the same legacy row on two devices is
 * recognised as the same record rather than duplicated. */
function evidenceUid(e: Backup['evidence'][number]): string {
  return (
    e.uid ??
    `legacy:${e.kind}:${e.item.kind}:${e.item.id}:${e.skill}:${e.at.getTime()}:${e.context?.refId ?? ''}`
  );
}

function mergeKeyed(
  local: Record<string, unknown>,
  localStamps: Record<string, Date>,
  remote: Record<string, unknown>,
  remoteStamps: Record<string, Date>,
): { values: Record<string, unknown>; stamps: Record<string, Date> } {
  const values: Record<string, unknown> = { ...local };
  const stamps: Record<string, Date> = { ...localStamps };
  for (const key of Object.keys(remote)) {
    if (!(key in local) || t(remoteStamps[key]) > t(localStamps[key])) {
      values[key] = remote[key];
      if (remoteStamps[key]) stamps[key] = remoteStamps[key]!;
    }
  }
  return { values, stamps };
}

export function mergeBackups(local: Backup, remote: Backup): Backup {
  const evidence = unionByKey(
    local.evidence.map((e) => ({ ...e, uid: evidenceUid(e) })),
    remote.evidence.map((e) => ({ ...e, uid: evidenceUid(e) })),
    (e) => e.uid,
  ).sort((a, b) => a.at.getTime() - b.at.getTime());

  // ---- conversations & turns (matched by uid, numeric ids re-assigned) ----
  const convUid = (c: Backup['conversations'][number]) =>
    c.uid ?? `legacy-conv:${c.scenarioId}:${c.startedAt.getTime()}`;
  const mergedConvs = new Map<string, Backup['conversations'][number]>();
  const idByUid = new Map<string, number>();
  let nextConvId =
    Math.max(
      0,
      ...local.conversations.map((c) => c.id ?? 0),
      ...remote.conversations.map((c) => c.id ?? 0),
    ) + 1;
  for (const c of local.conversations) {
    mergedConvs.set(convUid(c), { ...c, uid: convUid(c) });
    idByUid.set(convUid(c), c.id ?? nextConvId++);
  }
  const remoteConvIdToUid = new Map<number, string>();
  for (const c of remote.conversations) {
    const uid = convUid(c);
    if (c.id !== undefined) remoteConvIdToUid.set(c.id, uid);
    const mine = mergedConvs.get(uid);
    if (!mine) {
      mergedConvs.set(uid, { ...c, uid });
      idByUid.set(uid, nextConvId++);
    } else if (t(c.updatedAt) > t(mine.updatedAt)) {
      mergedConvs.set(uid, { ...c, uid });
    }
  }
  const conversations = [...mergedConvs.entries()].map(([uid, c]) => ({
    ...c,
    id: idByUid.get(uid)!,
  }));

  const localConvIdToUid = new Map<number, string>(
    local.conversations.flatMap((c) => (c.id !== undefined ? [[c.id, convUid(c)] as const] : [])),
  );
  const turnUid = (tr: Backup['turns'][number], idToUid: Map<number, string>) =>
    tr.uid ??
    `legacy-turn:${idToUid.get(tr.conversationId) ?? tr.conversationId}:${tr.role}:${tr.at.getTime()}:${tr.zh}`;
  const turnsByUid = new Map<string, Backup['turns'][number] & { convUid: string }>();
  for (const [turns, idToUid] of [
    [local.turns, localConvIdToUid],
    [remote.turns, remoteConvIdToUid],
  ] as const) {
    for (const tr of turns) {
      const uid = turnUid(tr, idToUid);
      const cu = idToUid.get(tr.conversationId);
      if (cu === undefined || turnsByUid.has(uid)) continue; // a turn with no known conversation can't be placed
      turnsByUid.set(uid, { ...tr, uid, convUid: cu });
    }
  }
  const turns = [...turnsByUid.values()]
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.uid!.localeCompare(b.uid!))
    .map(({ convUid: cu, ...tr }, i) => ({ ...tr, id: i + 1, conversationId: idByUid.get(cu)! }));

  const settings = mergeKeyed(
    local.settings,
    local.settingsUpdatedAt,
    remote.settings,
    remote.settingsUpdatedAt,
  );
  const meta = mergeKeyed(local.meta, local.metaUpdatedAt, remote.meta, remote.metaUpdatedAt);

  return {
    schemaVersion: Math.max(local.schemaVersion, remote.schemaVersion),
    lexiconVersion: local.lexiconVersion ?? remote.lexiconVersion,
    exportedAt: new Date().toISOString(),
    items: mergeByKey(
      local.items,
      remote.items,
      (c) => `${c.item.kind}:${c.item.id}:${c.skill}`,
      (c) => t(c.updatedAt),
    ),
    evidence,
    settings: settings.values,
    settingsUpdatedAt: settings.stamps,
    meta: meta.values,
    metaUpdatedAt: meta.stamps,
    customWords: mergeByKey(
      local.customWords,
      remote.customWords,
      (w) => w.id,
      (w) => t(w.updatedAt),
    ),
    journalEntries: mergeByKey(
      local.journalEntries,
      remote.journalEntries,
      (e) => e.id,
      (e) => t(e.updatedAt),
    ),
    journalReviews: mergeByKey(
      local.journalReviews,
      remote.journalReviews,
      (r) => r.entryId,
      (r) => t(r.updatedAt),
    ),
    errorItems: mergeByKey(
      local.errorItems,
      remote.errorItems,
      (e) => e.id,
      (e) => t(e.updatedAt),
    ),
    conversations,
    turns,
    rewardEvents: unionByKey(local.rewardEvents, remote.rewardEvents, (r) => r.id),
    glossReports: unionByKey(
      local.glossReports.map((g) => ({
        ...g,
        uid: g.uid ?? `legacy-report:${g.wordId}:${g.at.getTime()}:${g.contextSentence}`,
      })),
      remote.glossReports.map((g) => ({
        ...g,
        uid: g.uid ?? `legacy-report:${g.wordId}:${g.at.getTime()}:${g.contextSentence}`,
      })),
      (g) => g.uid,
    ),
    aiGlosses: unionByKey(local.aiGlosses, remote.aiGlosses, (a) => a.key),
  };
}

/** Do two copies hold the same records? Used to skip a pointless push after
 * a pull that changed nothing. Compares the parts a merge can change. */
export function sameContent(a: Backup, b: Backup): boolean {
  const norm = (x: Backup) =>
    JSON.stringify([
      x.items.map((c) => [c.item.kind, c.item.id, c.skill, t(c.updatedAt)]).sort(),
      x.evidence.map(evidenceUid).sort(),
      x.settings,
      x.meta,
      x.customWords.map((w) => [w.id, t(w.updatedAt)]).sort(),
      x.journalEntries.map((e) => [e.id, t(e.updatedAt)]).sort(),
      x.journalReviews.map((r) => [r.entryId, t(r.updatedAt)]).sort(),
      x.errorItems.map((e) => [e.id, t(e.updatedAt)]).sort(),
      x.conversations.map((c) => [c.uid ?? '', t(c.updatedAt)]).sort(),
      x.turns.map((tr) => tr.uid ?? '').sort(),
      x.rewardEvents.map((r) => r.id).sort(),
      x.glossReports.map((g) => g.uid ?? '').sort(),
      x.aiGlosses.map((g) => g.key).sort(),
    ]);
  return norm(a) === norm(b);
}
