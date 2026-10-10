import { useEffect, useState } from 'react';
import { quotaResetTime, type AiUsage as AiUsageData } from '@anan/core';
import { fetchAiUsage } from '../lib/ai-quota.js';
import { AI_USAGE, STORIES_WRITTEN_TODAY } from '../lib/labels.js';
import { useReviewSettings } from '../lib/review-settings.js';

/**
 * Phase 33: Settings → AI usage. The free Gemini quota counts requests per model per day; this is
 * the server's count (`pnpm ai:quota` prints the same), so it is clear why AI features paused.
 */
export function AiUsage() {
  const { timeZone } = useReviewSettings();
  const [usage, setUsage] = useState<AiUsageData | null | undefined>(undefined);
  useEffect(() => {
    void fetchAiUsage().then(setUsage);
  }, []);
  const now = new Date();
  const at = (iso: string) => quotaResetTime(new Date(iso), now, timeZone).spoken;
  return (
    <section data-testid="settings-ai-usage">
      <h2>{AI_USAGE}</h2>
      <p className="review-settings-muted">
        Chat, journal feedback and stories use Google&apos;s free AI models. Each model allows a number of requests a day;
        when one runs out the next one answers, and when all are out AI features pause until the quota resets.
        Lessons, review and everything else always work.
      </p>
      {usage === undefined ? (
        <p>Loading…</p>
      ) : usage === null ? (
        <p className="review-settings-muted">AI usage isn&apos;t available right now.</p>
      ) : (
        <>
          <table className="ai-usage-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Used today</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {usage.models.map((m) => (
                <tr key={m.model} data-testid="ai-usage-model">
                  <td>
                    {m.model}
                    {m.roles.length > 0 && <span className="review-settings-muted"> · {m.roles.join(', ')}</span>}
                  </td>
                  <td>{m.limit !== undefined ? `${m.calls} of ${m.limit}` : m.calls}</td>
                  <td>{m.exhausted && m.resetsAt ? `Used up until about ${at(m.resetsAt)}` : 'Available'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {STORIES_WRITTEN_TODAY}: <strong data-testid="ai-usage-stories">{usage.storiesToday}</strong>
          </p>
          <p className="review-settings-muted">The free quota resets at about {at(usage.nextReset)}.</p>
        </>
      )}
    </section>
  );
}
