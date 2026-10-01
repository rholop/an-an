import { useEffect, useState } from 'react';
import { ScenarioFileSchema, type Scenario } from '@anan/core';

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

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}scenarios/scenarios.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const parsed = ScenarioFileSchema.parse(data);
        setState({ status: 'ready', scenarios: parsed.scenarios });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
