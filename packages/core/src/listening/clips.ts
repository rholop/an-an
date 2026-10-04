import {
  clipKey,
  effectiveStatus,
  type AudioKind,
  type AudioManifest,
  type AudioMark,
  type AudioStatus,
} from '../audio/clips.js';

/**
 * Phase 15's clip gate. Only `verified` and `auto_ok` clips are used — NOT the "suspect clips
 * play" policy of the speaker buttons. Tone exercises (tone check, tone pairs) use `verified` only.
 */
export function listeningClip(
  manifest: AudioManifest | null | undefined,
  marks: Readonly<Record<string, AudioMark>>,
  kind: AudioKind,
  id: string,
  opts: { verifiedOnly?: boolean } = {},
): { url: string; hash: string; text: string; status: AudioStatus } | null {
  const entry = (kind === 'word' ? manifest?.words : manifest?.sentences)?.[id];
  if (!entry) return null;
  const status = effectiveStatus(entry, marks[clipKey(kind, id)]);
  const ok = opts.verifiedOnly ? status === 'verified' : status === 'verified' || status === 'auto_ok';
  return ok ? { url: `${entry.file}?v=${entry.hash.slice(0, 10)}`, hash: entry.hash, text: entry.text, status } : null;
}

export type ClipLookup = (kind: AudioKind, id: string, verifiedOnly?: boolean) => boolean;

export function makeClipLookup(
  manifest: AudioManifest | null | undefined,
  marks: Readonly<Record<string, AudioMark>>,
): ClipLookup {
  return (kind, id, verifiedOnly = false) => listeningClip(manifest, marks, kind, id, { verifiedOnly }) !== null;
}
