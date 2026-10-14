// OpenCC converters, each loaded lazily by the one screen that needs it. No AI and no network.
// Phase 39 Part B.1: simplified → traditional, for the Tutoring screen.
// Phase 41: traditional → simplified (characters only), for the hint above a flashcard's word.

export interface TaiwanConverters {
  /** Characters only (cn → tw): 意大利面 → 意大利麵. */
  toTraditional: (s: string) => string;
  /** Taiwan phrases too (cn → twp): 意大利面 → 義大利麵, 软件 → 軟體. */
  toTaiwan: (s: string) => string;
}

let loading: Promise<TaiwanConverters> | undefined;

export function loadTaiwanConverters(): Promise<TaiwanConverters> {
  loading ??= import('opencc-js/cn2t')
    .then((OpenCC) => ({
      toTraditional: OpenCC.Converter({ from: 'cn', to: 'tw' }),
      toTaiwan: OpenCC.Converter({ from: 'cn', to: 'twp' }),
    }))
    .catch((err: unknown) => {
      loading = undefined;
      throw err;
    });
  return loading;
}

/** Phase 41: Taiwan → mainland, characters only (tw → cn): 餅乾 → 饼干, 軟體 → 软体 (never 软件). */
export type Simplifier = (s: string) => string;

let simplifying: Promise<Simplifier> | undefined;

export function loadSimplifier(): Promise<Simplifier> {
  simplifying ??= import('opencc-js/t2cn')
    .then((OpenCC) => OpenCC.Converter({ from: 'tw', to: 'cn' }))
    .catch((err: unknown) => {
      simplifying = undefined;
      throw err;
    });
  return simplifying;
}
