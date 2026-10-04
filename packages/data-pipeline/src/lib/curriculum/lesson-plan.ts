/**
 * data/curriculum/<bookId>/lesson-plan.md — one editable page per book: for
 * every lesson its topic, objectives, the scenario idea(s) with their NPC, and
 * three journal prompts. `curriculum:plan` writes a first draft from the
 * book's own lesson data; the owner skims and edits it; `curriculum:content`
 * refuses to run without it and builds from what the file says.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Textbook } from '@anan/core';

export interface PlanScenario {
  slug: string;
  idea: string;
  npcId: string;
  npcName: string;
  npcRole: string;
}
export interface PlanLesson {
  n: number;
  title: string;
  scenarios: PlanScenario[];
  prompts: string[];
}

/** Characters of the series, rotated through the draft's scenarios. */
export const SERIES_CHARACTERS = [
  { id: 'mingwen', name: '明文 (Mingwen)', role: 'a kind, friendly graduate student who helps Gloria practise' },
  { id: 'lisa', name: '麗莎 (Lisa)', role: "Gloria's sweet, warm-hearted coworker" },
  { id: 'jiawen', name: '家文 (Jiawen)', role: 'a lively, cheerful high-school student' },
  { id: 'kevin', name: '凱文 (Kevin)', role: "Gloria's easy-going coworker" },
  { id: 'jose', name: '何希 (Jose)', role: "Gloria's husband, who loves cooking and swimming" },
  { id: 'gloria', name: '莉亞 (Gloria)', role: 'an outgoing coworker who is learning Mandarin too' },
];

export function planFileHint(bookId: string): string {
  return `data/curriculum/${bookId}/lesson-plan.md`;
}

/** Draft plan from the imported book (a starting point for the owner to edit). */
export function draftPlan(book: Textbook, level: (n: number) => string): string {
  const out: string[] = [
    `# Lesson plan — ${book.titleZh} (${book.id})`,
    '',
    'Skim and edit this page; `pnpm curriculum:content` builds the chat scenarios, sentences and journal',
    'prompts from it and refuses to run if it is missing. Keep the line shapes:',
    '`- Scenario: <slug> — <idea>` followed by `- NPC: <id> — <name>, <role>`; three numbered journal prompts.',
    'Re-running `curriculum:plan` never overwrites this file.',
    '',
  ];
  for (const l of book.lessons) {
    const first = SERIES_CHARACTERS[(l.n - 1) % SERIES_CHARACTERS.length]!;
    const second = SERIES_CHARACTERS[(l.n + 2) % SERIES_CHARACTERS.length]!;
    const o = l.objectives;
    out.push(
      `## Lesson ${l.n} — ${l.titleEn}`,
      `- Level: ${level(l.n)}`,
      `- Topic: ${l.topic}`,
      `- Objectives: ${o.join('; ')}`,
      `- Scenario: ${slugOf(l.titleEn)} — ${o[0] ?? l.titleEn}`,
      `- NPC: ${first.id} — ${first.name}, ${first.role}`,
      `- Scenario: ${slugOf(o[1] ?? l.topic)} — ${o[1] ?? l.topic}`,
      `- NPC: ${second.id} — ${second.name}, ${second.role}`,
      '- Journal prompts:',
      `  1. ${o[0] ?? l.titleEn}`,
      `  2. ${o[1] ?? l.topic}`,
      `  3. ${o[2] ?? o[0] ?? l.titleEn}`,
      '',
    );
  }
  return out.join('\n');
}

function slugOf(s: string): string {
  const w = s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((x) => x && !['the', 'a', 'an', 'to', 'of', 'and', 'in', 'is', 'for', 'about', 'with'].includes(x))
    .slice(0, 3);
  return w.join('-') || 'scenario';
}

export function parsePlan(md: string): PlanLesson[] {
  const lessons: PlanLesson[] = [];
  let cur: PlanLesson | undefined;
  let pending: { slug: string; idea: string } | undefined;
  let inPrompts = false;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h = /^##\s+Lesson\s+(\d+)\s*[—-]\s*(.*)$/.exec(line);
    if (h) {
      cur = { n: Number(h[1]), title: h[2]!.trim(), scenarios: [], prompts: [] };
      lessons.push(cur);
      pending = undefined;
      inPrompts = false;
      continue;
    }
    if (!cur) continue;
    const sc = /^-\s+Scenario:\s*([a-z0-9-]+)\s*[—-]\s*(.*)$/.exec(line);
    if (sc) {
      pending = { slug: sc[1]!, idea: sc[2]!.trim() };
      inPrompts = false;
      continue;
    }
    const npc = /^-\s+NPC:\s*([a-z0-9-]+)\s*[—-]\s*(.*)$/.exec(line);
    if (npc && pending) {
      const [name, ...role] = npc[2]!.split(/,\s*/);
      cur.scenarios.push({
        ...pending,
        npcId: npc[1]!,
        npcName: (name ?? '').trim(),
        npcRole: role.join(', ').trim(),
      });
      pending = undefined;
      continue;
    }
    if (/^-\s+Journal prompts:/.test(line)) {
      inPrompts = true;
      continue;
    }
    const pr = /^\s+\d+\.\s+(.*\S)\s*$/.exec(line);
    if (inPrompts && pr) cur.prompts.push(pr[1]!);
  }
  return lessons;
}

/**
 * Reads a book's lesson plan. Generation REFUSES to run without it (Phase 13):
 * the plan is the owner's edit point, so content is never generated from a
 * plan nobody has seen.
 */
export function loadPlan(bookDir: string, bookId: string): PlanLesson[] {
  const file = path.join(bookDir, 'lesson-plan.md');
  if (!existsSync(file)) {
    throw new Error(
      `Refusing to generate ${bookId}: ${planFileHint(bookId)} does not exist. Run "pnpm curriculum:plan ${bookId}", skim and edit it, then run this again.`,
    );
  }
  return parsePlan(readFileSync(file, 'utf8'));
}
