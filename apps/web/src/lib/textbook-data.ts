import { useEffect, useState } from 'react';
import {
  SentenceBankFileSchema,
  type GrammarItem,
  type SentenceBankEntry,
  type Textbook,
  type TextbookFile,
} from '@anan/core';
import { authHeaders, handleUnauthorized, proxyBase } from './api.js';

export const TEXTBOOK_ID = 'laixue-1';

/** book.json as shipped: structure + grammar items + the book's gloss per word. */
export interface BookData extends TextbookFile {
  grammarItems: GrammarItem[];
  wordNotes: Array<{
    wordId: string;
    lesson: number;
    n: number;
    section: string;
    headword: string;
    pinyin: string;
    glossEn: string;
  }>;
}

export type TextbookLoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'ready'; data: BookData; book: Textbook };

const base = () => `${import.meta.env.BASE_URL}textbook/${TEXTBOOK_ID}`;

let cached: Promise<BookData | null> | undefined;
function loadBook(): Promise<BookData | null> {
  cached ??= fetch(`${base()}/book.json`)
    .then((r) => (r.ok ? (r.json() as Promise<BookData>) : null))
    .catch(() => null);
  return cached;
}

/** Fetches the textbook structure once (a static file with no book text). */
export function useTextbook(): TextbookLoadState {
  const [state, setState] = useState<TextbookLoadState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    loadBook().then((data) => {
      if (cancelled) return;
      setState(data ? { status: 'ready', data, book: data.textbook } : { status: 'missing' });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export type TextbookSentencesState =
  { status: 'loading' } | { status: 'ready'; sentences: SentenceBankEntry[] };

let sentencesCache: Promise<SentenceBankEntry[]> | undefined;
export function loadTextbookSentences(): Promise<SentenceBankEntry[]> {
  sentencesCache ??= fetch(`${base()}/sentences.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j ? SentenceBankFileSchema.parse(j).sentences : []))
    .catch(() => []);
  return sentencesCache;
}

/** The generated lesson sentences (tagged textbook:laixue-1 / …:Lnn). */
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
  kind: 'dialogues' | 'examples',
): Promise<PrivateResult<T>> {
  try {
    const res = await fetch(`${proxyBase()}/v1/textbook/${TEXTBOOK_ID}/${kind}`, {
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
