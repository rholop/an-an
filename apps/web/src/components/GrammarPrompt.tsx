import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { grammarMeaningHint, maskPatternFor, type GrammarItem, type GrammarStepExercise } from '@anan/core';
import { GRAMMAR_EXPLANATION } from '../lib/labels.js';
import './GrammarPrompt.css';

/**
 * Phase 46 Part A: the one place a grammar exercise shows its pattern. Before the answer: the
 * pattern masked (every part that is a choice or in the answer is ＿＿; hidden altogether when
 * nothing useful is left) and the English meaning, masked the same way. After the answer: the full
 * pattern; `after` (the explanation, the class notes, the example) goes below the exercise.
 */
export function GrammarPrompt({
  item,
  ex,
  answered,
  lead,
  wrapPattern,
}: {
  item: Pick<GrammarItem, 'pattern' | 'explanationEn'>;
  ex: GrammarStepExercise;
  answered: boolean;
  /** Shown before the pattern on the same line ("2 of 7 ·", "Grammar practice ·"). */
  lead?: ReactNode;
  /** Review only: the Phase 41 simplified hint around the pattern shown. */
  wrapPattern?: (text: string) => ReactNode;
}) {
  const shown = answered ? item.pattern : maskPatternFor(item.pattern, ex);
  const meaning = answered ? undefined : grammarMeaningHint(item.explanationEn, ex);
  return (
    <div className="grammar-prompt" data-testid="grammar-prompt" data-answered={answered ? 'yes' : 'no'}>
      {(lead || shown) && (
        <p className="grammar-prompt-pattern">
          {lead}
          {shown && (
            <span lang="zh-Hant" data-testid="grammar-pattern" data-masked={answered ? 'no' : 'yes'}>
              {wrapPattern ? wrapPattern(shown) : shown}
            </span>
          )}
        </p>
      )}
      {meaning && (
        <p className="grammar-prompt-meaning" data-testid="grammar-meaning">
          {meaning}
        </p>
      )}
    </div>
  );
}

/**
 * After the answer: the item's own explanation, then whatever the caller adds (class notes, example).
 * `aside` (Review's Nope) sits beside it. With `collapseIfTight` (Review) it starts as a
 * "What it means ▸" line when it would push the page past a laptop window (Phase 30), as the
 * Phase 44 character row does.
 */
export function GrammarAfter({
  item,
  children,
  aside,
  collapseIfTight,
}: {
  item: Pick<GrammarItem, 'explanationEn'>;
  children?: ReactNode;
  aside?: ReactNode;
  collapseIfTight?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const touched = useRef(false);
  useLayoutEffect(() => {
    if (!collapseIfTight || touched.current || !open) return;
    if (window.innerWidth >= 700 && document.documentElement.scrollHeight > window.innerHeight) setOpen(false);
  }, [collapseIfTight, open]);
  const body = (
    <>
      {collapseIfTight && (
        <button
          type="button"
          className="grammar-after-toggle"
          aria-expanded={open}
          data-testid="grammar-after-toggle"
          onClick={() => {
            touched.current = true;
            setOpen((o) => !o);
          }}
        >
          {GRAMMAR_EXPLANATION} {open ? '▾' : '▸'}
        </button>
      )}
      {open && (
        <>
          <p>{item.explanationEn}</p>
          {children}
        </>
      )}
    </>
  );
  return (
    <div className={aside ? 'grammar-after grammar-after--aside' : 'grammar-after'} data-testid="grammar-after" data-open={open ? 'true' : 'false'}>
      {aside ? <div className="grammar-after-body">{body}</div> : body}
      {aside}
    </div>
  );
}
