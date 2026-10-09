// Phase 29 lint fixture (never imported): a planted "due" check the progress rule must reject.
import type { SkillCard } from '../../learner/types.js';
export const plantedDue = (card: SkillCard, now: Date): boolean => card.card.due <= now;
