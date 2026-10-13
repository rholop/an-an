// Phase 39 Part B.1: simplified → traditional with OpenCC, loaded only on the Tutoring screen.

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
