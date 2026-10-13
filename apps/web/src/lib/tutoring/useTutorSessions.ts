// Phase 39: the saved tutoring classes of this profile (newest first), refreshed after Save and sync.
import { useEffect, useState } from 'react';
import { tutorClozeSentences, type Lexicon, type SentenceBankEntry } from '@anan/core';
import { db } from '../../db/instance.js';
import type { TutorSessionRow } from '../../db/schema.js';

const EVENT = 'anan:tutor-sessions-changed';

/** Tell every open screen a class was saved (or merged in). */
export function notifyTutorSessionsChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function useTutorSessions(): TutorSessionRow[] | null {
  const [rows, setRows] = useState<TutorSessionRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void db.tutorSessions
        .toArray()
        .then((all) => {
          if (!cancelled) setRows(all.sort((a, b) => b.date.localeCompare(a.date)));
        })
        .catch(() => {
          if (!cancelled) setRows([]);
        });
    load();
    window.addEventListener(EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(EVENT, load);
    };
  }, []);
  return rows;
}

/** Part D.3: every class's kept, checked sentences for Cloze ("from your class with Carl"). */
export function tutorBankSentences(rows: readonly TutorSessionRow[] | null, lexicon: Lexicon): SentenceBankEntry[] {
  return (rows ?? []).flatMap((r) => tutorClozeSentences(r, (id) => lexicon.byId(id)?.level));
}
