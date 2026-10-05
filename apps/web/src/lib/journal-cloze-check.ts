import type { AnanDB } from '../db/schema.js';
import { getProtectedTerms } from './journal-protected.js';

/** Latin names the learner may use in a sentence: their protected terms that
 * contain letters (everything else in a cloze must be Chinese). */
export async function allowedLatinNames(db: AnanDB): Promise<string[]> {
  return (await getProtectedTerms(db)).filter((t) => /[A-Za-z]/.test(t));
}
