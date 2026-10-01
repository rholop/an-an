import type { ReviewNote } from './normalize.js';

export interface MismatchNote {
  headword: string;
  level: string;
  tocflPinyin: string;
  moePinyin: string;
}

export interface UnverifiedNote {
  headword: string;
  level: string;
  reason: string;
}

export interface DuplicateNote {
  headword: string;
  pinyin: string;
  pos: string;
  keptLevel: string;
  droppedLevel: string;
}

export class ReviewReport {
  normalizeNotes: ReviewNote[] = [];
  mismatches: MismatchNote[] = [];
  unverified: UnverifiedNote[] = [];
  duplicates: DuplicateNote[] = [];
  missingGloss: string[] = [];
  other: string[] = [];

  render(meta: { version: string; buildDate: string; wordCount: number; missingLevels: string[] }): string {
    const lines: string[] = [];
    lines.push(`# Lexicon build review report — ${meta.version}`);
    lines.push('');
    lines.push(`Built ${meta.buildDate}. ${meta.wordCount} words.`);
    lines.push('');
    if (meta.missingLevels.length > 0) {
      lines.push(
        `> **Open item**: no source sheet for level(s) ${meta.missingLevels.join(', ')} in data/raw/tocfl-words.xlsx — see CLAUDE.md "Open items to verify, not assume".`,
      );
      lines.push('');
    }

    const byKind = new Map<string, ReviewNote[]>();
    for (const n of this.normalizeNotes) {
      const list = byKind.get(n.kind) ?? [];
      list.push(n);
      byKind.set(n.kind, list);
    }

    lines.push('## Row normalization');
    lines.push('');
    for (const [kind, notes] of byKind) {
      lines.push(`### ${kind} (${notes.length})`);
      lines.push('');
      for (const n of notes) {
        lines.push(`- \`${n.headwordRaw}\` / \`${n.pinyinRaw}\` — ${n.detail}`);
      }
      lines.push('');
    }

    lines.push(`## MOE reading mismatches (${this.mismatches.length})`);
    lines.push('');
    lines.push('TOCFL list pinyin vs MOE pinyin — MOE was used in the built lexicon.');
    lines.push('');
    for (const m of this.mismatches) {
      lines.push(`- \`${m.headword}\` (${m.level}): list says \`${m.tocflPinyin}\`, MOE says \`${m.moePinyin}\``);
    }
    lines.push('');

    lines.push(`## Unverified readings — not found in MOE at all (${this.unverified.length})`);
    lines.push('');
    for (const u of this.unverified) {
      lines.push(`- \`${u.headword}\` (${u.level}): ${u.reason}`);
    }
    lines.push('');

    lines.push(`## Duplicate headword+reading+POS across sheets (${this.duplicates.length})`);
    lines.push('');
    lines.push('Kept the lowest-level occurrence, dropped the rest.');
    lines.push('');
    for (const d of this.duplicates) {
      lines.push(`- \`${d.headword}\` (${d.pinyin}, ${d.pos}): kept ${d.keptLevel}, dropped duplicate at ${d.droppedLevel}`);
    }
    lines.push('');

    lines.push(`## Missing gloss (neither TOCFL list nor MOE/CC-CEDICT had one) (${this.missingGloss.length})`);
    lines.push('');
    for (const h of this.missingGloss) lines.push(`- \`${h}\``);
    lines.push('');

    if (this.other.length > 0) {
      lines.push('## Other notes');
      lines.push('');
      for (const o of this.other) lines.push(`- ${o}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}
