// Phase 20: every number that keeps the review pile a sensible size, in one place.
// The daily cap is also a per-profile setting (Settings → Review); this is its default.
export interface ReviewPileConfig {
  /** Reviews per day, at most. More due than this: the most important go first, the rest wait. */
  dailyCap: number;
  /** Due above this share of the cap: new cards are halved. Above the cap: no new cards. */
  newHalfShare: number;
  /** "I already know it": both skills scheduled this many days ahead. */
  knownStabilityDays: number;
  /** Bulk-created cards (Anki import, placement) are spread over at least this window… */
  bulkSpreadMinDays: number;
  bulkSpreadMaxDays: number;
  /** …and widened until no day gets more than this share of the cap from one bulk action. */
  bulkShareOfCap: number;
  /** Lookups introduce a card on their own only up to the picked level + this many levels. */
  lookupLevelsAbove: number;
}

export const REVIEW_PILE_CONFIG: ReviewPileConfig = {
  dailyCap: 80,
  newHalfShare: 0.5,
  knownStabilityDays: 60,
  bulkSpreadMinDays: 14,
  bulkSpreadMaxDays: 28,
  bulkShareOfCap: 0.5,
  lookupLevelsAbove: 1,
};
