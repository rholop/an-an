import { useEffect, useState } from 'react';
import { ScenarioFileSchema, withTutorExtras, type Scenario } from '@anan/core';
import { dataUrl } from './data-files.js';
import { peekTutorLessons } from './study.js';
import { onStudyDirty } from './study-dirty.js';

export type ScenariosLoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; scenarios: Scenario[] };

/** Fetches the built scenario list (see apps/web/scripts/sync-scenarios.mjs),
 * mirroring useLexicon.ts. Validated against core's own schema rather than
 * trusted blindly — it's a static asset today, but the shape still comes
 * from outside this module. */
export function useScenarios(): ScenariosLoadState {
  const [state, setState] = useState<ScenariosLoadState>({ status: 'loading' });
  const [built, setBuilt] = useState<Scenario[] | null>(null);
  // Phase 40 Part C.3: tutoring words join the scenarios whose topics match their class.
  const [tutorTick, setTutorTick] = useState(0);
  useEffect(() => onStudyDirty(() => setTutorTick((n) => n + 1)), []);

  useEffect(() => {
    let cancelled = false;
    dataUrl('scenarios/scenarios.json')
      .then((url) => fetch(url))
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const parsed = ScenarioFileSchema.parse(data);
        setBuilt(parsed.scenarios);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (built) setState({ status: 'ready', scenarios: withTutorExtras(built, peekTutorLessons()) });
  }, [built, tutorTick]);

  return state;
}
