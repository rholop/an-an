export interface DialogueLine {
  speaker: string;
  zh: string;
}

const CJK = /[㐀-鿿]/;
const TONE_MARK = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/;

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
    // Speakers may be written with an ideographic space inside (杜(ideographic space)翔：…).
    const m = l.match(/^([^：:，。？！、「」（）()]{1,6}?)\s*[：:]\s*(.*)$/u);
    if (m && m[1]) {
      out.push({ speaker: m[1].replace(/\s+/g, ''), zh: m[2]!.trim() });
    } else if (out.length && CJK.test(l)) {
      out[out.length - 1]!.zh += l;
    } else if (!/^\d+$/.test(l)) {
      dropped.push(l);
    }
  }
  // A lesson that is a narrative paragraph (book 2 lesson 8) has no speakers:
  // keep it as narration, one entry per paragraph (paragraphs open with (ideographic space)(ideographic space)).
  if (out.length === 0) {
    const paras: string[] = [];
    const untrimmed = body.split('\n').map((l) => l.replace(/\u00a0/g, ' ').replace(/\s+$/, ''));
    for (const l of untrimmed) {
      const t = l.trim();
      if (!CJK.test(t) || /^(\d+\.|綜合活動)/.test(t)) continue;
      if (/^\u3000\u3000/.test(l) || paras.length === 0) paras.push(t);
      else paras[paras.length - 1] += t;
    }
    if (paras.length) return { lines: paras.map((zh) => ({ speaker: '', zh })), dropped: [] };
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
    const next = ls[i + 1] ?? '';
    if (CJK.test(next) || /^\(\d/.test(next)) continue;
    // Books 2–4 print some worked examples without pinyin: the next line is then English.
    const hasPinyin = TONE_MARK.test(next) || /^[a-z'’ -]+$/.test(next);
    const pinyin = hasPinyin ? next : '';
    const en: string[] = [];
    for (let j = hasPinyin ? i + 2 : i + 1; j < ls.length && !CJK.test(ls[j]!) && !/^\(\d/.test(ls[j]!); j++) {
      if (/^(Exercise|Please put|\d+)$/.test(ls[j]!) || /^[AB]\s?:/.test(ls[j]!) || ls[j] === '。')
        break;
      en.push(ls[j]!);
      if (/[.?!)]$/.test(ls[j]!)) break;
    }
    out.push({ zh, pinyin, en: en.join(' ') });
  }
  return out;
}
