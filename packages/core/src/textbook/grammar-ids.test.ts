import { describe, expect, it } from 'vitest';
import { splitGrammarEvidence } from './grammar-ids.js';

const ev = (id: string, refId?: string) => ({ item: { kind: 'grammar' as const, id }, ...(refId ? { context: { refId } } : {}) });

describe('splitGrammarEvidence (Phase 25 B8)', () => {
  it.each([
    ['laixue-3-L03', 'gram-cong-dao-time'],
    ['tb-b3-L03-004', 'gram-cong-dao-time'],
    ['laixue-2-L06', 'gram-cong-dao'],
    ['tb-b2-L06-001', 'gram-cong-dao'],
    [undefined, 'gram-cong-dao'],
  ])('從…到 answered at %s → %s', (refId, to) => {
    expect(splitGrammarEvidence(ev('gram-cong-dao', refId)).item.id).toBe(to);
  });
  it('shared ids and words are left alone', () => {
    expect(splitGrammarEvidence(ev('gram-yihou', 'laixue-3-L01')).item.id).toBe('gram-yihou');
    const w = { item: { kind: 'word' as const, id: 'gram-cong-dao' }, context: { refId: 'laixue-3-L03' } };
    expect(splitGrammarEvidence(w)).toBe(w);
  });
});
