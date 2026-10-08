import './Celebrations.css';

/**
 * Phase 22: the only two celebrations. Both are decorative (`aria-hidden`), short (under 400 ms
 * and 600 ms), never block input (`pointer-events: none`) and are off under
 * `prefers-reduced-motion` (theme.css). `pulse` changes on each correct answer to replay.
 */

/** Water all: a small plant at the top of the session; a watering can tips over it on each correct answer. */
export function MiniPlant({ pulse, grown }: { pulse: number; grown: number }) {
  // the plant grows a leaf pair every few answers (at most four), so progress is visible
  const leaves = Math.min(4, 1 + Math.floor(grown / 3));
  return (
    <div className="mini-plant" aria-hidden="true" data-testid="mini-plant">
      <svg viewBox="0 0 120 64" width="120" height="64" focusable="false">
        <g key={pulse} className={pulse > 0 ? 'mp-can mp-can--pour' : 'mp-can'}>
          <path className="mp-can-body" d="M70 14h22l-2 16H72z" />
          <path className="mp-can-spout" d="M70 18 58 10" />
          <path className="mp-can-handle" d="M92 16c6 0 6 10 0 10" />
          <g className="mp-drops">
            <circle cx="55" cy="16" r="1.6" />
            <circle cx="52" cy="22" r="1.6" />
            <circle cx="57" cy="25" r="1.6" />
          </g>
        </g>
        <path className="mp-pot" d="M38 50h24l-3 12H41z" />
        <path className="mp-stem" d="M50 50V30" />
        {Array.from({ length: leaves }, (_, i) => (
          <g
            key={i}
            className={i === leaves - 1 && pulse > 0 ? 'mp-leaf mp-leaf--new' : 'mp-leaf'}
            transform={`translate(0 ${-i * 5})`}
          >
            <path d="M50 46c0-5-4-8-9-8 0 5 4 8 9 8z" />
            <path d="M50 44c0-5 4-8 9-8 0 5-4 8-9 8z" />
          </g>
        ))}
      </svg>
    </div>
  );
}

/** A lesson Mastered: a short petal burst, once. */
export function PetalBurst() {
  return (
    <span className="petal-burst" aria-hidden="true" data-testid="petal-burst">
      {Array.from({ length: 8 }, (_, i) => (
        <span key={i} className="petal" style={{ ['--a' as string]: `${i * 45}deg` }} />
      ))}
    </span>
  );
}
