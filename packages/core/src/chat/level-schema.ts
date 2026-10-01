import { z } from 'zod';

/** zod mirror of the `Level` union in ../types.ts — kept in sync by hand
 * since Level itself is a plain TS type, not zod-derived (it's used
 * everywhere in core, most of which has no reason to depend on zod). */
export const LevelSchema = z.enum(['N1', 'N2', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
