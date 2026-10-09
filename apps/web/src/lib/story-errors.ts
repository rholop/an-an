import { AI_QUOTA_USED, STORY_UNAVAILABLE, storyReasonsLine } from './labels.js';
import { StoryUnavailableError } from './story-service.js';
import { isQuotaError } from './tutor-llm.js';

/** Phase 25: what to say when a story could not be written: the quota, or why the checker refused it. */
export function storyErrorText(err: unknown): string {
  if (isQuotaError(err)) return AI_QUOTA_USED;
  if (err instanceof StoryUnavailableError) {
    console.warn('Story not shown:', err.reasons);
    const why = storyReasonsLine(err.reasons);
    return why ? `${STORY_UNAVAILABLE} ${why}` : STORY_UNAVAILABLE;
  }
  console.warn('Story request failed:', err);
  return STORY_UNAVAILABLE;
}
