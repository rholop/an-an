// Phase 46 Part B: the sentences a grammar exercise can come from beyond the textbook files: a
// class's own kept sentences (source 2) and the banks every point can draw on (source 3: every
// class's kept sentences and the learner's stories).
import type { PracticeSentence } from '@anan/core';
import { db } from '../db/instance.js';
import type { TutorSessionRow } from '../db/schema.js';

/** Source 2: a class's kept, checked sentences: its grammar examples first, then the rest, then the
 * ones written for its grammar points (at Save or by "Write practice"). */
export function classPracticeSentences(rec: Pick<TutorSessionRow, 'grammar' | 'sentences'>): PracticeSentence[] {
  const kept = rec.sentences.filter((s) => s.practice);
  const examples = new Set(rec.grammar.map((g) => g.example.zh));
  const own = kept.filter((s) => !s.written);
  return [...own.filter((s) => examples.has(s.zh)), ...own.filter((s) => !examples.has(s.zh)), ...kept.filter((s) => s.written)].map(
    ({ id, zh, en }) => ({ id, zh, en }),
  );
}

const SENTENCE_END = /(?<=[。！？])/u;

/** Source 3 beyond the textbook: every class's kept sentences and the sentences of saved stories
 * (no English per sentence: the exercise then shows none). */
export async function practiceBank(): Promise<PracticeSentence[]> {
  const [classes, stories] = await Promise.all([db.tutorSessions.toArray().catch(() => []), db.stories.toArray().catch(() => [])]);
  const fromClasses = classes.flatMap((c) => classPracticeSentences(c));
  const fromStories = stories.flatMap((st) =>
    st.paragraphs.flatMap((p, i) =>
      p.zh
        .split(SENTENCE_END)
        .map((zh) => zh.trim())
        .filter((zh) => zh.length >= 4)
        .map((zh, k) => ({ id: `${st.id}:p${i}:s${k}`, zh, en: '' })),
    ),
  );
  return [...fromClasses, ...fromStories];
}
