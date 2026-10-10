import { useEffect } from 'react';
import { useSetting } from './useSetting.js';

/**
 * Phase 30: Settings → Chinese text size. A profile setting (the settings table, so it syncs and
 * follows a profile switch). It multiplies only the `--zh-*` tokens in theme.css, so browser zoom
 * can shrink the app chrome while the characters stay a good size.
 */
export type ZhTextSize = 'smaller' | 'normal' | 'larger' | 'largest';
export const ZH_TEXT_SIZE_KEY = 'zhTextSize';
export const ZH_TEXT_SIZES: { id: ZhTextSize; label: string; scale: number }[] = [
  { id: 'smaller', label: 'Smaller', scale: 0.85 },
  { id: 'normal', label: 'Normal', scale: 1 },
  { id: 'larger', label: 'Larger', scale: 1.2 },
  { id: 'largest', label: 'Largest', scale: 1.4 },
];

export function zhScale(size: unknown): number {
  return ZH_TEXT_SIZES.find((s) => s.id === size)?.scale ?? 1;
}

export function useZhTextSize(): [ZhTextSize, (v: ZhTextSize) => void] {
  const [size, setSize] = useSetting<ZhTextSize>(ZH_TEXT_SIZE_KEY, 'normal');
  return [size, setSize];
}

/** Sets `--zh-scale` on the page from the current profile's setting (mounted once, in App). */
export function useApplyZhTextSize(root: HTMLElement = document.documentElement): void {
  const [size] = useZhTextSize();
  useEffect(() => {
    const scale = zhScale(size);
    if (scale === 1) root.style.removeProperty('--zh-scale');
    else root.style.setProperty('--zh-scale', String(scale));
  }, [size, root]);
}
