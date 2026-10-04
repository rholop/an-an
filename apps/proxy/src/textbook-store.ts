import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Phase 12: the book's own text (dialogues, worked examples) is OCAC's — for
 * the household's personal study only. It lives in a private directory that is
 * NOT in git and is served only through the proxy, behind the household code. */
export type TextbookPrivateKind = 'dialogues' | 'examples';

export interface TextbookStore {
  /** Parsed JSON of one private file, or undefined if the book/file isn't installed. */
  get(bookId: string, kind: TextbookPrivateKind): Promise<unknown | undefined>;
}

export class MemoryTextbookStore implements TextbookStore {
  constructor(private readonly data: Record<string, unknown> = {}) {}
  async get(bookId: string, kind: TextbookPrivateKind) {
    return this.data[`${bookId}/${kind}`];
  }
}

const BOOK_ID = /^[a-z0-9-]{1,40}$/;

/** `<dir>/<bookId>/private/<kind>.json`, e.g. data/curriculum/laixue-1/private/dialogues.json. */
export class FileTextbookStore implements TextbookStore {
  constructor(private readonly curriculumDir: string) {}

  async get(bookId: string, kind: TextbookPrivateKind): Promise<unknown | undefined> {
    if (!BOOK_ID.test(bookId)) return undefined;
    const file = path.join(this.curriculumDir, bookId, 'private', `${kind}.json`);
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }
}
