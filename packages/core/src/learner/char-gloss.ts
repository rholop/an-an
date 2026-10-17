/**
 * Phase 44: a character's meaning kept short enough for a tile under a review card's answer. The
 * first one or two senses (split on `;`), at most about 30 characters, without Unihan's
 * trigram/hexagram and "a phonetic" notes. The pipeline shortens the Unihan file with this before
 * it ships; the card shortens a character's own lexicon gloss with it.
 */
export const CHAR_GLOSS_MAX = 30;

// ☰–☷ trigrams, ䷀–䷿ hexagrams, and senses that only describe the character's role
const NOISE = /[☰-☷䷀-䷿]|\b(trigram|hexagram|phonetic|radical)\b/i;

export function shortCharGloss(gloss: string | undefined, max: number = CHAR_GLOSS_MAX): string {
  if (!gloss) return '';
  const senses = gloss
    .split(/[;；]/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s && !NOISE.test(s));
  const [first, second] = senses;
  if (!first) return '';
  if (second && first.length + 2 + second.length <= max) return `${first}; ${second}`;
  if (first.length <= max) return first;
  // one long sense: keep whole comma-separated parts while they fit, else cut at a word
  const parts = first.split(/\s*,\s*/);
  let out = parts[0]!;
  for (const p of parts.slice(1)) {
    if (out.length + 2 + p.length > max) break;
    out = `${out}, ${p}`;
  }
  if (out.length <= max) return out;
  const cut = out.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
