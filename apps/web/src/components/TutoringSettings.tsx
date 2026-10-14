// Phase 40: Settings → Tutoring. "Re-check levels and topics" (Part A.3, also run once on its own for
// classes saved before Phase 40) and, per tutor, "This tutor is from Taiwan" (Part B, default on).
import { useState } from 'react';
import type { Lexicon } from '@anan/core';
import { appTutoringService, NOT_FROM_TAIWAN_KEY } from '../lib/tutoring/app-service.js';
import { notifyTutorSessionsChanged, useTutorSessions } from '../lib/tutoring/useTutorSessions.js';
import { useSetting } from '../lib/useSetting.js';
import { aiErrorText } from '../lib/tutor-llm.js';
import { RECHECK_LEVELS, recheckDone, TUTOR_FROM_TAIWAN, TUTOR_FROM_TAIWAN_HINT, TUTORING } from '../lib/labels.js';

export function TutoringSettings({ lexicon }: { lexicon: Lexicon | undefined }) {
  const sessions = useTutorSessions();
  const [notFromTaiwan, setNotFromTaiwan] = useSetting<string[]>(NOT_FROM_TAIWAN_KEY, []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!sessions || sessions.length === 0) return null;
  const tutors = [...new Map(sessions.map((s) => [s.tutor.trim().toLowerCase(), s.tutor.trim()])).entries()];
  const recheck = async () => {
    if (!lexicon) return;
    setBusy(true);
    setNote(null);
    try {
      const n = await appTutoringService(lexicon).recheckLevelsAndTopics(new Date());
      notifyTutorSessionsChanged();
      setNote(recheckDone(n));
    } catch (err) {
      setNote(aiErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section data-testid="tutoring-settings">
      <h2>{TUTORING}</h2>
      <p>
        <button type="button" disabled={busy || !lexicon} onClick={() => void recheck()} data-testid="tutor-recheck">
          {RECHECK_LEVELS}
        </button>{' '}
        {note && <span role="status">{note}</span>}
      </p>
      {tutors.map(([key, name]) => (
        <label key={key} className="review-settings-row">
          <input
            type="checkbox"
            checked={!notFromTaiwan.includes(key)}
            onChange={(e) =>
              setNotFromTaiwan(e.target.checked ? notFromTaiwan.filter((k) => k !== key) : [...notFromTaiwan, key])
            }
          />{' '}
          {name}: {TUTOR_FROM_TAIWAN}
        </label>
      ))}
      <p className="review-settings-muted">{TUTOR_FROM_TAIWAN_HINT}</p>
    </section>
  );
}
