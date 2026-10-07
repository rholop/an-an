import {
  applyEvidence,
  buildFsrs,
  DEFAULT_LEARNER_CONFIG,
  REVIEW_PILE_CONFIG,
  spreadBulkDue,
  type ItemRef,
  type Level,
  type NopeChoice,
  type Evidence,
  type FSRS,
  type ItemState,
  type LearnerConfig,
  type LearnerRepo,
  type SkillCard,
} from '@anan/core';

interface UndoableRepo {
  appendEvidenceKeys(events: Evidence[]): Promise<number[]>;
  undoEvidence(
    evidenceId: number,
    item: Evidence['item'],
    skill: Evidence['skill'],
    prior: SkillCard | undefined,
  ): Promise<void>;
}

interface ItemCardsRepo {
  cardsOfItem(item: ItemRef): Promise<SkillCard[]>;
}

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
  private readonly fsrsInstance: FSRS;

  constructor(
    private readonly repo: LearnerRepo,
    private readonly config: LearnerConfig = DEFAULT_LEARNER_CONFIG,
    /** Phase 6: told about every single recorded piece of evidence, with the
     * card as it was *before* (e.g. to award points). Failures never block
     * learning. */
    private readonly onRecorded?: (
      evidence: Evidence,
      prior: SkillCard | undefined,
    ) => Promise<void>,
  ) {
    this.fsrsInstance = buildFsrs(config);
  }

  async record(raw: Evidence, now: Date = new Date()): Promise<SkillCard | undefined> {
    const evidence = gated(raw);
    const current = await this.repo.getCard(evidence.item, evidence.skill);
    const result = applyEvidence(current, evidence, now, this.config, this.fsrsInstance);
    if (result.card) await this.repo.putCards([result.card]);
    await this.repo.appendEvidence([evidence]);
    if (this.onRecorded) await this.onRecorded(evidence, current).catch(() => undefined);
    return result.card;
  }

  /** Phase 16: `record`, but keeps what is needed to take it back exactly. A
   * repo without undo support (a test double) records normally and can't undo. */
  async recordUndoable(
    raw: Evidence,
    now: Date = new Date(),
  ): Promise<{ card: SkillCard | undefined; undo: () => Promise<void> }> {
    const evidence = gated(raw);
    const repo = this.repo as Partial<UndoableRepo> & LearnerRepo;
    if (!repo.appendEvidenceKeys || !repo.undoEvidence) {
      return { card: await this.record(evidence, now), undo: async () => undefined };
    }
    const prior = await repo.getCard(evidence.item, evidence.skill);
    const result = applyEvidence(prior, evidence, now, this.config, this.fsrsInstance);
    if (result.card) await repo.putCards([result.card]);
    const [id] = await repo.appendEvidenceKeys([evidence]);
    if (this.onRecorded) await this.onRecorded(evidence, prior).catch(() => undefined);
    return {
      card: result.card,
      undo: async () => {
        if (id !== undefined)
          await repo.undoEvidence!(id, evidence.item, evidence.skill, prior);
      },
    };
  }

  /** Same as `record`, batched: one parallel read pass, one bulk write pass
   * — used by Anki import so a few thousand rows doesn't mean a few
   * thousand sequential round-trips. */
  async recordBulk(raw: Evidence[], now: Date = new Date()): Promise<SkillCard[]> {
    const events = raw.map(gated);
    const currents = await Promise.all(events.map((e) => this.repo.getCard(e.item, e.skill)));
    const results = events.map((e, i) =>
      applyEvidence(currents[i], e, now, this.config, this.fsrsInstance),
    );
    let cards = results.map((r) => r.card).filter((c): c is SkillCard => c !== undefined);
    // Phase 20: cards a bulk action creates (Anki import, placement) get spread-out first due
    // dates, so they never all fall due on the same day.
    const fresh = new Set(
      results.flatMap((r, i) => (r.card && !currents[i] && BULK_KINDS.has(events[i]!.kind) ? [r.card] : [])),
    );
    if (fresh.size > 0) {
      const startDays = Math.max(1, Math.round(this.config.importedInitialStability / 2));
      const spread = spreadBulkDue([...fresh], now, { cap: bulkCap(), startDays });
      const byKey = new Map(spread.map((c) => [`${c.item.kind}:${c.item.id}|${c.skill}`, c]));
      cards = cards.map((c) => (fresh.has(c) ? byKey.get(`${c.item.kind}:${c.item.id}|${c.skill}`)! : c));
    }
    await this.repo.putCards(cards);
    await this.repo.appendEvidence(events);
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
      (['recognition', 'production', 'listening'] as const).map((s) => repo.getCard(item, s)),
    );
    return all.filter((c): c is SkillCard => !!c);
  }

  /** Writes a card as-is (no evidence) — for flags like Phase 5's `priority`
   * that sit on the card but aren't learner evidence. */
  putCard(card: SkillCard): Promise<void> {
    return this.repo.putCards([card]);
  }

  dueCards(now: Date = new Date(), limit = 50): Promise<SkillCard[]> {
    return this.repo.dueCards(now, limit);
  }

  /** Phase 15: due listening cards (their own queue). */
  dueListeningCards(now: Date = new Date(), limit = 50): Promise<SkillCard[]> {
    return (this.repo as unknown as { dueListeningCards(n: Date, l: number): Promise<SkillCard[]> }).dueListeningCards(now, limit);
  }

  knownSet(minState: ItemState = 'review'): Promise<Set<string>> {
    return this.repo.knownSet(minState);
  }

  getCard(item: Evidence['item'], skill: Evidence['skill']): Promise<SkillCard | undefined> {
    return this.repo.getCard(item, skill);
  }
}
