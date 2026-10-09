import { PROGRESS_CONFIG, type GrammarItem } from '@anan/core';
import { grammarDotsLabel, grammarDotsText } from '../lib/labels.js';
import { useLedger } from '../lib/ledger.js';
import './GrammarDots.css';

const NEED = PROGRESS_CONFIG.mastered.grammarCorrectUses;

/** Phase 25: ●●○ = 2 of 3 correct uses (the third only on a later day). Phase 29 Part B.8: the dots
 * are the ledger's (`ledger.item(ref).dots`), the same tally as Mastered, so ●●● means Mastered. */
export function GrammarDots({ dots, testId }: { dots: number; testId?: string }) {
  return (
    <span className="grammar-dots" aria-label={grammarDotsLabel(dots, NEED)} title={grammarDotsLabel(dots, NEED)} data-testid={testId ?? 'grammar-dots'} data-dots={dots}>
      {grammarDotsText(dots, NEED)}
    </span>
  );
}

/** Each grammar point with its dots (lesson page and Home). */
export function GrammarDotsList({ items }: { items: readonly Pick<GrammarItem, 'id' | 'pattern'>[] }) {
  const ledger = useLedger();
  if (items.length === 0) return null;
  return (
    <ul className="grammar-dots-list" data-testid="grammar-dots-list">
      {items.map((g) => (
        <li key={g.id}>
          <span lang="zh-Hant">{g.pattern}</span> <GrammarDots dots={ledger?.item({ kind: 'grammar', id: g.id }).dots ?? 0} />
        </li>
      ))}
    </ul>
  );
}
