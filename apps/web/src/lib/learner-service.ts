import {
  applyEvidence,
  buildFsrs,
  DEFAULT_LEARNER_CONFIG,
  productionUnlockFor,
  REVIEW_PILE_CONFIG,
  spreadBulkDue,
  wordSets,
  type ItemRef,
  type Level,
  type NopeChoice,
  type Evidence,
  type FSRS,
  type LearnerConfig,
  type LearnerRepo,
  type SkillCard,
  type WordSets,
} from '@anan/core';

interface UidRepo {
  /** Appends and returns each row's sync uid (Phase 21 undo refers to it). */
  appendEvidenceUids(events: Evidence[]): Promise<string[]>;
}

interface ItemCardsRepo {
  cardsOfItem(item: ItemRef): Promise<SkillCard[]>;
  allCards(): Promise<SkillCard[]>;
}

/** What a recorded answer earned (so Undo can take it back). */
export type RecordedHook = (evidence: Evidence, prior: SkillCard | undefined) => Promise<unknown>;

/**
 * Phase 20: may a lookup of this word create a card on its own? Registered by the app once the
 * lexicon and the picked level are known (see lookup-gate.ts); absent = always (as before).
 */
let lookupGate: ((wordId: string) => boolean) | undefined;
export function setLookupGate(gate: ((wordId: string) => boolean) | undefined): void {
  lookupGate = gate;
}
/** Would a lookup of this word create a card on its own? */
export function lookupWouldIntroduce(wordId: string): boolean {
  return !lookupGate || lookupGate(wordId);
}

/** Phase 20: the daily cap, for spreading bulk-created cards (set from the profile's settings). */
let bulkCap: () => number = () => REVIEW_PILE_CONFIG.dailyCap;
export function setBulkCapSource(fn: () => number): void {
  bulkCap = fn;
}

/** Bulk actions whose new cards get spread-out first due dates. */
const BULK_KINDS = new Set<Evidence['kind']>(['anki_import_seen', 'placement_known']);

/** A lookup (not a journal gap, not already marked) of a word outside the gate makes no card. */
function gated(e: Evidence): Evidence {
  if (e.kind !== 'chat_lookup_gloss' || e.skill !== 'recognition' || e.item.kind !== 'word') return e;
  if (e.context?.noIntroduce !== undefined || e.context?.source === 'journal') return e;
  if (!lookupGate || lookupGate(e.item.id)) return e;
  return { ...e, context: { source: e.context?.source ?? 'chat', ...e.context, noIntroduce: true } };
}

/** Phase 21: the study settings' legacy "known" list, so every wordSets caller sees the same
 * Learned set (registered by lib/study.ts; avoids an import cycle). */
let knownItemsSource: () => readonly string[] = () => [];
export function setKnownItemsSource(fn: () => readonly string[]): void {
  knownItemsSource = fn;
}

export interface NopeHandle {
  choice: NopeChoice;
  /** The item's cards exactly as they were, restored by `undo`. */
  undo: () => Promise<void>;
}

/**
 * Thin orchestration layer around the pure `applyEvidence` + a `LearnerRepo`:
 * fetch the current card, apply one evidence event, persist the result and
 * append to the evidence log. This is the one place in apps/web that's
 * allowed to call `new Date()` — every other caller passes `now` through.
 */
export class LearnerService {
  private fsrsInstance: FSRS;
  private config: LearnerConfig;

  constructor(
    private readonly repo: LearnerRepo,
    config: LearnerConfig = DEFAULT_LEARNER_CONFIG,
    /** Phase 6: told about every single recorded piece of evidence, with the
     * card as it was *before* (e.g. to award points; it may return what was
     * awarded, which Undo takes back). Failures never block learning. */
    private readonly onRecorded?: RecordedHook,
    /** Phase 21: told once after any write (single or bulk), e.g. to mark the study focus dirty. */
    private readonly onChanged?: () => void,
    /** Phase 21: Undo takes back what `onRecorded` awarded for the undone answer. */
    private readonly onUndone?: (awarded: unknown, at: Date) => Promise<void>,
  ) {
    this.config = config;
    this.fsrsInstance = buildFsrs(config);
  }

  /** Phase 21: the profile's target retention (Settings) is what the scheduler uses. */
  setRequestRetention(r: number): void {
    if (r === this.config.requestRetention) return;
    this.config = { ...this.config, requestRetention: r };
    this.fsrsInstance = buildFsrs(this.config);
  }

