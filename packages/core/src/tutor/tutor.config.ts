// Phase 39: tutoring-session settings (one place to tune them).

export const TUTOR_CONFIG = {
  /** An example sentence is practised only when it has at most this many words the learner can't
   * read yet (the session's own words don't count). */
  maxUnknownWordsInExample: 2,
  /** Words of one class the chat scenario names as its targets. */
  scenarioTargetWords: 12,
  /** The label of a session's sentences in Cloze: "from your class with …" in Cloze. */
  clozeLabelPrefix: 'from your class with',
  /** Phase 40 Part E.4: the latest classes whose words are rung 2 of the vocabulary ladder (open
   * chat, stories, chat targets) and lead the journal's word chips. (Phase 39's 20-a-session limit is
   * gone: every ticked word is introduced at Save.) */
  recentClasses: 3,
  /** Phase 40 Part E.4: a new class shows on Home for this many days. */
  homeDays: 3,
};

/**
 * The grammar points a tutor's notes name, matched to the app's grammar items by the point's name
 * (Taiwan characters). First match wins; an id the lexicon doesn't have is skipped. A point with no
 * match is a session grammar note (shown with the class, no cards).
 */
export const TUTOR_GRAMMAR_RULES: ReadonlyArray<{ match: RegExp; id: string }> = [
  { match: /剛剛|剛才/, id: 'gram-ganggang-just' },
  { match: /還沒/, id: 'gram-hai-still' },
  { match: /的時候/, id: 'gram-de-shihou' },
  { match: /跟.*一起/, id: 'gram-gen-yiqi' },
  { match: /可以.*能|能.*可以/, id: 'gram-neng-possibility' },
  { match: /什麼/, id: 'gram-shenme-question' },
  { match: /主語.*時間.*地點|時間.*地點.*(動作|動詞)/, id: 'gram-time-place-order' },
  { match: /比/, id: 'gram-bi-comparison' },
  { match: /過/, id: 'gram-guo-experience' },
  { match: /把/, id: 'gram-ba-directional' },
  { match: /會/, id: 'gram-hui-can' },
  { match: /了/, id: 'gram-le-completion' },
];
