import { useEffect, useState, type ReactNode } from 'react';
import { loadSimplifier, type Simplifier } from '../lib/opencc.js';
import { useSetting } from '../lib/useSetting.js';

/**
 * Phase 41: the simplified form in small text above a flashcard's traditional word (饼干 above
 * 餅乾), only when it differs. A display hint only: never stored, typed or accepted as an answer.
 * Flashcards only (Review and Water all through ReviewCard); the architecture test keeps it there.
 */

/** Settings → Review → "Show simplified characters on flashcards": per profile, synced, on by default. */
export const SIMPLIFIED_HINT_SETTING = 'flashcardSimplified';

let simplifier: Simplifier | undefined;
const cache = new Map<string, string>();

/** The simplified form of `text`, or '' when it is the same (可以, 吃, 早餐) or not loaded yet. */
export function simplifiedOf(text: string, convert: Simplifier | undefined = simplifier): string {
  if (!convert || !text) return '';
  let out = cache.get(text);
  if (out === undefined) {
    const s = convert(text);
    out = s === text ? '' : s;
    cache.set(text, out);
  }
  return out;
}

function useSimplifier(enabled: boolean): Simplifier | undefined {
  const [convert, setConvert] = useState<Simplifier | undefined>(() => simplifier);
  useEffect(() => {
    if (!enabled || convert) return;
    let live = true;
    loadSimplifier()
      .then((c) => {
        simplifier = c;
        if (live) setConvert(() => c);
      })
      // no hint is the safe fallback: the card itself never depends on it
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, convert]);
  return convert;
}

/** `children` (the traditional text) with its simplified form stacked above it, when that differs. */
export function WithSimplified({ text, children }: { text: string; children: ReactNode }) {
  const [enabled] = useSetting<boolean>(SIMPLIFIED_HINT_SETTING, true);
  const convert = useSimplifier(enabled);
  const hint = enabled ? simplifiedOf(text, convert) : '';
  if (!hint) return <>{children}</>;
  return (
    <span className="zh-hint-stack">
      <span className="zh-hint" lang="zh-Hans" aria-hidden="true" data-testid="simplified-hint">
        {hint}
      </span>
      <span className="zh-hint-word">{children}</span>
    </span>
  );
}
