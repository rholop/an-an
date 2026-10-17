import { useEffect, useState } from 'react';
import { dataUrl, onDataFilesChanged } from './data-files.js';

/**
 * Phase 44: the shortened Unihan character glosses (`lexicon/char-glosses.v1.json`, hashed through
 * the data manifest), loaded the first time a review card wants them. A character with no lexicon
 * entry of its own takes its meaning from here. Without the file the row just shows fewer meanings.
 */
/** Settings → Review → "Show what each character means": per profile, synced, on by default. */
export const CHAR_BREAKDOWN_SETTING = 'flashcardCharMeanings';

export const CHAR_GLOSSES_FILE = 'lexicon/char-glosses.v1.json';

let loaded: Promise<ReadonlyMap<string, string>> | null = null;
let ready: ReadonlyMap<string, string> | undefined;

export function loadCharGlosses(): Promise<ReadonlyMap<string, string>> {
  loaded ??= (async () => {
    try {
      const res = await fetch(await dataUrl(CHAR_GLOSSES_FILE));
      if (!res.ok) return new Map<string, string>();
      const map = new Map(Object.entries((await res.json()) as Record<string, string>));
      ready = map;
      return map;
    } catch {
      loaded = null; // offline before it was ever cached: try again next card
      return new Map<string, string>();
    }
  })();
  return loaded;
}

onDataFilesChanged((changed) => {
  if (changed.includes(CHAR_GLOSSES_FILE)) {
    loaded = null;
    ready = undefined;
  }
});

/** The glosses once loaded (undefined until then, or while `enabled` is false). */
export function useCharGlosses(enabled: boolean): ReadonlyMap<string, string> | undefined {
  const [glosses, setGlosses] = useState(() => ready);
  useEffect(() => {
    if (!enabled || glosses) return;
    let live = true;
    void loadCharGlosses().then((g) => live && setGlosses(g));
    return () => {
      live = false;
    };
  }, [enabled, glosses]);
  return enabled ? glosses : undefined;
}
