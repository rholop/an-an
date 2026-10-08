import type { GrowthStage } from '@anan/core';
import { TERM } from '../lib/labels.js';
import './PlantIcons.css';

/**
 * Phase 22: one small inline-SVG icon set for the shared terms, the same on every device (no
 * emoji): seed = New, sprout = learning, leaf = Learned, flower = Mastered, droplet = Due.
 * Icons next to their word are decorative (`aria-hidden`); pass `label` when an icon stands alone.
 */
type IconProps = { label?: string; className?: string };

function Svg({ label, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      className={`plant-icon${className ? ` ${className}` : ''}`}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const SeedIcon = (p: IconProps) => (
  <Svg {...p}>
    <ellipse className="pi-seed" cx="8" cy="9.5" rx="3.6" ry="4.6" transform="rotate(-20 8 9.5)" />
    <path className="pi-line" d="M6.4 6.8c.9 1.4 1.1 3.2.6 5" fill="none" />
  </Svg>
);

export const SproutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path className="pi-stem" d="M8 15V8" fill="none" />
    <path className="pi-leaf" d="M8 9C8 6 6 4 2.5 4.2 2.6 7.4 4.8 9.2 8 9z" />
    <path className="pi-leaf" d="M8 8c0-2.6 1.8-4.6 5.4-4.5C13.4 6.6 11.3 8.3 8 8z" />
  </Svg>
);

export const LeafIcon = (p: IconProps) => (
  <Svg {...p}>
    <path className="pi-leaf" d="M2.5 13.5C2.5 6.5 7 2.5 14 2.5c0 7-4 11-11.5 11z" />
    <path className="pi-vein" d="M3 13 10.5 5.5" fill="none" />
  </Svg>
);

export const FlowerIcon = (p: IconProps) => (
  <Svg {...p}>
    {[0, 72, 144, 216, 288].map((r) => (
      <ellipse
        key={r}
        className="pi-petal"
        cx="8"
        cy="4.6"
        rx="2.4"
        ry="3.1"
        transform={`rotate(${r} 8 8)`}
      />
    ))}
    <circle className="pi-heart" cx="8" cy="8" r="2" />
  </Svg>
);

export const DueIcon = (p: IconProps) => (
  <Svg {...p}>
    <path
      className="pi-drop"
      d="M8 1.5C8 1.5 3.2 7 3.2 10.1a4.8 4.8 0 0 0 9.6 0C12.8 7 8 1.5 8 1.5z"
    />
    <path className="pi-shine" d="M5.6 10.4a2.4 2.4 0 0 0 1.6 2.3" fill="none" />
  </Svg>
);

/** The growth stage's icon (Garden tiles and legend). */
export function StageIcon({ stage, label }: { stage: GrowthStage; label?: string }) {
  switch (stage) {
    case 'seed':
      return <SeedIcon {...(label ? { label } : {})} />;
    case 'sprout':
      return <SproutIcon {...(label ? { label } : {})} />;
    case 'plant':
      return <LeafIcon {...(label ? { label } : {})} />;
    default:
      return <FlowerIcon {...(label ? { label } : {})} />;
  }
}

/** The legend for the icon set: the five shared terms with their icons. */
export function PlantLegend({ extra }: { extra?: React.ReactNode }) {
  return (
    <p className="plant-legend" data-testid="plant-legend">
      <span>
        <SeedIcon /> {TERM.new}
      </span>
      <span>
        <SproutIcon /> learning
      </span>
      <span>
        <LeafIcon /> {TERM.learned}
      </span>
      <span>
        <FlowerIcon /> {TERM.mastered}
      </span>
      <span>
        <DueIcon /> {TERM.due}, needs water
      </span>
      {extra}
    </p>
  );
}

/** Empty states: one small line drawing of a sprout in a pot (decorative, at most 96 px). */
export function EmptySprout() {
  return (
    <svg
      className="empty-sprout"
      viewBox="0 0 64 64"
      width="72"
      height="72"
      aria-hidden="true"
      focusable="false"
    >
      <path className="es-line" d="M32 40V24" />
      <path className="es-line es-leaf" d="M32 30c0-6-4-10-11-10 0 6 4 10 11 10z" />
      <path className="es-line es-leaf" d="M32 27c0-6 4-10 11-10 0 6-4 10-11 10z" />
      <path className="es-line" d="M19 40h26l-3 16H22z" />
      <path className="es-line" d="M17 40h30" />
    </svg>
  );
}
