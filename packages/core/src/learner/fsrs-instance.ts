import { createEmptyCard, fsrs, generatorParameters, State, type Card, type FSRS } from 'ts-fsrs';
import type { ItemState } from '../types.js';
import type { LearnerConfig } from './types.js';

export function buildFsrs(config: LearnerConfig): FSRS {
  return fsrs(generatorParameters({ request_retention: config.requestRetention }));
}

export function emptyCard(now: Date): Card {
  return createEmptyCard(now);
}

/** Map an FSRS Card's own state + stability to the game's coarser
 * unseen -> introduced -> learning -> review -> mature ladder. There is no
 * FSRS State for "unseen" — that's the absence of a SkillCard at all (see
 * applyEvidence), so this is only called once a card exists. */
export function computeItemState(card: Card, config: LearnerConfig): ItemState {
  switch (card.state) {
    case State.New:
      return 'introduced';
    case State.Learning:
    case State.Relearning:
      return 'learning';
    case State.Review:
      return card.stability >= config.matureStabilityDays ? 'mature' : 'review';
    default:
      return 'introduced';
  }
}
