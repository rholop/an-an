import { useSyncExternalStore } from 'react';

/** Live `matchMedia`. `false` where matchMedia doesn't exist (tests, SSR). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** Phones: a narrow screen, or a device with no hover (a touch screen). */
export const SHEET_QUERY = '(max-width: 639.98px), (hover: none)';
/** The device can hover (a mouse or trackpad). */
export const CAN_HOVER_QUERY = '(hover: hover)';
