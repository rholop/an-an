import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, isThemeChoice, readStoredTheme, THEME_STORAGE_KEY } from './theme.js';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}
afterEach(() => vi.unstubAllGlobals());

describe('theme', () => {
  beforeEach(() => fakeStorage());

  it('reads a stored choice, and falls back to system for anything else', () => {
    fakeStorage({ [THEME_STORAGE_KEY]: 'dark' });
    expect(readStoredTheme()).toBe('dark');
    fakeStorage({ [THEME_STORAGE_KEY]: 'sepia' });
    expect(readStoredTheme()).toBe('system');
    fakeStorage();
    expect(readStoredTheme()).toBe('system');
  });

  it('survives storage being blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readStoredTheme()).toBe('system');
  });

  it('light/dark set data-theme; system removes it so prefers-color-scheme decides', () => {
    const root = { dataset: {} as Record<string, string | undefined> } as unknown as HTMLElement;
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    applyTheme('light', root);
    expect(root.dataset.theme).toBe('light');
    applyTheme('system', root);
    expect(root.dataset.theme).toBeUndefined();
  });

  it('only accepts the three known choices', () => {
    expect(['system', 'light', 'dark'].every(isThemeChoice)).toBe(true);
    expect(isThemeChoice('auto')).toBe(false);
    expect(isThemeChoice(undefined)).toBe(false);
  });
});
