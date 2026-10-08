import { useState } from 'react';
import { learnedMasteredLine, pct, PROGRESS_INFO, TERM } from '../lib/labels.js';
import { LeafIcon } from './PlantIcons.js';
import './LearnedMastered.css';

/**
 * Phase 21 Part C: the ONE progress display for a lesson or level, everywhere (Home, Textbook,
 * Garden, Progress, Chat, Placement, level-up prompt): "Learned X% · Mastered Y%" with two bars and
 * a one-line info tap. The numbers always come from core's `ProgressIndex.summarize`.
 */
export function LearnedMastered({
  p,
  compact = false,
  testId,
}: {
  p: { learnedShare: number; masteredShare: number; leeches?: number; imported?: number };
  compact?: boolean;
  testId?: string;
}) {
  const [info, setInfo] = useState(false);
  return (
    <div className={`lm${compact ? ' lm--compact' : ''}`} data-testid={testId ?? 'learned-mastered'}>
      <div className="lm-bars" aria-hidden="true">
        {/* Phase 22: a stem: Learned and Mastered are two shades of one bar, a leaf at the growing end */}
        <div className="lm-bar" title={`${TERM.learned} ${pct(p.learnedShare)}`}>
          <span className="lm-bar-learned" style={{ width: pct(p.learnedShare) }} />
          <span className="lm-bar-mastered" style={{ width: pct(p.masteredShare) }} />
        </div>
        {p.learnedShare > 0 && (
          <span className="lm-leaf" style={{ left: `clamp(0px, calc(${pct(p.learnedShare)} - 6px), calc(100% - 12px))` }}>
            <LeafIcon />
          </span>
        )}
      </div>
      <span className="lm-line">
        {learnedMasteredLine(p)}
        {p.leeches ? <span className="lm-leech" title="Tricky words count as Learned but never Mastered"> · {p.leeches} tricky</span> : null}
        {p.imported ? <span className="lm-imported"> · {p.imported} {TERM.imported.toLowerCase()}</span> : null}
        <button
          type="button"
          className="lm-info"
          aria-label="What do Learned and Mastered mean?"
          aria-expanded={info}
          onClick={() => setInfo((v) => !v)}
        >
          ⓘ
        </button>
      </span>
      {info && <p className="lm-info-text">{PROGRESS_INFO}</p>}
    </div>
  );
}
