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
 * The grammar points a tutor's notes name, matched to the app's grammar items (Phase 46 Part D). A
 * rule matches only when the point's name (Taiwan characters) contains the item's marker (`name`)
 * AND the class example contains it too (`example`). No bare one-character rules for 了 / 會 / 過 /
 * 比 / 把: each needs its pattern written out (V + 過, 比 + N, 把 + O, 會 + V, V + 了). First match
 * wins; an id the lexicon doesn't have is skipped. A point naming two items it compares (可以 vs 能)
 * matches both (`TUTOR_COMPARE_CUE`), or is a note when one of them is missing. A point with no match
 * is a session grammar note (shown with the class, no cards).
 */
export const TUTOR_GRAMMAR_RULES: ReadonlyArray<{ name: RegExp; example: RegExp; id: string }> = [
  { name: /剛剛|剛才/, example: /剛/, id: 'gram-ganggang-just' },
  { name: /還沒/, example: /還沒/, id: 'gram-hai-still' },
  { name: /的時候/, example: /的時候/, id: 'gram-de-shihou' },
  { name: /跟.*一起/, example: /跟.+一起/, id: 'gram-gen-yiqi' },
  { name: /可以/, example: /可以/, id: 'gram-keyi-permission' },
  { name: /能/, example: /能/, id: 'gram-neng-possibility' },
  { name: /什麼/, example: /什麼/, id: 'gram-shenme-question' },
  { name: /主語.*時間.*地點|時間.*地點.*(動作|動詞)/, example: /在/, id: 'gram-time-place-order' },
  { name: /比\s*\+?\s*(N|B|名詞)|A\s*\+?\s*比/, example: /比/, id: 'gram-bi-comparison' },
  { name: /(V|動詞)\s*\+?\s*過/, example: /過/, id: 'gram-guo-experience' },
  { name: /把\s*\+?\s*(O|賓語)/, example: /把/, id: 'gram-ba-directional' },
  { name: /會\s*\+?\s*(V|動詞)/, example: /會/, id: 'gram-hui-can' },
  { name: /(V|動詞)\s*\+?\s*((O|賓語)\s*\+?\s*)?了/, example: /了/, id: 'gram-le-completion' },
];

/** A point that compares the items it names ("可以 vs 能不能", "會和能", "還是 / 或是"). */
export const TUTOR_COMPARE_CUE = /\bvs\.?|和|與|比較|對比|區別|區分|\/|／|、/i;
