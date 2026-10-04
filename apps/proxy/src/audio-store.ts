import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AudioMarkSchema, type AudioMark } from '@anan/core';
import { z } from 'zod';

const MarksSchema = z.record(AudioMarkSchema);

/** The household's decisions about audio clips (phase 10): "OK" from the review
 * page, "Sounds wrong" from anywhere. Shared by both profiles. Marks are tied to
 * the clip's hash, so regenerating a clip retires its old flag. */
export interface AudioStore {
  marks(): Promise<Record<string, AudioMark>>;
  set(key: string, mark: AudioMark): Promise<void>;
}

export class MemoryAudioStore implements AudioStore {
  private data: Record<string, AudioMark> = {};
  async marks() {
    return { ...this.data };
  }
  async set(key: string, mark: AudioMark) {
    this.data[key] = mark;
  }
}

/** `<dir>/audio-marks.json` (+ a human-readable `audio-review.md` rewritten on
 * every change). Writes are serialised and renamed into place. */
export class FileAudioStore implements AudioStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly dir: string) {}

  private get file() {
    return path.join(this.dir, 'audio-marks.json');
  }

  async marks(): Promise<Record<string, AudioMark>> {
    try {
      return MarksSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  set(key: string, mark: AudioMark): Promise<void> {
    const run = async () => {
      const all = await this.marks();
      all[key] = mark;
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(all, null, 1));
      await rename(tmp, this.file);
      await writeFile(path.join(this.dir, 'audio-review.md'), renderFlaggedMarkdown(all));
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function renderFlaggedMarkdown(marks: Readonly<Record<string, AudioMark>>): string {
  const flagged = Object.entries(marks)
    .filter(([, m]) => m.status === 'flagged')
    .sort(([, a], [, b]) => a.at.localeCompare(b.at));
  const lines = ['# Audio flagged as wrong', ''];
  for (const [key, m] of flagged) {
    lines.push(`- ${m.kind} \`${key.split(':').slice(1).join(':')}\` “${m.text}” — flagged by ${m.by} on ${m.at}`);
  }
  if (!flagged.length) lines.push('_none_');
  return lines.join('\n') + '\n';
}
