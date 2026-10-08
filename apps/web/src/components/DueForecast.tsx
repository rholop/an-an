import type { LoadedReviewStatus } from '../lib/review-status.js';
import {
  ALL_WATERED,
  COME_BACK_TOMORROW,
  dueNowLine,
  FORECAST_REST_OF_TODAY,
  laterTodayLine,
  REVIEW_EARLY,
  reviewAllLabel,
  waterAllLabel,
} from '../lib/labels.js';
import { DueIcon } from './PlantIcons.js';
import './DueForecast.css';

/**
 * Phase 22 Part B: Home's two buttons, "💧 Water all (N)" and "Review all (N)". Their counts come
 * from the one review status, so they are exactly the sessions they open. With nothing due now
 * they become one quiet line (and "Review early" when cards are coming later today).
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
  if (s.dueNow === 0) {
    return (
      <p className="home-actions-quiet" data-testid="home-actions-quiet">
        {s.laterToday > 0 ? (
          <>
            {ALL_WATERED} · {laterTodayLine(s.laterToday, s.nextDueAt)}{' '}
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
          COME_BACK_TOMORROW
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

/** Phase 20/22 (Home): due now, later today, the new-word line, and a 7-day bar whose first bar
 * is the rest of today (cards due now have their own number, never a bar). */
export function DueForecast({
  loaded,
  dailyCap,
}: {
  loaded: LoadedReviewStatus | null;
  dailyCap: number;
}) {
  if (!loaded) return null;
  const { status: s, forecast: days } = loaded;
  const max = Math.max(1, ...days);
  const label = (i: number) =>
    i === 0
      ? FORECAST_REST_OF_TODAY
      : i === 1
        ? 'Tomorrow'
        : new Date(Date.now() + i * 86_400_000).toLocaleDateString(undefined, { weekday: 'short' });
  return (
    <section className="due-forecast" data-testid="due-forecast" aria-label="Reviews due">
      <p className="due-forecast-now" data-testid="home-review-status">
        <DueIcon /> <strong>{dueNowLine(s)}</strong>
        {s.dueNow > s.capLeft && s.capLeft > 0
          ? ` (you'll see ${s.capLeft} today, the daily cap)`
          : ''}
      </p>
      {s.newMessage && (
        <p className="due-forecast-pause" data-testid="home-new-state">
          {s.newMessage}
        </p>
      )}
      <ol className="due-forecast-bars">
        {days.map((n, i) => (
          <li key={i} title={`${label(i)}: ${n}`}>
            <span
              className={`due-forecast-bar${n > dailyCap ? ' due-forecast-bar--over' : ''}`}
              style={{ height: `${Math.max(2, (n / max) * 100)}%` }}
            />
            <span className="due-forecast-n">{n}</span>
            <span className="due-forecast-day">{label(i)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
