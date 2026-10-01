import type { SkillCard } from './types.js';

export type ReadingDisplayMode = 'shown' | 'hover';

export interface ReadingDisplayConfig {
  /** Minimum stability (days) before pinyin is eligible to fade to hover-only. */
  minStabilityDays: number;
  /** readingDependence at/above which pinyin stays shown regardless of strength. */
  maxReadingDependence: number;
}

export const DEFAULT_READING_DISPLAY_CONFIG: ReadingDisplayConfig = {
  minStabilityDays: 21, // matches the default "mature" threshold
  maxReadingDependence: 0.5,
};

/**
 * Pinyin fading (phase doc §1): a card only graduates to hover-only once
 * it's genuinely strong (stability past the maturity bar) AND the learner
 * hasn't been leaning on the reading (chat_hover_reading keeps
 * readingDependence high). <AnnotatedText>'s `auto` mode should call this
 * per recognition-skill card.
 */
export function readingDisplay(
  card: Pick<SkillCard, 'card' | 'readingDependence'>,
  config: ReadingDisplayConfig = DEFAULT_READING_DISPLAY_CONFIG,
): ReadingDisplayMode {
  const strong = card.card.stability >= config.minStabilityDays;
  const notReadingDependent = card.readingDependence < config.maxReadingDependence;
  return strong && notReadingDependent ? 'hover' : 'shown';
}
