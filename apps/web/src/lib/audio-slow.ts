import { currentSession, db as sessionDb, onSessionChange } from '../db/instance.js';
import { loadSlow, onSlowChange } from './audio.js';
import { registerAfterMerge } from './profile-controller.js';

/**
 * Phase 21: slow playback is a profile setting (in the profile's settings table, so it syncs and
 * follows a profile switch); the audio module keeps a local copy for synchronous reads.
 */
export const AUDIO_SLOW_KEY = 'audioSlow';

async function pull(): Promise<void> {
  const session = currentSession();
  if (!session) return;
  try {
    const row = await session.db.settings.get(AUDIO_SLOW_KEY);
    if (currentSession() === session && typeof row?.value === 'boolean') loadSlow(row.value);
  } catch {
    /* no row yet */
  }
}

onSlowChange((slow) => {
  if (currentSession()) void sessionDb.settings.put({ key: AUDIO_SLOW_KEY, value: slow }).catch(() => undefined);
});
onSessionChange((s) => {
  if (s) void pull();
});
registerAfterMerge(() => void pull());
if (currentSession()) void pull();
