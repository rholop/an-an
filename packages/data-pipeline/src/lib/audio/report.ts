import type { AudioManifest, AudioMark } from '@anan/core';
import type { SkippedClip } from './inputs.js';

/** data/build/audio-review.md: everything a person should look at. */
export function renderReviewReport(
  manifest: AudioManifest,
  skipped: readonly SkippedClip[],
  marks: Readonly<Record<string, AudioMark>> = {},
): string {
  const lines: string[] = ['# Audio review', '', `Voice: ${manifest.meta.voice} · built ${manifest.meta.builtAt}`, ''];
  const all = [
    ...Object.entries(manifest.words).map(([id, e]) => ['word', id, e] as const),
    ...Object.entries(manifest.sentences).map(([id, e]) => ['sentence', id, e] as const),
  ];

  const flagged = Object.entries(marks).filter(([, m]) => m.status === 'flagged');
  lines.push(`## Flagged by a person (${flagged.length})`, '');
  for (const [key, m] of flagged) lines.push(`- ${m.kind} \`${key.split(':')[1]}\` “${m.text}” — flagged by ${m.by} on ${m.at}`);
  if (!flagged.length) lines.push('_none_');

  const suspect = all.filter(([, , e]) => e.status === 'suspect');
  lines.push('', `## Suspect: speech-to-text disagreed (${suspect.length})`, '', 'The app currently plays these anyway (ALLOW_SUSPECT_AUDIO); mark them OK / Wrong on the review page.', '');
  const heardList = (e: (typeof all)[number][2]) =>
    (e.fixAttempts ?? []).map((a) => `${a.attempt}: “${a.heard}”`).join('; ');
  for (const [kind, id, e] of suspect) {
    const tried = e.fixTried ? ` · --fix-suspect tried ${e.fixTried.slice(0, 10)}, still suspect (${heardList(e) || 'no other reading to try'})` : '';
    lines.push(`- ${kind} \`${id}\` “${e.text}”${e.zhuyin ? ` (${e.zhuyin})` : ''} — heard “${e.heard ?? ''}”${tried}`);
  }
  if (!suspect.length) lines.push('_none_');

  const fixedSuspects = all.filter(([, , e]) => e.fixed && e.suspectHeard !== undefined);
  lines.push('', `## Suspects fixed by --fix-suspect (${fixedSuspects.length})`, '', 'Re-made clips that now pass the automatic check; listen to them on the review page.', '');
  for (const [kind, id, e] of fixedSuspects) {
    lines.push(`- ${kind} \`${id}\` “${e.text}”${e.zhuyin ? ` (${e.zhuyin})` : ''} — fixed by ${e.fixedBy ?? 'a retry'} (was heard “${e.suspectHeard}”; ${heardList(e)})`);
  }
  if (!fixedSuspects.length) lines.push('_none_');

  lines.push('', `## Skipped: no clip made (${skipped.length})`, '');
  for (const s of skipped) lines.push(`- ${s.kind} \`${s.id}\` “${s.text}” — ${s.reason}`);
  if (!skipped.length) lines.push('_none_');
  return lines.join('\n') + '\n';
}
