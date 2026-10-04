import { z } from 'zod';

// Phase 10: the audio manifest and the one rule that matters — only `verified`
// and `auto_ok` clips are ever played.

export const AUDIO_STATUSES = ['verified', 'auto_ok', 'suspect', 'flagged'] as const;
export const AudioStatusSchema = z.enum(AUDIO_STATUSES);
export type AudioStatus = z.infer<typeof AudioStatusSchema>;

export const AudioKindSchema = z.enum(['word', 'sentence']);
export type AudioKind = z.infer<typeof AudioKindSchema>;

export const AudioManifestEntrySchema = z.object({
  /** Path under the audio root, e.g. "words/tocfl-3f9a2c.mp3". */
  file: z.string(),
  voice: z.string(),
  /** sha256 of the exact SSML sent (hex). Also the cache-buster and the key
   * server-side marks are tied to. */
  hash: z.string(),
  /** Only ever `auto_ok` or `suspect` here; human marks live on the server. */
  status: AudioStatusSchema,
  /** The text that was spoken, for the review page and reports. */
  text: z.string(),
  zhuyin: z.string().optional(),
  /** What speech-to-text heard, kept for suspect clips so the report can show it. */
  heard: z.string().optional(),
  /** Regenerated after a flag with a different voice/SSML: a plain rebuild leaves it alone. */
  fixed: z.boolean().optional(),
});
export type AudioManifestEntry = z.infer<typeof AudioManifestEntrySchema>;

export const AudioManifestSchema = z.object({
  meta: z.object({ version: z.literal(1), builtAt: z.string(), voice: z.string() }),
  words: z.record(AudioManifestEntrySchema),
  sentences: z.record(AudioManifestEntrySchema),
});
export type AudioManifest = z.infer<typeof AudioManifestSchema>;

/** A human decision kept on the server, tied to the clip version it was about. */
export const AudioMarkSchema = z.object({
  status: z.enum(['verified', 'flagged']),
  hash: z.string(),
  by: z.string(),
  at: z.string(),
  kind: AudioKindSchema,
  text: z.string(),
});
export type AudioMark = z.infer<typeof AudioMarkSchema>;

export const clipKey = (kind: AudioKind, id: string): string => `${kind}:${id}`;

/**
 * The status that counts. A server mark wins only if it was made about this
 * exact clip (same hash): once a flagged clip is regenerated its hash changes,
 * the old flag no longer applies, and the new clip is back to `auto_ok`.
 */
export function effectiveStatus(
  entry: Pick<AudioManifestEntry, 'status' | 'hash'>,
  mark?: Pick<AudioMark, 'status' | 'hash'>,
): AudioStatus {
  if (mark && mark.hash === entry.hash) {
    // A human decision about this exact clip beats the automatic check (that
    // is the point of review): "OK" can rescue a suspect clip, "flagged" hides any.
    return mark.status;
  }
  return entry.status;
}

export const isPlayableStatus = (s: AudioStatus): boolean => s === 'verified' || s === 'auto_ok';

/** The file to play for this clip, or null — the only gate the player uses. */
export function playableClip(
  manifest: AudioManifest | null | undefined,
  marks: Readonly<Record<string, AudioMark>>,
  kind: AudioKind,
  id: string,
): { url: string; entry: AudioManifestEntry; status: AudioStatus } | null {
  const entry = (kind === 'word' ? manifest?.words : manifest?.sentences)?.[id];
  if (!entry) return null;
  const status = effectiveStatus(entry, marks[clipKey(kind, id)]);
  if (!isPlayableStatus(status)) return null;
  return { url: `${entry.file}?v=${entry.hash.slice(0, 10)}`, entry, status };
}
