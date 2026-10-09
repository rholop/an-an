import { useState } from 'react';
import { findClip, getSlow, playUrl, setSlow, useAudioState } from '../lib/audio.js';
import { reportClip } from '../lib/report-actions.js';
import { REPORT_LABEL } from '../lib/labels.js';
import { useProfile } from './ProfileGate.js';
import { useSetting } from '../lib/useSetting.js';
import './SpeakerButton.css';

type Props =
  | { kind: 'word'; id: string; label?: string }
  | { kind: 'sentence'; id?: string; text?: string; label?: string };

/**
 * Speaker + slow toggle + "Sounds wrong", for one word or sentence. Renders
 * nothing when there is no trusted clip (none built, suspect, flagged) or the
 * profile switched audio off. Never autoplays: it plays on tap only.
 */
export function SpeakerButton(props: Props) {
  const audio = useAudioState();
  const { profile } = useProfile();
  const [enabled, , loaded] = useSetting<boolean>('audioEnabled', true);
  const [slow, setSlowState] = useState(getSlow);
  const [failed, setFailed] = useState(false);
  const [flagged, setFlagged] = useState(false);

  const clip = findClip(audio, props);
  // A clip just reported is hidden here at once (the toast offers Undo).
  if (!loaded || !enabled || !clip || flagged) {
    return null;
  }

  async function play() {
    setFailed(false);
    try {
      await playUrl(clip!.url, slow);
    } catch {
      setFailed(true); // offline and not cached yet
    }
  }

  return (
    <span className="speaker" data-testid="speaker">
      <button
        type="button"
        className="speaker-btn"
        onClick={(e) => {
          e.stopPropagation();
          void play();
        }}
        aria-label={`Play ${props.label ?? clip.text} (P)`}
        title={`${clip.zhuyin ? `${clip.text} · ${clip.zhuyin}` : clip.text} (Play: P)`}
        data-testid="speaker-btn"
      >
        🔊
      </button>
      <button
        type="button"
        className="speaker-slow"
        aria-pressed={slow}
        title="Play slowly (0.75×)"
        onClick={(e) => {
          e.stopPropagation();
          setSlow(!slow);
          setSlowState(!slow);
        }}
      >
        slow
      </button>
      <button
        type="button"
        className="speaker-wrong"
        aria-label={`${REPORT_LABEL} with this audio`}
        title="Report this audio"
        onClick={(e) => {
          e.stopPropagation();
          setFlagged(true);
          // Phase 21: the shared report, with Undo.
          reportClip({
            kind: clip.kind,
            id: clip.id,
            hash: clip.hash,
            status: 'flagged',
            text: clip.text,
            profileId: profile.id,
          }, () => setFlagged(false));
        }}
      >
        {REPORT_LABEL}
      </button>
      {failed && <span className="speaker-note"> Not available offline yet</span>}
    </span>
  );
}
