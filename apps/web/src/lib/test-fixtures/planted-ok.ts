// Phase 29 lint fixture (never imported): a plain object with a `state`, and a write, are fine.
import type { SkillCard } from '@anan/core';
export const s = (x: { state: string; due: Date }) => x.state + x.due.toISOString();
export const write = (c: SkillCard) => {
  c.state = 'review';
};
