/**
 * The ONE place TOCFL levels are defined (phase 7). Everything else — the
 * `Level` type, the zod schema, ordering, the UI level picker, scenario
 * ranges, prompts — derives from this table; nothing hardcodes a level list.
 *
 * Matches the 2023 TOCFL "8000 words" list: two Novice levels plus Levels
 * 1–5 (入門 … 流利), i.e. SEVEN levels. There is no Level 6 (an earlier
 * assumption in this repo); `levels.test.ts` checks this table against the
 * levels actually present in the built lexicon.
 */
export const LEVELS = [
  { id: 'N1', order: 0, nameEn: 'Novice 1', nameZh: '準備級一級', cefr: 'pre-A1' },
  { id: 'N2', order: 1, nameEn: 'Novice 2', nameZh: '準備級二級', cefr: 'pre-A1' },
  { id: 'L1', order: 2, nameEn: 'Beginner', nameZh: '入門級', cefr: 'A1' },
  { id: 'L2', order: 3, nameEn: 'Basic', nameZh: '基礎級', cefr: 'A2' },
  { id: 'L3', order: 4, nameEn: 'Intermediate', nameZh: '進階級', cefr: 'B1' },
  { id: 'L4', order: 5, nameEn: 'Advanced', nameZh: '高階級', cefr: 'B2' },
  { id: 'L5', order: 6, nameEn: 'Fluent', nameZh: '流利級', cefr: 'C1–C2' },
] as const;

export type Level = (typeof LEVELS)[number]['id'];
export type LevelInfo = (typeof LEVELS)[number];

/** Level ids in learning order. */
export const LEVEL_IDS: readonly Level[] = LEVELS.map((l) => l.id);
export const FIRST_LEVEL: Level = LEVELS[0].id;
export const LAST_LEVEL: Level = LEVELS[LEVELS.length - 1]!.id;

export function levelInfo(level: Level): LevelInfo {
  return LEVELS.find((l) => l.id === level)!;
}

/** 0-based position in learning order. */
export function levelIndex(level: Level): number {
  return levelInfo(level).order;
}

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && LEVEL_IDS.includes(value as Level);
}

export function nextLevel(level: Level): Level | null {
  return LEVEL_IDS[levelIndex(level) + 1] ?? null;
}

/** "L2 基礎級 · A2" — the picker / header label. */
export function levelLabel(level: Level): string {
  const l = levelInfo(level);
  return `${l.id} ${l.nameZh} · ${l.cefr}`;
}

/** "L2": only in tight chips, with `levelLabel` as the tooltip (Phase 21 Part H). */
export function levelShort(level: Level): string {
  return levelInfo(level).id;
}

/** "TOCFL L2": gate messages and study steps. */
export function tocflLabel(level: Level): string {
  return `TOCFL ${levelShort(level)}`;
}