  /** Apply one event and persist it; a Learned recognition card also unlocks its production card
   * (Phase 21 Part B rule 1), through evidence like everything else. */
  private async applyOne(
    evidence: Evidence,
    now: Date,
  ): Promise<{ card: SkillCard | undefined; prior: SkillCard | undefined; uid?: string; unlocked: Evidence[] }> {
    const prior = await this.repo.getCard(evidence.item, evidence.skill);
    const result = applyEvidence(prior, evidence, now, this.config, this.fsrsInstance);
    const writes: SkillCard[] = result.card ? [result.card] : [];
    const events: Evidence[] = [evidence];
    const unlocked: Evidence[] = [];
    if (result.card && evidence.skill === 'recognition') {
      const hasProduction = !!(await this.repo.getCard(evidence.item, 'production'));
      const production = productionUnlockFor(result.card, hasProduction, now);
      if (production) {
        const prod = applyEvidence(undefined, production, now, this.config, this.fsrsInstance).card;
        if (prod) writes.push(prod);
        events.push(production);
        unlocked.push(production);
      }
    }
    if (writes.length > 0) await this.repo.putCards(writes);
    const repo = this.repo as Partial<UidRepo> & LearnerRepo;
    let uid: string | undefined;
    if (repo.appendEvidenceUids) [uid] = await repo.appendEvidenceUids(events);
    else await this.repo.appendEvidence(events);
    return { card: result.card, prior, ...(uid ? { uid } : {}), unlocked };
  }

  async record(raw: Evidence, now: Date = new Date()): Promise<SkillCard | undefined> {
    const evidence = gated(raw);
    const { card, prior } = await this.applyOne(evidence, now);
    if (this.onRecorded) await this.onRecorded(evidence, prior).catch(() => undefined);
    this.onChanged?.();
    return card;
  }

  /**
   * Phase 16/21: `record`, plus an `undo` that takes the answer back. Sync-safe: undo writes an
   * `evidence_undone` record and puts the card back with a NEW `updatedAt` (nothing is deleted, so
   * another device can't resurrect the undone answer), and takes back the points it earned.
   */
  async recordUndoable(
    raw: Evidence,
    now: Date = new Date(),
  ): Promise<{ card: SkillCard | undefined; undo: () => Promise<void> }> {
    const evidence = gated(raw);
    const { card, prior, uid, unlocked } = await this.applyOne(evidence, now);
    let awarded: unknown;
    if (this.onRecorded) awarded = await this.onRecorded(evidence, prior).catch(() => undefined);
    this.onChanged?.();
    let undone = false;
    return {
      card,
      undo: async () => {
        if (undone) return;
        undone = true;
        const at = new Date(Math.max(Date.now(), now.getTime() + 1));
        const undos: Evidence[] = [
          {
            item: evidence.item,
            skill: evidence.skill,
            kind: 'evidence_undone',
            at,
            context: { source: evidence.context?.source ?? 'review', ...(uid ? { refId: uid } : {}), ...(prior ? { restore: prior } : {}) },
          },
        ];
        for (const u of unlocked)
          undos.push({ item: u.item, skill: u.skill, kind: 'evidence_undone', at, context: { source: 'review' } });
        for (const u of undos) await this.applyOne(u, at);
        if (this.onUndone && awarded !== undefined) await this.onUndone(awarded, at).catch(() => undefined);
        this.onChanged?.();
      },
    };
  }

  /** Same as `record`, batched: one parallel read pass, one bulk write pass
   * — used by Anki import so a few thousand rows doesn't mean a few
   * thousand sequential round-trips. Phase 21: events for the same item and skill are applied in
   * order (each sees the previous one's result), and listeners hear about the batch once. */
  async recordBulk(raw: Evidence[], now: Date = new Date()): Promise<SkillCard[]> {
    const events = raw.map(gated);
    const keyOf = (e: { item: ItemRef; skill: string }) => `${e.item.kind}:${e.item.id}|${e.skill}`;
    const firstIdx = new Map<string, number>();
    events.forEach((e, i) => {
      if (!firstIdx.has(keyOf(e))) firstIdx.set(keyOf(e), i);
    });
    const keys = [...firstIdx.keys()];
    const loaded = await Promise.all(keys.map((k) => this.repo.getCard(events[firstIdx.get(k)!]!.item, events[firstIdx.get(k)!]!.skill)));
    const latest = new Map<string, SkillCard | undefined>(keys.map((k, i) => [k, loaded[i]]));
    const original = new Map(latest);
    const results = events.map((e) => {
      const r = applyEvidence(latest.get(keyOf(e)), e, now, this.config, this.fsrsInstance);
      if (r.card) latest.set(keyOf(e), r.card);
      return r;
    });
    // Production cards unlocked by this batch (one per word). Reading cards (Phase 23) are added by
    // `ensureFaceCards` when Review or Pinyin & tones opens, so an answer writes only what it changes.
    const unlockEvents: Evidence[] = [];
    for (const [k, c] of latest) {
      if (!c || c.skill !== 'recognition' || !k.endsWith('|recognition')) continue;
      const prodKey = `${c.item.kind}:${c.item.id}|production`;
      const hasProduction = latest.get(prodKey) !== undefined || !!(await this.repo.getCard(c.item, 'production'));
      const u = productionUnlockFor(c, hasProduction, now);
      if (u) {
        const prod = applyEvidence(undefined, u, now, this.config, this.fsrsInstance).card;
        if (prod) latest.set(prodKey, prod);
        unlockEvents.push(u);
      }
    }
    const changed = [...latest.entries()].filter(([k, c]) => c !== undefined && c !== original.get(k));
    let cards = changed.map(([, c]) => c!);
    const currents = events.map((e) => original.get(keyOf(e)));
    // Phase 20: cards a bulk action creates (Anki import, placement) get spread-out first due
    // dates, so they never all fall due on the same day.
    const freshKeys = new Set(
      results.flatMap((r, i) => (r.card && !currents[i] && BULK_KINDS.has(events[i]!.kind) ? [keyOf(events[i]!)] : [])),
    );
    if (freshKeys.size > 0) {
      const startDays = Math.max(1, Math.round(this.config.importedInitialStability / 2));
      const fresh = cards.filter((c) => freshKeys.has(keyOf(c)));
      const spread = spreadBulkDue(fresh, now, { cap: bulkCap(), startDays });
      const byKey = new Map(spread.map((c) => [keyOf(c), c]));
      cards = cards.map((c) => byKey.get(keyOf(c)) ?? c);
    }
    await this.repo.putCards(cards);
    await this.repo.appendEvidence([...events, ...unlockEvents]);
    this.onChanged?.();
    return cards;
  }

