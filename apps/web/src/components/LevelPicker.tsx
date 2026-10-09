import { useEffect, useRef } from 'react';
import { LEVELS, levelLabel, type Level } from '@anan/core';

/** The compact level dropdown: "L2 基礎級 · A2". Options come straight from
 * levels.config, so the UI can never list a level the data doesn't have. */
export function LevelPicker({
  value,
  onChange,
  label = 'My level',
  shownLabel = label,
}: {
  value: Level;
  onChange: (level: Level) => void;
  /** Accessible name (contains the visible label). */
  label?: string;
  /** Phase 22: the header shows just "Level". */
  shownLabel?: string;
}) {
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    const handleToggle = () => {
      const el = selectRef.current;
      if (!el) return;
      el.focus();
      if ('showPicker' in el && typeof (el as unknown as { showPicker?: () => void }).showPicker === 'function') {
        try {
          (el as unknown as { showPicker: () => void }).showPicker();
        } catch {
          // ignore error if showPicker is not supported in this frame
        }
      }
    };
    window.addEventListener('anan:toggle-level', handleToggle);
    return () => window.removeEventListener('anan:toggle-level', handleToggle);
  }, []);

  return (
    <label className="level-picker" title={`${label} (Shortcut: L)`}>
      <span className="level-picker-label">{shownLabel}</span>
      <select
        ref={selectRef}
        id="level-picker-select"
        value={value}
        onChange={(e) => onChange(e.target.value as Level)}
        aria-label={label}
        data-testid="level-picker-select"
      >
        {LEVELS.map((l) => (
          <option key={l.id} value={l.id}>
            {levelLabel(l.id)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Per-screen multi-select level filter (garden, scenario map). Does NOT touch
 * the global setting. `selected` empty = show everything. */
export function LevelChips({
  selected,
  onChange,
  current,
}: {
  selected: Level[];
  onChange: (levels: Level[]) => void;
  /** Marks the learner's own level. */
  current?: Level;
}) {
  const toggle = (id: Level) =>
    onChange(selected.includes(id) ? selected.filter((l) => l !== id) : [...selected, id]);
  return (
    <div className="level-chips" role="group" aria-label="Filter by level">
      {LEVELS.map((l) => (
        <button
          key={l.id}
          type="button"
          className={`level-chip ${selected.includes(l.id) ? 'level-chip--on' : ''}`}
          aria-pressed={selected.includes(l.id)}
          title={levelLabel(l.id)}
          onClick={() => toggle(l.id)}
        >
          {l.id}
          {current === l.id && ' ★'}
        </button>
      ))}
      <button
        type="button"
        className={`level-chip ${selected.length === 0 ? 'level-chip--on' : ''}`}
        aria-pressed={selected.length === 0}
        onClick={() => onChange([])}
      >
        All
      </button>
    </div>
  );
}
