// Phase 29 lint fixture (never imported): the ledger (core/progress) may read cards.
import type { SkillCard } from '../../learner/types.js';
export const plantedDue = (card: SkillCard, now: Date): boolean => card.card.due <= now;
