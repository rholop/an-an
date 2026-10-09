import { describe, expect, it } from 'vitest';
import { saveView } from './SaveStatus.js';
import { notSavedFor } from '../lib/labels.js';

const now = new Date('2026-10-09T14:00:00Z');
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

describe('the header cloud (Phase 28): never a dot only', () => {
  it('Saved, Saving… and Not saved for N', () => {
    expect(saveView('synced', null, now)).toBe('saved');
    expect(saveView('pending', ago(0.1), now)).toBe('saving');
    expect(saveView('saving', ago(5), now)).toBe('saving');
    // changes that sat unsaved past the quiet period are a warning even without a failure
    expect(saveView('pending', ago(5), now)).toBe('unsaved');
    for (const s of ['offline', 'too_large', 'outdated'] as const) expect(saveView(s, ago(1), now)).toBe('unsaved');
  });

  it('says how long', () => {
    expect(notSavedFor(ago(12), now)).toBe('Not saved for 12 min');
    expect(notSavedFor(ago(125), now)).toBe('Not saved for 2 h');
  });
});
