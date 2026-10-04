// Azure's zh-TW `sapi` phoneme alphabet is Bopomofo with the tone mark written
// AFTER the syllable (ㄅㄚˋ), the neutral tone as a trailing ˙ (ㄅㄚ˙), and
// syllables separated by spaces. MOE zhuyin (what the lexicon stores) puts the
// neutral mark in FRONT (˙ㄅㄚ), so that is the one thing to move.
// Ref: learn.microsoft.com .../speech-ssml-phonetic-sets (zh-TW Bopomofo table).

const NEUTRAL = '˙';
const TONE_MARKS = 'ˊˇˋ';
const BOPOMOFO = /^[ㄅ-ㄩ]+$/;

/** "ˋ" etc. stay where they are; a leading "˙" moves to the end. Returns null
 * for anything that isn't well-formed zhuyin (so a bad reading never reaches
 * Azure as a made-up pronunciation). */
export function zhuyinToSapi(zhuyin: string): string | null {
  const syllables = zhuyin.trim().split(/\s+/).filter(Boolean);
  if (syllables.length === 0) return null;
  const out: string[] = [];
  for (const syl of syllables) {
    let body = syl;
    let neutral = false;
    if (body.startsWith(NEUTRAL)) {
      neutral = true;
      body = body.slice(1);
    }
    const last = body.at(-1) ?? '';
    const mark = TONE_MARKS.includes(last) ? last : '';
    const letters = mark ? body.slice(0, -1) : body;
    if (!BOPOMOFO.test(letters)) return null;
    if (neutral && mark) return null; // ˙ plus another tone: malformed
    out.push(`${letters}${neutral ? NEUTRAL : mark}`);
  }
  return out.join(' ');
}
