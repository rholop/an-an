// The 'xlsx' package is CJS and doesn't reliably expose named ESM exports
// (readFile in particular is assigned dynamically) — default-import the
// whole module instead.
import XLSX from 'xlsx';
import type { Level } from '@anan/core';

export interface TocflRawRow {
  level: Level;
  context: string | null;
  headwordRaw: string;
  pinyinRaw: string;
  posRaw: string;
  sheetRow: number; // 1-based row number within its sheet, for the review report
}

const SHEETS: { name: string; level: Level; hasContext: boolean }[] = [
  { name: '準備級一級(Novice 1)', level: 'N1', hasContext: true },
  { name: '準備級二級(Novice 2)', level: 'N2', hasContext: true },
  { name: '入門級(Level 1)', level: 'L1', hasContext: true },
  { name: '基礎級(Level 2)', level: 'L2', hasContext: true },
  { name: '進階級(Level 3)', level: 'L3', hasContext: false },
  { name: '高階級(Level 4)', level: 'L4', hasContext: false },
  { name: '流利級(Level 5)', level: 'L5', hasContext: false },
];

/** No Level 6 sheet exists in the current SC-TOP download — see CLAUDE.md
 * "Open items to verify, not assume". Exposed so the build can note it. */
export const MISSING_LEVELS: Level[] = ['L6'];

export function readTocflWorkbook(path: string): TocflRawRow[] {
  const wb = XLSX.readFile(path, { cellDates: false });
  const rows: TocflRawRow[] = [];

  for (const { name, level, hasContext } of SHEETS) {
    const ws = wb.Sheets[name];
    if (!ws) throw new Error(`readTocflWorkbook: expected sheet "${name}" not found in ${path}`);
    const raw = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1, defval: null });

    for (let i = 1; i < raw.length; i++) {
      // skip header row
      const row = raw[i]!;
      const contextCell = hasContext ? row[0] : null;
      const headwordCell = hasContext ? row[1] : row[0];
      const pinyinCell = hasContext ? row[2] : row[1];
      const posCell = hasContext ? row[3] : row[2];
      if (headwordCell == null || String(headwordCell).trim() === '') continue;

      rows.push({
        level,
        context: contextCell != null ? String(contextCell).trim() : null,
        headwordRaw: String(headwordCell),
        pinyinRaw: pinyinCell != null ? String(pinyinCell) : '',
        posRaw: posCell != null ? String(posCell) : '',
        sheetRow: i + 1,
      });
    }
  }

  return rows;
}
