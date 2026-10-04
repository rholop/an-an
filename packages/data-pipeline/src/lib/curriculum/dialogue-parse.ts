export interface DialogueLine {
  speaker: string;
  zh: string;
}

const CJK = /[㐀-鿿]/;

/**
 * "1. Read aloud" block of a lesson's activities → speaker/line pairs. The
 * PDF has the speaker on its own line for some turns ("Lisa" / "：text"),
 * wraps long turns over two lines, and inserts stage directions in
 * parentheses ("（休息室xiūxí shì）"), which are dropped.
 */
export function parseDialogue(pageText: string): { lines: DialogueLine[]; dropped: string[] } {
  const i = pageText.indexOf('Read aloud');
  if (i < 0) return { lines: [], dropped: [] };
  let body = pageText.slice(i + 'Read aloud'.length);
  const stop = body.search(/Fill in the Blanks|2\.\s*Fill/);
  if (stop >= 0) body = body.slice(0, stop);
  const raw = body
    .split('\n')
    .map((l) => l.replace(/\u00a0/g, ' ').trim())
    .filter(Boolean);
  const dropped: string[] = [];
  // Re-join "Lisa" + "：text".
  const joined: string[] = [];
  for (const l of raw) {
    if (/^[：:]/.test(l) && joined.length) joined[joined.length - 1] += l;
    else joined.push(l);
  }
  const out: DialogueLine[] = [];
  for (const l of joined) {
    if (/^[（(].*[）)]$/.test(l)) {
      dropped.push(l);
      continue;
    }
    const m = l.match(/^([^\s：:]+)\s*[：:]\s*(.*)$/u);
    if (m && m[1] && !CJK.test(m[2]!.slice(0, 0))) {
      out.push({ speaker: m[1], zh: m[2]!.trim() });
    } else if (out.length && CJK.test(l)) {
      out[out.length - 1]!.zh += l;
    } else if (!/^\d+$/.test(l)) {
      dropped.push(l);
    }
  }
  return { lines: out, dropped };
}

export interface BookExample {
  zh: string;
  pinyin: string;
  en: string;
}

/** `(n) 中文 / pinyin / English` triplets from the grammar pages. */
export function parseExamples(pageText: string): BookExample[] {
  const ls = pageText
    .split('\n')
    .map((l) => l.replace(/\u00a0/g, ' ').trim())
    .filter(Boolean);
  const out: BookExample[] = [];
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i]!.match(/^\(\d{1,2}\)\s*(.+)$/u);
    if (!m || !CJK.test(m[1]!) || m[1]!.includes('①')) continue;
    const zh = m[1]!.trim();
    const pinyin = ls[i + 1] ?? '';
    if (CJK.test(pinyin) || /^\(\d/.test(pinyin)) continue;
    const en: string[] = [];
    for (let j = i + 2; j < ls.length && !CJK.test(ls[j]!) && !/^\(\d/.test(ls[j]!); j++) {
      if (/^(Exercise|Please put|\d+)$/.test(ls[j]!) || /^[AB]\s?:/.test(ls[j]!) || ls[j] === '。')
        break;
      en.push(ls[j]!);
      if (/[.?!)]$/.test(ls[j]!)) break;
    }
    out.push({ zh, pinyin, en: en.join(' ') });
  }
  return out;
}
