// Phase 37: one cloze per word per session.
export const CLOZE_CONFIG = {
  /** A word's cloze answer counts for every card of that word in this session (recognition and
   * production). Off: only the shown card is credited and the word's other card stays for Review. */
  creditAllFacesOfWord: true,
} as const;
