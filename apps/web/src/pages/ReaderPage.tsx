import { useMemo, useState } from 'react';
import { checkTaiwanness, coverage, type Level } from '@anan/core';
import { AnnotatedText, type AnnotationMode, type AnnotationScript } from '../components/AnnotatedText.js';
import { annotate } from '../lib/annotate.js';
import { useLexicon } from '../lib/useLexicon.js';

const SAMPLE = '我們搭捷運去便利商店，路上還遇到陳雅婷。他還沒還我錢，這件事情我做不了。';

const MODES: AnnotationMode[] = ['always', 'hover', 'off', 'tone-only'];
const SCRIPTS: AnnotationScript[] = ['pinyin', 'zhuyin', 'both'];

const LEVEL_ORDER: Level[] = ['N1', 'N2', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'];

export function ReaderPage() {
  const lexiconState = useLexicon();
  const [text, setText] = useState(SAMPLE);
  const [mode, setMode] = useState<AnnotationMode>('always');
  const [script, setScript] = useState<AnnotationScript>('pinyin');
  const [lookupLog, setLookupLog] = useState<string[]>([]);

  const annotated = useMemo(() => {
    if (lexiconState.status !== 'ready') return [];
    return annotate(text, lexiconState.lexicon);
  }, [text, lexiconState]);

  const taiwanness = useMemo(() => checkTaiwanness(text), [text]);

  const cov = useMemo(() => {
    if (lexiconState.status !== 'ready') return null;
    return coverage(
      annotated.map((a) => a.token),
      lexiconState.lexicon,
      new Set(), // Phase 1 has no learner model yet (Phase 2)
    );
  }, [annotated, lexiconState]);

  if (lexiconState.status === 'loading') return <p>Loading lexicon…</p>;
  if (lexiconState.status === 'error') {
    return (
      <p>
        Failed to load lexicon: {lexiconState.error}. Run <code>pnpm pipeline:build</code> then{' '}
        <code>pnpm --filter @anan/web sync:lexicon</code>.
      </p>
    );
  }

  return (
    <div className="reader-page">
      <h1>An'an reader</h1>
      <p className="reader-meta">
        Lexicon {lexiconState.meta.version} · {lexiconState.meta.wordCount} words · built {lexiconState.meta.buildDate}
      </p>

      <textarea
        className="reader-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Paste traditional Chinese text…"
      />

      <div className="reader-controls">
        <label>
          Mode:{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as AnnotationMode)}>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          Script:{' '}
          <select value={script} onChange={(e) => setScript(e.target.value as AnnotationScript)}>
            {SCRIPTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <AnnotatedText
        tokens={annotated}
        mode={mode}
        script={script}
        onLookup={(id, kind) => {
          const line = `${new Date().toISOString()} lookup ${kind} ${id}`;
          console.log(line);
          setLookupLog((log) => [line, ...log].slice(0, 20));
        }}
      />

      {!taiwanness.isClean && (
        <div className="taiwanness-warnings">
          <h2>Taiwan-ness warnings</h2>
          {taiwanness.simplifiedChars.map((h, i) => (
            <div key={`s${i}`} className="warning warning--simplified">
              Simplified character <strong>{h.char}</strong> — traditional is <strong>{h.traditional}</strong>.
            </div>
          ))}
          {taiwanness.mainlandTerms.map((h, i) => (
            <div key={`m${i}`} className="warning warning--mainland">
              Mainland term <strong>{h.matched}</strong> — Taiwan uses <strong>{h.taiwan}</strong>.
              {h.note && <span className="warning-note"> {h.note}</span>}
            </div>
          ))}
        </div>
      )}

      {cov && (
        <div className="coverage">
          <h2>Level coverage</h2>
          <ul>
            {LEVEL_ORDER.filter((lvl) => cov.byLevel[lvl]).map((lvl) => (
              <li key={lvl}>
                {lvl}: {cov.byLevel[lvl]}
              </li>
            ))}
            {cov.byLevel.unleveled && <li>unleveled: {cov.byLevel.unleveled}</li>}
          </ul>
        </div>
      )}

      {lookupLog.length > 0 && (
        <div className="lookup-log">
          <h2>Lookup events (console + last 20)</h2>
          <pre>{lookupLog.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}
