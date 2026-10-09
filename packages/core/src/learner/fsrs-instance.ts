import { createEmptyCard, fsrs, generatorParameters, type Card, type FSRS } from 'ts-fsrs';
import { itemStateOf } from '../progress/terms.js';
import type { ItemState } from '../types.js';
import type { LearnerConfig } from './types.js';

export function buildFsrs(config: LearnerConfig): FSRS {
  return fsrs(generatorParameters({ request_retention: config.requestRetention }));
}

export function emptyCard(now: Date): Card {
  return createEmptyCard(now);
}

/** Map an FSRS Card's own state + stability to the game's coarser ladder. Phase 29 Part B.9: the
 * thresholds live in `progress.config.ts` and the mapping in `progress/terms.ts` (`itemStateOf`). */
export function computeItemState(card: Card, _config?: LearnerConfig): ItemState {
  return itemStateOf(card);
}
