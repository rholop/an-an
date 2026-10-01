import { useEffect, useState } from 'react';
import { patternRecurrence, type PatternRecurrence } from '@anan/core';
import { db } from '../db/instance.js';
import { journalFlagStats } from '../lib/journal-service.js';

interface Point {
  at: Date;
  value: number;
}

/** Phase 5 §8: errors per 100 characters over time (finished entries only)
 * and the patterns that keep coming back. Plain SVG — no chart dependency. */
export function JournalProgress({ refreshKey }: { refreshKey: number }) {
  const [points, setPoints] = useState<Point[]>([]);
  const [recurring, setRecurring] = useState<PatternRecurrence[]>([]);
  const [flags, setFlags] = useState({ flagged: 0, shown: 0 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [entries, reviews, errors, flagStats] = await Promise.all([
        db.journalEntries.where('status').equals('finished').sortBy('createdAt'),
        db.journalReviews.toArray(),
        db.errorItems.toArray(),
        journalFlagStats(db),
      ]);
      if (cancelled) return;
      const byEntry = new Map(reviews.map((r) => [r.entryId, r]));
      setPoints(
        entries.flatMap((e) => {
          const value = byEntry.get(e.id)?.errorsPer100Chars;
          return value === null || value === undefined ? [] : [{ at: e.createdAt, value }];
        }),
      );
      setRecurring(patternRecurrence(errors));
      setFlags(flagStats);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (points.length === 0) {
    return (
      <section className="journal-progress">
        <h2>Your progress</h2>
        <p className="journal-muted">Finish a few entries and your error trend will appear here.</p>
      </section>
    );
  }

  const W = 320;
  const H = 120;
  const PAD = 24;
  const max = Math.max(5, ...points.map((p) => p.value));
  const x = (i: number) =>
    points.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (points.length - 1);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(' ');

  return (
    <section className="journal-progress">
      <h2>Your progress</h2>
      <figure>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Errors per 100 characters over your last ${points.length} entries`}
          className="journal-chart"
        >
          <line
            x1={PAD}
            y1={H - PAD}
            x2={W - PAD}
            y2={H - PAD}
            stroke="currentColor"
            opacity="0.3"
          />
          <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="currentColor" opacity="0.3" />
          <text x={4} y={PAD + 4} fontSize="9" fill="currentColor">
            {max.toFixed(0)}
          </text>
          <text x={10} y={H - PAD + 3} fontSize="9" fill="currentColor">
            0
          </text>
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
          {points.map((p, i) => (
            <circle key={p.at.toISOString()} cx={x(i)} cy={y(p.value)} r="3" fill="currentColor">
              <title>{`${p.at.toLocaleDateString()}: ${p.value.toFixed(1)} per 100 characters`}</title>
            </circle>
          ))}
        </svg>
        <figcaption className="journal-muted">
          Corrections per 100 characters, per finished entry (lower is better).
        </figcaption>
      </figure>

      {recurring.length > 0 && (
        <>
          <h3>Patterns that keep coming back</h3>
          <ul>
            {recurring.map((r) => (
              <li key={r.pattern}>
                <code>{r.pattern}</code> — in {r.entries} entries
              </li>
            ))}
          </ul>
        </>
      )}

      {flags.shown > 0 && (
        <p className="journal-muted" data-testid="flag-metric">
          Dev metric: {flags.flagged} of {flags.shown} corrections flagged as wrong.
        </p>
      )}
    </section>
  );
}
