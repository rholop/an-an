import type { Word } from '@anan/core';
import { LEVEL_IDS } from '@anan/core';

const VERB_POS = /^V/;
const isToGloss = (g: string) => /^to\s/i.test(g);
const PARTICLE_GLOSS = /particle|marker|^used (to|after|before)|^\(used (to|after|before)|^\(after /i;

/** Senses never worth promoting to primary (names, classical, cross-references). */
const JUNK_SENSE = /hexagram|^surname|^used in the same way|variant of|^see |I Ching/i;

const levelRank = (w: Pick<Word, 'level'>) => (w.level ? LEVEL_IDS.indexOf(w.level) : Infinity);

/** Does a gloss look like the kind of thing this TOCFL POS expects? Only the
 * clear mismatches count: a "to ..." verb gloss on a non-verb, or a plain
 * gloss on a particle. Everything else is left alone. */
export function fitsPos(gloss: string, pos: string[]): boolean {
  if (pos.length === 0) return true;
  if (pos.includes('Ptc')) return PARTICLE_GLOSS.test(gloss);
  const verby = pos.some((p) => VERB_POS.test(p) && p !== 'Vs');
  if (verby) return true; // verbs: noun-ish glosses are common and fine (e.g. 約會)
  return !isToGloss(gloss);
}

export interface SiblingFix {
  wordId: string;
  headword: string;
  from: string;
  to: string | null; // null = no usable alternative, left as-is
}

/**
 * TOCFL lists one headword several times when it has different POS (去 V at
 * N1, 去 Ptc and Adv at L3). The gloss resolver sees each entry on its own,
 * and all of them compete for the same top candidate, so 去 Ptc and 去 Adv both
 * came out as "to go; to remove". Siblings share headword + reading; the
 * lowest-level sibling keeps its primary. A later sibling is only changed
 * when its primary duplicates an earlier sibling's AND doesn't fit its own
 * POS (a "to go" gloss on a particle); it then promotes its best distinct
 * sense that does fit. Same-meaning siblings (碗 N "bowl" / M "bowl") are left
 * alone. Hand overrides are never touched.
 * Mutates `words`; returns what changed so the build can flag it for review.
 */
export function diversifySiblingGlosses(words: Word[]): SiblingFix[] {
  const groups = new Map<string, Word[]>();
  for (const w of words) {
    if (w.source !== 'tocfl' || !w.senses?.length) continue;
    const key = `${w.headword}|${w.pinyin}`;
    const g = groups.get(key);
    if (g) g.push(w);
    else groups.set(key, [w]);
  }

  const fixes: SiblingFix[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => levelRank(a) - levelRank(b) || a.id.localeCompare(b.id));
    const taken = new Set<string>([group[0]!.glossEn.toLowerCase()]);
    for (const w of group.slice(1)) {
      const primary = w.glossEn.toLowerCase();
      if (!taken.has(primary) || fitsPos(w.glossEn, w.pos) || w.tags.includes('gloss:override')) {
        taken.add(primary);
        continue;
      }
      const alternatives = w.senses!.slice(1).filter((s) => !taken.has(s.glossEn.toLowerCase()));
      const pick = alternatives.find((s) => fitsPos(s.glossEn, w.pos) && !JUNK_SENSE.test(s.glossEn));
      if (!pick) {
        fixes.push({ wordId: w.id, headword: w.headword, from: w.glossEn, to: null });
        continue;
      }
      w.senses = [pick, ...w.senses!.filter((s) => s !== pick)];
      fixes.push({ wordId: w.id, headword: w.headword, from: w.glossEn, to: pick.glossEn });
      w.glossEn = pick.glossEn;
      w.primarySenseId = pick.id;
      w.glossSources = pick.basedOn;
      w.tags.push('gloss:sibling-diversified');
      taken.add(pick.glossEn.toLowerCase());
    }
  }
  return fixes;
}
