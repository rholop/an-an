import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../db/instance.js';
import { registerBeforeSwitch } from './profile-controller.js';

/**
 * A setting stored in the CURRENT profile's database (`settings` table), so
 * display mode, scaffolding, drafts etc. are per person. Loads on mount
 * (pages re-mount when the profile changes) and writes through. It also
 * registers a before-switch flush, so a value changed a moment ago — or a
 * half-written journal draft — is saved before the other profile opens.
 */
export function useSetting<T>(
  key: string,
  fallback: T,
  debounceMs = 0,
): [T, (v: T) => void, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef<T>(fallback);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    db.settings
      .get(key)
      .then((row) => {
        if (cancelled) return;
        if (row && row.value !== undefined && !dirty.current) {
          latest.current = row.value as T;
          setValue(row.value as T);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [key]);

  const write = useCallback(async () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    await db.settings.put({ key, value: latest.current });
  }, [key]);

  useEffect(() => registerBeforeSwitch(write), [write]);

  const set = useCallback(
    (v: T) => {
      latest.current = v;
      dirty.current = true;
      setValue(v);
      // typed text (drafts) is written after a short pause; everything else at once
      if (debounceMs > 0) timer.current = setTimeout(() => void write(), debounceMs);
      else void write();
    },
    [write, debounceMs],
  );

  return [value, set, loaded];
}
