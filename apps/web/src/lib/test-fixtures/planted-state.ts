// Phase 29 lint fixture (never imported): a SkillCard's own state and reps, also through Pick<>.
import type { SkillCard } from '@anan/core';
export const a = (c: SkillCard) => c.state === 'review';
export const b = (c: Pick<SkillCard, 'card'>) => c.card.reps > 0;
