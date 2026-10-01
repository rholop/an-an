import { DEFAULT_LEARNER_CONFIG } from '@anan/core';
import { GameService } from '../lib/game-service.js';
import { LearnerService } from '../lib/learner-service.js';
import { DexieLearnerRepo } from './learner-repo.js';
import { AnanDB } from './schema.js';

// Single shared instance for the whole app — a PWA has one user per
// install, so there's no multi-tenancy concern that would call for a
// context/provider here.
export const db = new AnanDB();
export const learnerRepo = new DexieLearnerRepo(db);
export const gameService = new GameService(db);
export const learnerService = new LearnerService(
  learnerRepo,
  DEFAULT_LEARNER_CONFIG,
  (evidence, prior) => gameService.onEvidence(evidence, prior),
);

// Dev/e2e-only hook: lets Playwright seed/inspect the DB directly without a
// dedicated test API. Never included in a production build.
if (import.meta.env.DEV) {
  (window as unknown as { __anan: unknown }).__anan = {
    db,
    learnerRepo,
    learnerService,
    gameService,
  };
}
