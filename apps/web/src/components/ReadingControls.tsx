import type { AnnotationMode, AnnotationScript } from './AnnotatedText.js';
import { useReadingSettings } from '../lib/reading.js';

const MODES: Array<{ id: AnnotationMode; label: string }> = [
  { id: 'always', label: 'Always' },
  { id: 'hover', label: 'On tap' },
  { id: 'off', label: 'Off' },
  { id: 'tone-only', label: 'Tone colours only' },
  { id: 'auto', label: 'Auto (fades as you learn)' },
];
const SCRIPTS: Array<{ id: AnnotationScript; label: string }> = [
  { id: 'pinyin', label: 'Pinyin' },
  { id: 'zhuyin', label: 'Zhuyin' },
  { id: 'both', label: 'Both' },
];

/**
 * Phase 21 Part I: the ONE reading setting (script + when readings show). The same control sits in
 * Settings and above the Reader; every tab reads the same stored value.
 */
export function ReadingControls({ note }: { note?: string }) {
  const { script, mode, setScript, setMode } = useReadingSettings();
  return (
    <div className="reader-controls" data-testid="reading-controls">
      <label>
        Readings:{' '}
        <select value={mode} onChange={(e) => setMode(e.target.value as AnnotationMode)} aria-label="When readings show">
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Script:{' '}
        <select value={script} onChange={(e) => setScript(e.target.value as AnnotationScript)} aria-label="Reading script">
          {SCRIPTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {note && <p className="reader-meta">{note}</p>}
    </div>
  );
}
