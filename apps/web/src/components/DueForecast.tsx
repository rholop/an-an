import { useEffect, useState } from 'react';
import { newItemAllowance } from '@anan/core';
import { db } from '../db/instance.js';
import { dueForecast } from '../db/queries.js';
import { useReviewSettings } from '../lib/review-settings.js';
import { onStudyDirty } from '../lib/study-dirty.js';
import './DueForecast.css';

/** Phase 20 (home): today, tomorrow and a 7-day bar, so a spike shows before it happens. */
export function DueForecast() {
  const [days, setDays] = useState<number[] | null>(null);
  const [tick, setTick] = useState(0);
  const { dailyCap } = useReviewSettings();
  useEffect(() => onStudyDirty(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    let cancelled = false;
    dueForecast(db, new Date(), 7)
      .then((d) => !cancelled && setDays(d))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tick]);
  if (!days) return null;
  const max = Math.max(dailyCap, ...days);
  const pause = newItemAllowance(days[0]!, 1, dailyCap);
  const label = (i: number) => (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(Date.now() + i * 86_400_000).toLocaleDateString(undefined, { weekday: 'short' }));
  return (
    <section className="due-forecast" data-testid="due-forecast" aria-label="Reviews due">
      <p>
        <strong>{days[0]}</strong> reviews due today
        {days[0]! > dailyCap ? ` (you'll see ${dailyCap}, the daily cap)` : ''} · {days[1]} tomorrow
      </p>
      {pause.paused && <p className="due-forecast-pause">New words paused until your reviews catch up.</p>}
      <ol className="due-forecast-bars">
        {days.map((n, i) => (
          <li key={i} title={`${label(i)}: ${n}`}>
            <span className={`due-forecast-bar${n > dailyCap ? ' due-forecast-bar--over' : ''}`} style={{ height: `${Math.max(2, (n / max) * 100)}%` }} />
            <span className="due-forecast-n">{n}</span>
            <span className="due-forecast-day">{label(i)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
