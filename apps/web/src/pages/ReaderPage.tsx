import { useEffect, useMemo, useState } from 'react';
import { checkTaiwanness, coverage, LEVEL_IDS, type Level } from '@anan/core';
import {
  AnnotatedText,
  type AnnotatedToken,
  type AnnotationMode,
  type AnnotationScript,
} from '../components/AnnotatedText.js';
import { db, learnerService } from '../db/instance.js';
import { defineUnlisted, reportGloss, type AiDefinition } from '../lib/gloss-reports.js';
import { FakeTutorLLM } from '../lib/fake-tutor-llm.js';
import { FetchTutorLLM } from '../lib/tutor-llm.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { annotate } from '../lib/annotate.js';
import { useLexicon } from '../lib/useLexicon.js';

const SAMPLE = '我們搭捷運去便利商店，路上還遇到陳雅婷。他還沒還我錢，這件事情我做不了。';

const MODES: AnnotationMode[] = ['always', 'hover', 'off', 'tone-only'];
const SCRIPTS: AnnotationScript[] = ['pinyin', 'zhuyin', 'both'];

const LEVEL_ORDER: readonly Level[] = LEVEL_IDS;

export function ReaderPage() {
  const lexiconState = useLexicon();
  const { level: currentLevel } = useCurrentLevel();
  const [text, setText] = useState(SAMPLE);
  const [mode, setMode] = useState<AnnotationMode>('always');
  const [script, setScript] = useState<AnnotationScript>('pinyin');
  const [lookupLog, setLookupLog] = useState<string[]>([]);
  const [knownSet, setKnownSet] = useState<Set<string>>(new Set());

  useEffect(() => {
    learnerService.knownSet('review').then(setKnownSet);
  }, []);

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
      knownSet,
    );
  }, [annotated, lexiconState, knownSet]);

  if (lexiconState.status === 'loading') return <p>Loading lexicon…</p>;
  if (lexiconState.status === 'error') {
    return (
      <p>
        Failed to load lexicon: {lexiconState.error}. Run <code>pnpm pipeline:build</code> then{' '}
        <code>pnpm --filter @anan/web sync:lexicon</code>.
      </p>
    );
  }

  async function reportFromPopover(at: AnnotatedToken) {
    if (!at.word) return;
    await reportGloss(db, {
      word: at.word,
      sense: at.sense,
      shownGloss: at.gloss,
      contextSentence: text,
    });
    setLookupLog((log) => [`reported definition of ${at.token.text}`, ...log].slice(0, 20));
  }

  async function handleLookup(at: AnnotatedToken, kind: 'gloss' | 'reading') {
    const line = `${new Date().toISOString()} lookup ${kind} ${at.token.text}`;
    console.log(line);
    setLookupLog((log) => [line, ...log].slice(0, 20));

    if (!at.wordId) return; // no lexicon entry to attach evidence to
    const now = new Date();
    await learnerService.record(
      {
        item: { kind: 'word', id: at.wordId },
        skill: 'recognition',
        kind: kind === 'gloss' ? 'chat_lookup_gloss' : 'chat_hover_reading',
        at: now,
      },
      now,
    );
  }

  return (
    <div className="reader-page">
      <h1>An'an reader</h1>
      <p className="reader-meta">
        Lexicon {lexiconState.meta.version} · {lexiconState.meta.wordCount} words · built{' '}
        {lexiconState.meta.buildDate}
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
        onReportGloss={(at) => void reportFromPopover(at)}
        mode={mode}
        script={script}
        onLookup={handleLookup}
        currentLevel={currentLevel}
      />

      <UnlistedWords
        spans={annotated.filter((a) => a.token.kind === 'unknown').map((a) => a.token.text)}
        context={text}
      />

      {!taiwanness.isClean && (
        <div className="taiwanness-warnings">
          <h2>Taiwan-ness warnings</h2>
          {taiwanness.simplifiedChars.map((h, i) => (
            <div key={`s${i}`} className="warning warning--simplified">
              Simplified character <strong>{h.char}</strong> — traditional is{' '}
              <strong>{h.traditional}</strong>.
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
          <p className="coverage-known-note">
            {cov.knownCount} known / {cov.unknownCount} unknown word tokens (known = recognition
            card in review or mature)
          </p>
        </div>
      )}

      {lookupLog.length > 0 && (
        <div className="lookup-log">
          <h2>Lookup events (console + last 20, now feeding the learner model)</h2>
          <pre>{lookupLog.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}

/** Phase 7 §B5: words the lexicon doesn't know get an on-demand AI definition —
 * clearly labelled, cached, and queued for human review (never for listed words). */
function UnlistedWords({ spans, context }: { spans: string[]; context: string }) {
  const unique = [...new Set(spans)];
  const [useFake, setUseFake] = useState(false);
  const llm = useMemo(() => (useFake ? new FakeTutorLLM() : new FetchTutorLLM()), [useFake]);
  const [results, setResults] = useState<Record<string, AiDefinition | string>>({});
  if (unique.length === 0) return null;

  async function define(word: string) {
    try {
      const def = await defineUnlisted(db, llm, word, context.slice(0, 200));
      setResults((r) => ({ ...r, [word]: def }));
    } catch (err) {
      setResults((r) => ({ ...r, [word]: err instanceof Error ? err.message : String(err) }));
    }
  }

  return (
    <div className="coverage" data-testid="unlisted-words">
      <h2>Not in the dictionary</h2>
      <ul>
        {unique.map((w) => {
          const r = results[w];
          return (
            <li key={w}>
              <span lang="zh-Hant">{w}</span>{' '}
              {r === undefined ? (
                <button onClick={() => define(w)}>Define (AI)</button>
              ) : typeof r === 'string' ? (
                <span className="warning">{r}</span>
              ) : (
                <span>
                  {r.pinyin} — {r.glossEn}{' '}
                  <em className="warning-note">AI-generated, queued for review</em>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {import.meta.env.DEV && (
        <label>
          <input type="checkbox" checked={useFake} onChange={(e) => setUseFake(e.target.checked)} />{' '}
          Use fake tutor (dev)
        </label>
      )}
    </div>
  );
}
