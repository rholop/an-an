import { useEffect, useState } from 'react';
import {
  courseOrdinal,
  LAIXUE_COURSE,
  SentenceBankFileSchema,
  type GrammarItem,
  type SentenceBankEntry,
  type Textbook,
  type TextbookFile,
} from '@anan/core';
import { authHeaders, handleUnauthorized, proxyBase } from './api.js';
import { dataUrl, onDataFilesChanged } from './data-files.js';

/** The book Phase 12 shipped; the default for "My class" and the private-text calls. */
export const TEXTBOOK_ID = 'laixue-1';

/** book.json as shipped: structure + grammar items + the book's gloss per word. */
export interface BookData extends TextbookFile {
  grammarItems: GrammarItem[];
  wordNotes: Array<{
    wordId: string;
    lesson: number;
    n: number;
    section: string;
    /** Phase 34: the printed page an extra word was found on. */
    page?: number;
    headword: string;
    pinyin: string;
    glossEn: string;
  }>;
}

/** Phase 13: the whole series. Books that were not imported are simply absent (hidden in the UI). */
export type TextbookLoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'ready'; data: BookData[]; books: Textbook[] };

/** Phase 38: the content-hashed URL of a book's file (data-manifest.json), so the book and the word
 * list always come from the same build. */
const bookFile = (id: string, file: 'book.json' | 'sentences.json') => dataUrl(`textbook/${id}/${file}`);

let cached: Promise<BookData[]> | undefined;
let booksVersion = 0;
const bookListeners = new Set<() => void>();
// Phase 38 Part A.4: a new build while the app is open replaces the books in the background.
onDataFilesChanged((changed) => {
  if (!changed.some((f) => f.startsWith('textbook/'))) return;
  cached = undefined;
  sentencesCache = undefined;
  booksVersion++;
  bookListeners.forEach((l) => l());
});

function loadBooks(): Promise<BookData[]> {
  cached ??= Promise.all(
    LAIXUE_COURSE.books.map((b) =>
      bookFile(b.id, 'book.json')
        .then((url) => fetch(url))
        .then((r) => (r.ok ? (r.json() as Promise<BookData>) : null))
        .catch(() => null),
    ),
  ).then((all) => all.filter((x): x is BookData => !!x));
  return cached;
}

/** Fetches the textbook structure once (static files with no book text). */
export function useTextbook(): TextbookLoadState {
  const [state, setState] = useState<TextbookLoadState>({ status: 'loading' });
  const [version, setVersion] = useState(booksVersion);
  useEffect(() => {
    const l = () => setVersion(booksVersion);
    bookListeners.add(l);
    return () => {
      bookListeners.delete(l);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    loadBooks().then((data) => {
      if (cancelled) return;
      setState(
        data.length > 0
          ? { status: 'ready', data, books: data.map((d) => d.textbook) }
          : { status: 'missing' },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [version]);
  return state;
}

export type TextbookSentencesState =
  { status: 'loading' } | { status: 'ready'; sentences: SentenceBankEntry[] };

let sentencesCache: Promise<SentenceBankEntry[]> | undefined;
export function loadTextbookSentences(): Promise<SentenceBankEntry[]> {
  sentencesCache ??= Promise.all(
    LAIXUE_COURSE.books.map((b) =>
      bookFile(b.id, 'sentences.json')
        .then((url) => fetch(url))
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j ? SentenceBankFileSchema.parse(j).sentences : []))
        .catch(() => [] as SentenceBankEntry[]),
    ),
  ).then((all) => all.flat());
  return sentencesCache;
}

/** Which book a textbook sentence belongs to (Phase 12 files carry no `textbookId`). */
export function sentenceBookId(s: Pick<SentenceBankEntry, 'textbookId'>): string {
  return s.textbookId ?? TEXTBOOK_ID;
}

/** Course position of a textbook sentence's lesson (undefined for non-textbook entries). */
export function sentenceOrdinal(s: SentenceBankEntry): number | undefined {
  return s.lesson === undefined ? undefined : courseOrdinal(LAIXUE_COURSE, sentenceBookId(s), s.lesson);
}

/** The generated lesson sentences of every book (tagged textbook:laixue-N / …:Lnn). */
export function useTextbookSentences(enabled = true): TextbookSentencesState {
  const [state, setState] = useState<TextbookSentencesState>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) {
      setState({ status: 'ready', sentences: [] });
      return;
    }
    let cancelled = false;
    loadTextbookSentences().then((sentences) => {
      if (!cancelled) setState({ status: 'ready', sentences });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return state;
}

export interface PrivateDialogue {
  lessonId: string;
  lines: Array<{ speaker: string; zh: string }>;
}
export interface PrivateExample {
  zh: string;
  pinyin: string;
  en: string;
}

export type PrivateResult<T> =
  { status: 'ok'; data: T } | { status: 'locked' } | { status: 'missing' } | { status: 'offline' };

/**
 * The book's own text (dialogues, worked examples). Served only by the proxy
 * and only with the household code; there is no static copy.
 */
export async function fetchPrivateTextbook<T>(
  kind: 'dialogues' | 'examples' | 'stories',
  bookId: string = TEXTBOOK_ID,
): Promise<PrivateResult<T>> {
  try {
    const res = await fetch(`${proxyBase()}/v1/textbook/${bookId}/${kind}`, {
      headers: authHeaders(),
    });
    if (res.status === 401) {
      handleUnauthorized();
      return { status: 'locked' };
    }
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'offline' };
    return { status: 'ok', data: (await res.json()) as T };
  } catch {
    return { status: 'offline' };
  }
}
