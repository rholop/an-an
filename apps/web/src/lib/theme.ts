import { useSyncExternalStore } from 'react';

/**
 * Light / dark / follow-the-system. Stored per BROWSER (localStorage), not per
 * profile: it has to apply on the profile screen too, before any database is
 * open. `index.html` applies the stored choice before first paint, so there is
 * no flash of the wrong theme; this module keeps it in sync after that.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'system', 'dark'];

export const THEME_STORAGE_KEY = 'anan.theme';

export const isThemeChoice = (v: unknown): v is ThemeChoice =>
  v === 'system' || v === 'light' || v === 'dark';

export function readStoredTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(v) ? v : 'system';
  } catch {
    return 'system'; // storage blocked: just follow the system
  }
}

/** `system` = no attribute, so the stylesheet's prefers-color-scheme rules apply. */
export function applyTheme(
  choice: ThemeChoice,
  root: HTMLElement = document.documentElement,
): void {
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

let current: ThemeChoice = 'system';
let initialised = false;
const listeners = new Set<() => void>();

function ensureInit(): void {
  if (initialised || typeof document === 'undefined') return;
  initialised = true;
  current = readStoredTheme();
  applyTheme(current);
}

export function setTheme(choice: ThemeChoice): void {
  ensureInit();
  current = choice;
  applyTheme(choice);
  try {
    if (choice === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* the choice still applies for this visit */
  }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  ensureInit();
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const getSnapshot = (): ThemeChoice => {
  ensureInit();
  return current;
};

export function useTheme(): { theme: ThemeChoice; setTheme: (c: ThemeChoice) => void } {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => 'system' as ThemeChoice);
  return { theme, setTheme };
}
