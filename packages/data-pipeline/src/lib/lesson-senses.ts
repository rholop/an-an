import { lessonSenseId, type Word } from '@anan/core';

export interface LessonNote {
  wordId: string;
  lesson: number;
  section?: string;
  glossEn: string;
}

const norm = (g: string) => g.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Phase 25 C: a word a lesson teaches with a different meaning from the one the app shows by default
 * (its textbook sense) gets a sense of its own for that lesson (分 = minute in book 1 L9, 塊 = dollar
 * in book 2 L5), which `glossFor(word, { lesson })` picks. A grammar note only adds one when its gloss
 * is not already one of the word's senses (it was written for the lesson, not copied from the entry).
 * Returns the sense ids added.
 */
export function addLessonSenses(words: Word[], books: ReadonlyArray<{ id: string; wordNotes: readonly LessonNote[] }>): string[] {
  const byId = new Map(words.map((w) => [w.id, w]));
  const added: string[] = [];
  for (const book of books) {
    for (const note of book.wordNotes) {
      const w = byId.get(note.wordId);
      if (!w || !note.glossEn.trim()) continue;
      const senses = (w.senses ??= []);
      const shown = senses.find((s) => s.id === w.textbookSenseId)?.glossEn ?? w.glossEn;
      if (norm(shown) === norm(note.glossEn)) continue;
      if (note.section === 'grammar' && senses.some((s) => norm(s.glossEn) === norm(note.glossEn))) continue;
      const id = lessonSenseId(w.id, book.id, note.lesson);
      if (senses.some((s) => s.id === id)) continue;
      senses.push({ id, glossEn: note.glossEn, basedOn: ['textbook'] });
      added.push(id);
    }
  }
  return added;
}
