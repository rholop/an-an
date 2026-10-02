import { z } from 'zod';

import { LEVEL_IDS, type Level } from '../levels.config.js';

/** zod mirror of `Level`, built from levels.config (never a second list). */
export const LevelSchema = z.enum(LEVEL_IDS as unknown as [Level, ...Level[]]);
