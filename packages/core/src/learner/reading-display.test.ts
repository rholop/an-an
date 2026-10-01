import { describe, expect, it } from 'vitest';
import { emptyCard } from './fsrs-instance.js';
import { DEFAULT_READING_DISPLAY_CONFIG, readingDisplay } from './reading-display.js';

const now = new Date('2026-01-01');

function cardWith(stability: number, readingDependence: number) {
  return { card: { ...emptyCard(now), stability }, readingDependence };
}

describe('readingDisplay', () => {
  it('shows pinyin for a weak (low-stability) card regardless of readingDependence', () => {
    expect(readingDisplay(cardWith(1, 0))).toBe('shown');
  });

  it('shows pinyin for a strong card that still leans on the reading (high readingDependence)', () => {
    expect(readingDisplay(cardWith(50, 0.9))).toBe('shown');
  });

  it('fades to hover only once both strong AND not reading-dependent', () => {
    expect(readingDisplay(cardWith(50, 0.1))).toBe('hover');
  });

  it('respects a custom config', () => {
    const lenient = { minStabilityDays: 5, maxReadingDependence: 0.9 };
    expect(readingDisplay(cardWith(6, 0.8), lenient)).toBe('hover');
    expect(readingDisplay(cardWith(6, 0.8), DEFAULT_READING_DISPLAY_CONFIG)).toBe('shown');
  });
});
