import type { LoadedReviewStatus } from '../lib/review-status.js';
import {
  ALL_WATERED,
  forecastDayLabel,
  nextSessionLine,
  NOTHING_NEXT_SESSION,
  REVIEW_EARLY,
  reviewAllLabel,
  SESSION_NAME,
  sessionLine,
  waterAllLabel,
} from '../lib/labels.js';
import { todayIn } from '@anan/core';
import { DueIcon } from './PlantIcons.js';
import './DueForecast.css';

/**
 * Phase 22 Part B: Home's two buttons, "💧 Water all (N)" and "Review all (N)". Their counts come
 * from the one review status, so they are exactly the sessions they open. Phase 23: they work on
 * this review session's cards; between sessions (or with the session done) they become one quiet
 * line saying when the next session opens, with "Review early" to start it now.
 */
export function HomeReviewActions({
  loaded,
  onWaterAll,
  onReviewAll,
  onReviewEarly,
}: {
  loaded: LoadedReviewStatus | null;
  onWaterAll: () => void;
  onReviewAll: () => void;
  onReviewEarly: () => void;
}) {
  if (!loaded) return <div className="home-actions home-actions--loading" aria-busy="true" />;
  const s = loaded.status;
  if (s.sessionCards === 0) {
    const next = s.nextSession;
    return (
      <p className="home-actions-quiet" data-testid="home-actions-quiet">
        {next.count > 0 ? (
          <>
            {s.session === 'between' ? sessionLine(s) : `${ALL_WATERED} · ${nextSessionLine(next, s.timeZone)}`}{' '}
            <button
              type="button"
              className="link-button"
              onClick={onReviewEarly}
              data-testid="review-early"
            >
              {REVIEW_EARLY}
            </button>
          </>
        ) : (
          NOTHING_NEXT_SESSION
        )}
      </p>
    );
  }
  return (
    <div className="home-actions" data-testid="home-actions">
      <button
        type="button"
        className="btn-water home-action"
        onClick={onWaterAll}
        data-testid="water-all-btn"
      >
        {waterAllLabel(s.thirstyWords)}
      </button>
      <button
        type="button"
        className="btn-primary home-action"
        onClick={onReviewAll}
        disabled={s.reviewAll === 0}
        data-testid="review-all-btn"
      >
        {reviewAllLabel(s.reviewAll)}
      </button>
    </div>
  );
}

/** Phase 20/22/23 (Home): this review session (or when the next opens), the new-word line, and a
 * 7-day forecast with two bars a day, morning and evening. */
export function DueForecast({ loaded }: { loaded: LoadedReviewStatus | null }) {
  if (!loaded) return null;
  const { status: s, forecast: days, settings } = loaded;
  const max = Math.max(1, ...days.flatMap((d) => [d.morning, d.evening]));
  const today = todayIn(new Date(), settings);
  const cap = s.cap;
  return (
    <section className="due-forecast" data-testid="due-forecast" aria-label="Reviews due">
      <p className="due-forecast-now" data-testid="home-review-status">
        <DueIcon /> <strong>{sessionLine(s)}</strong>
        {s.sessionCards > s.capLeft && s.capLeft > 0
          ? ` (you'll see ${s.capLeft} this session, the session cap)`
          : ''}
      </p>
      {s.newMessage && (
        <p className="due-forecast-pause" data-testid="home-new-state">
          {s.newMessage}
        </p>
      )}
      <ol className="due-forecast-bars">
        {days.map((d) => {
          const label = forecastDayLabel(d.day, today);
          return (
            <li key={d.day} title={`${label}: ${SESSION_NAME.morning.toLowerCase()} ${d.morning}, ${SESSION_NAME.evening.toLowerCase()} ${d.evening}`}>
              <span className="due-forecast-pair">
                {(['morning', 'evening'] as const).map((k) => (
                  <span
                    key={k}
                    data-testid={`forecast-${k}`}
                    className={`due-forecast-bar due-forecast-bar--${k}${d[k] > cap ? ' due-forecast-bar--over' : ''}`}
                    style={{ height: `${Math.max(2, (d[k] / max) * 100)}%` }}
                  />
                ))}
              </span>
              <span className="due-forecast-n">
                {d.morning}·{d.evening}
              </span>
              <span className="due-forecast-day">{label}</span>
            </li>
          );
        })}
      </ol>
      <p className="due-forecast-key">
        <span className="due-forecast-swatch due-forecast-bar--morning" /> morning{' '}
        <span className="due-forecast-swatch due-forecast-bar--evening" /> evening
      </p>
    </section>
  );
}
