// Phase 29 lint fixture (never imported): a planted "due" check the progress rule must reject.
import type { SkillCard } from '@anan/core';
export const plantedDue = (card: SkillCard, now: Date): boolean => card.card.due <= now;
