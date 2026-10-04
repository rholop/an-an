import { useMemo, useState } from 'react';
import { clipKey, type AudioKind, type AudioManifestEntry } from '@anan/core';
import { useProfile } from '../components/ProfileGate.js';
import { audioBase, getSlow, markClip, playUrl, stopAudio, useAudioState } from '../lib/audio.js';
import { useLexicon } from '../lib/useLexicon.js';
import './AudioReviewPage.css';

const TOP_WORDS = 500;
const SAMPLE_SENTENCES = 100;

interface ReviewItem {
  kind: AudioKind;
  id: string;
  entry: AudioManifestEntry;
}

/** Evenly spaced pick, so the sample is stable between visits and spread over the bank. */
function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]!);
}

/**
 * Phase 10 §3: the human check. Plays the 500 most frequent words and a sample
 * of 100 sentences one at a time with the zhuyin on screen; OK / Wrong are saved
 * on the server (so either profile can do this). Clips the automatic check
 * rejected come first — an OK here is what lets them play.
 */
export function AudioReviewPage() {
  const audio = useAudioState();
  const lexiconState = useLexicon();
  const { profile } = useProfile();
  const [pos, setPos] = useState(0);
  const [autoPlay, setAutoPlay] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo<ReviewItem[]>(() => {
    if (!audio.manifest || lexiconState.status !== 'ready') return [];
    const rank = (id: string) => lexiconState.lexicon.byId(id)?.freqRank ?? Number.MAX_SAFE_INTEGER;
    const words = Object.entries(audio.manifest.words)
      .map(([id, entry]) => ({ kind: 'word' as const, id, entry }))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
      .slice(0, TOP_WORDS);
    const sentences = sample(
      Object.entries(audio.manifest.sentences)
        .map(([id, entry]) => ({ kind: 'sentence' as const, id, entry }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      SAMPLE_SENTENCES,
    );
    const all = [...words, ...sentences];
    // suspect first, then everything not yet judged by a person
    const rankOf = (i: ReviewItem) => (i.entry.status === 'suspect' ? 0 : 1);
    return all.sort((a, b) => rankOf(a) - rankOf(b));
  }, [audio.manifest, lexiconState]);

  // anything a person already marked (for this exact clip) is done
  const todo = items.filter((i) => audio.marks[clipKey(i.kind, i.id)]?.hash !== i.entry.hash);
  const done = items.length - todo.length;
  const current = todo[Math.min(pos, Math.max(todo.length - 1, 0))];

  async function play(item: ReviewItem) {
    setError(null);
    try {
      await playUrl(`${audioBase()}${item.entry.file}?v=${item.entry.hash.slice(0, 10)}`, getSlow());
    } catch {
      setError("Couldn't load that clip.");
    }
  }

  async function decide(status: 'verified' | 'flagged') {
    if (!current) return;
    stopAudio();
    await markClip({
      kind: current.kind,
      id: current.id,
      hash: current.entry.hash,
      status,
      text: current.entry.text,
      profileId: profile.id,
    });
    // `todo` shrinks by one, so the next clip slides into this position
    const next = todo[pos + 1] ?? todo[pos];
    if (autoPlay && next && next !== current) void play(next);
  }

  if (!audio.manifest) return <p>No audio has been built yet. See docs/audio.md.</p>;
  if (lexiconState.status !== 'ready') return <p>Loading…</p>;

  return (
    <div className="audio-review">
      <h1>Audio review</h1>
      <p className="audio-review-meta">
        {done} of {items.length} checked · {todo.length} to go ({TOP_WORDS} most common words +{' '}
        {SAMPLE_SENTENCES} sentences)
      </p>
      {!current ? (
        <p className="audio-review-done">All checked — thank you.</p>
      ) : (
        <div className="audio-review-card" data-testid="audio-review-card">
          <div className="audio-review-kind">
            {current.kind}
            {current.entry.status === 'suspect' && (
              <span className="audio-review-suspect">
                {' '}
                · speech-to-text heard “{current.entry.heard ?? ''}”
              </span>
            )}
          </div>
          <div className="audio-review-text" lang="zh-Hant">
            {current.entry.text}
          </div>
          {current.entry.zhuyin && (
            <div className="audio-review-zhuyin" lang="zh-Hant">
              {current.entry.zhuyin}
            </div>
          )}
          <button type="button" className="audio-review-play" onClick={() => void play(current)}>
            🔊 Play
          </button>
          <div className="audio-review-actions">
            <button type="button" className="audio-review-ok" onClick={() => void decide('verified')}>
              OK
            </button>
            <button type="button" className="audio-review-wrong" onClick={() => void decide('flagged')}>
              Wrong
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
      <label className="audio-review-auto">
        <input type="checkbox" checked={autoPlay} onChange={(e) => setAutoPlay(e.target.checked)} /> Play the next
        clip automatically after OK / Wrong
      </label>
      {todo.length > 1 && (
        <button type="button" onClick={() => setPos((p) => (p + 1) % todo.length)}>
          Skip
        </button>
      )}
    </div>
  );
}
