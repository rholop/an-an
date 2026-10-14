// Phase 40 D.1, `audio:build --tutor`: the tutoring classes of a profile, read from its saved copy
// on the proxy (GET /v1/sync/:profileId, household code), as the items to make clips for.
import type { TutorAudioItem } from '@anan/audio-build';
import { z } from 'zod';

const SavedTutorSessionsSchema = z.object({
  data: z
    .object({
      tutorSessions: z
        .array(
          z.object({
            id: z.string(),
            words: z.array(
              z.object({ wordId: z.string(), zh: z.string(), zhuyin: z.string().optional(), ticked: z.boolean().optional() }),
            ),
            sentences: z.array(z.object({ id: z.string(), zh: z.string(), practice: z.boolean().optional() })),
          }),
        )
        .default([]),
    })
    .passthrough()
    .nullable(),
});

/** Ticked words and practice sentences of every class of `profileId` (each once). */
export async function pullTutorItems(opts: {
  url: string;
  code: string;
  profileId: string;
  fetchFn?: typeof fetch;
}): Promise<{ sessions: number; items: TutorAudioItem[] }> {
  const res = await (opts.fetchFn ?? fetch)(`${opts.url.replace(/\/$/, '')}/v1/sync/${encodeURIComponent(opts.profileId)}`, {
    headers: { 'x-site-code': opts.code },
  });
  if (res.status === 401) throw new Error('the proxy refused the household code (set SITE_CODE or --code=)');
  if (!res.ok) throw new Error(`the proxy answered ${res.status} for ${opts.profileId}'s saved copy`);
  const sessions = SavedTutorSessionsSchema.parse(await res.json()).data?.tutorSessions ?? [];
  const items: TutorAudioItem[] = [];
  const seen = new Set<string>();
  const add = (it: TutorAudioItem) => {
    const key = `${it.kind}:${it.id}`;
    if (seen.has(key) || !it.text) return;
    seen.add(key);
    items.push(it);
  };
  for (const s of sessions) {
    for (const w of s.words)
      if (w.ticked !== false) add({ kind: 'word', id: w.wordId, text: w.zh, ...(w.zhuyin ? { zhuyin: w.zhuyin } : {}) });
    for (const x of s.sentences) if (x.practice) add({ kind: 'sentence', id: x.id, text: x.zh });
  }
  return { sessions: sessions.length, items };
}
