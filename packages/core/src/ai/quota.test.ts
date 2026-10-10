import { describe, expect, it } from 'vitest';
import { nextQuotaReset, quotaDayKey, quotaResetTime, scriptQuotaStopMessage } from './quota.js';

describe('free-tier quota days (Phase 33)', () => {
  it('the day and its reset are in Pacific time', () => {
    const at = new Date('2026-10-11T06:30:00Z'); // 23:30 PDT on the 10th
    expect(quotaDayKey(at)).toBe('2026-10-10');
    expect(nextQuotaReset(at).toISOString()).toBe('2026-10-11T07:00:00.000Z');
    // winter (PST): midnight is 08:00 UTC, 3 am in New York
    const winter = new Date('2026-12-01T20:00:00Z');
    expect(nextQuotaReset(winter).toISOString()).toBe('2026-12-02T08:00:00.000Z');
    expect(quotaResetTime(nextQuotaReset(winter), winter, 'America/New_York')).toEqual({ clock: '03:00', spoken: '3 am', hours: 12 });
  });

  it('says when the quota is back, in the profile zone', () => {
    const now = new Date('2026-10-10T16:53:00Z');
    expect(quotaResetTime(new Date('2026-10-11T07:00:00Z'), now, 'America/New_York')).toEqual({ clock: '03:00', spoken: '3 am', hours: 14 });
    expect(quotaResetTime(new Date('2026-10-10T19:30:00Z'), now, 'Asia/Taipei').spoken).toBe('3:30 am');
    expect(quotaResetTime(new Date('2026-10-10T17:10:00Z'), now, 'UTC')).toEqual({ clock: '17:10', spoken: '5:10 pm', hours: 1 });
  });

  it('the script stop message', () => {
    expect(
      scriptQuotaStopMessage({ done: 300, total: 1051, unit: 'lines', resetsAt: new Date('2026-10-11T07:00:00Z'), now: new Date('2026-10-10T16:53:00Z') }),
    ).toBe(
      'Free quota used up. Checked 300 of 1,051 lines; the rest resumes from here. Quota resets at about 03:00 (in 14 h). Run the same command again then.',
    );
    expect(scriptQuotaStopMessage({ resetsAt: new Date('2026-10-11T07:00:00Z'), now: new Date('2026-10-10T16:53:00Z') })).toBe(
      'Free quota used up. Quota resets at about 03:00 (in 14 h). Run the same command again then.',
    );
  });
});