  /**
   * Phase 20 "Nope": takes the whole word (every skill) out of review in one step. Not a lapse;
   * `undo` puts every card back exactly as it was and removes the evidence.
   */
  async nope(
    item: ItemRef,
    choice: NopeChoice,
    opts: { snoozedWhen?: { level?: Level; lessonId?: string } } = {},
    now: Date = new Date(),
  ): Promise<NopeHandle> {
    const cards = await this.cardsOfItem(item);
    const undos: Array<() => Promise<void>> = [];
    for (const c of cards) {
      const { undo } = await this.recordUndoable(
        {
          item,
          skill: c.skill,
          kind: 'review_nope',
          at: now,
          context: { source: 'review', choice, ...(opts.snoozedWhen ? { snoozedWhen: opts.snoozedWhen } : {}) },
        },
        now,
      );
      undos.push(undo);
    }
    return {
      choice,
      undo: async () => {
        for (const u of undos.reverse()) await u();
      },
    };
  }

  /** Phase 20: Removed words → Restore (every skill), or "Add to review" for a word with no card. */
  async restore(item: ItemRef, now: Date = new Date()): Promise<void> {
    const cards = await this.cardsOfItem(item);
    const skills = cards.length > 0 ? cards.map((c) => c.skill) : (['recognition'] as const);
    for (const skill of skills) await this.record({ item, skill, kind: 'review_restore', at: now }, now);
  }

  private async cardsOfItem(item: ItemRef): Promise<SkillCard[]> {
    const repo = this.repo as Partial<ItemCardsRepo> & LearnerRepo;
    if (repo.cardsOfItem) return repo.cardsOfItem(item);
    const all = await Promise.all(
      (['recognition', 'production', 'listening', 'reading'] as const).map((s) => repo.getCard(item, s)),
    );
    return all.filter((c): c is SkillCard => !!c);
  }

  /** Phase 21: every Due card (no silent row cut; sessions cap by study-order priority). */
  dueCards(now: Date = new Date(), limit = Infinity): Promise<SkillCard[]> {
    return this.repo.dueCards(now, limit);
  }

  /** Phase 15: due listening cards (their own queue). */
  dueListeningCards(now: Date = new Date(), limit = 50): Promise<SkillCard[]> {
    return (this.repo as unknown as { dueListeningCards(n: Date, l: number): Promise<SkillCard[]> }).dueListeningCards(now, limit);
  }

  /** Phase 21: New cards (introduced, never answered); sessions take them through `pickNewForSession`. */
  async newCards(): Promise<SkillCard[]> {
    const repo = this.repo as LearnerRepo & { newCards?: () => Promise<SkillCard[]> };
    return repo.newCards ? repo.newCards() : [];
  }

  /** Every card (any skill, any state). */
  async allCards(): Promise<SkillCard[]> {
    const repo = this.repo as Partial<ItemCardsRepo> & LearnerRepo;
    return repo.allCards ? repo.allCards() : [];
  }

  /** Phase 21: the shared known / due / learning sets (the one "comprehensible" definition). */
  async wordSets(now: Date = new Date(), knownItems?: readonly string[]): Promise<WordSets> {
    const repo = this.repo as Partial<ItemCardsRepo> & LearnerRepo;
    const cards = repo.allCards ? await repo.allCards() : [];
    return wordSets(cards, now, { knownItems: knownItems ?? knownItemsSource() });
  }

  getCard(item: Evidence['item'], skill: Evidence['skill']): Promise<SkillCard | undefined> {
    return this.repo.getCard(item, skill);
  }
}
