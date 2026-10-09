import { grammarDots, PROGRESS_CONFIG, type GrammarItem, type GrammarUse } from '@anan/core';
import { grammarDotsLabel, grammarDotsText } from '../lib/labels.js';
import { useProgressData } from '../lib/study.js';
import './GrammarDots.css';

const NEED = PROGRESS_CONFIG.mastered.grammarCorrectUses;

/** Phase 25: ●●○ = 2 of 3 correct uses (the third only on a later day). */
export function GrammarDots({ use, testId }: { use: GrammarUse | undefined; testId?: string }) {
  const dots = grammarDots(use);
  return (
    <span className="grammar-dots" aria-label={grammarDotsLabel(dots, NEED)} title={grammarDotsLabel(dots, NEED)} data-testid={testId ?? 'grammar-dots'} data-dots={dots}>
      {grammarDotsText(dots, NEED)}
    </span>
  );
}

/** Each grammar point with its dots (lesson page and Home). */
export function GrammarDotsList({ items }: { items: readonly Pick<GrammarItem, 'id' | 'pattern'>[] }) {
  const progress = useProgressData();
  if (items.length === 0) return null;
  return (
    <ul className="grammar-dots-list" data-testid="grammar-dots-list">
      {items.map((g) => (
        <li key={g.id}>
          <span lang="zh-Hant">{g.pattern}</span> <GrammarDots use={progress?.grammarUses.get(g.id)} />
        </li>
      ))}
    </ul>
  );
}
