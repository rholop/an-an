export interface LessonFront {
  titleZh: string;
  titleEn: string;
  topic: string;
  objectives: string[];
}

/** Objectives page (first page of a lesson) → title, topic, objectives. */
export function parseLessonFront(pageText: string): LessonFront {
  const ls = pageText
    .split('\n')
    .map((l) => l.replace(/\u00a0/g, ' ').trim())
    .filter(Boolean);
  const titleZh = ls[0] ?? '';
  const titleEn = ls[1] ?? '';
  const topicLine = ls.find((l) => /^Topic:/i.test(l)) ?? '';
  const topic = topicLine.replace(/^Topic:\s*/i, '').trim();
  const start = ls.findIndex((l) => /At the end of this lesson/i.test(l));
  const end = ls.findIndex((l) => /^Learning Objectives$/i.test(l));
  const body = ls.slice(start + 1, end < 0 ? undefined : end);
  const objectives: string[] = [];
  for (const l of body) {
    const m = l.match(/^\d+\.\s*(.*)$/);
    if (m) objectives.push(m[1]!.trim());
    else if (objectives.length) objectives[objectives.length - 1] += ` ${l}`;
  }
  return { titleZh, titleEn, topic, objectives: objectives.map((o) => o.replace(/\s+/g, ' ')) };
}

/** Contents pages → lesson titles (the lesson pages wrap long titles). */
export function parseToc(tocText: string): Array<{ n: number; titleZh: string; titleEn: string }> {
  const ls = tocText
    .split('\n')
    .map((l) => l.replace(/\u00a0/g, ' ').trim())
    .filter(Boolean);
  const out: Array<{ n: number; titleZh: string; titleEn: string }> = [];
  for (let i = 0; i < ls.length; i++) {
    const zh = ls[i]!.match(/^第([一二三四五六七八九十]+)課\s*(.+)$/u);
    if (!zh) continue;
    const en = (ls[i + 1] ?? '').match(/^Lesson\s+(\d+)\s+(.+?)\s*\.{3,}\s*\d+$/u);
    if (!en) continue;
    out.push({ n: Number(en[1]), titleZh: zh[2]!.trim(), titleEn: en[2]!.trim() });
  }
  return out;
}
