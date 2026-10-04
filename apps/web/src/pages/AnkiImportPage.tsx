import { useMemo, useState } from 'react';
import {
  buildCustomWord,
  matchAnkiRows,
  parseDelimitedText,
  summarizeAnkiMatch,
  type AnkiMatchResult,
  type Evidence,
} from '@anan/core';
import { db, learnerService } from '../db/instance.js';
import { useLexicon } from '../lib/useLexicon.js';
import './AnkiImportPage.css';

const NO_COLUMN = -1;

export function AnkiImportPage() {
  const lexiconState = useLexicon();
  const [rows, setRows] = useState<string[][]>([]);
  const [headwordCol, setHeadwordCol] = useState(NO_COLUMN);
  const [pinyinCol, setPinyinCol] = useState(NO_COLUMN);
  const [glossCol, setGlossCol] = useState(NO_COLUMN);
  const [status, setStatus] = useState<'idle' | 'importing' | 'done'>('idle');
  const [doneMessage, setDoneMessage] = useState('');

  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0);

  const results: AnkiMatchResult[] =
    useMemo(() => {
      if (lexiconState.status !== 'ready' || headwordCol === NO_COLUMN || rows.length === 0) return [];
      return matchAnkiRows(rows, headwordCol, lexiconState.lexicon);
    }, [rows, headwordCol, lexiconState]);

  const summary = useMemo(() => summarizeAnkiMatch(results), [results]);

  async function onFile(file: File) {
    const text = await file.text();
    setRows(parseDelimitedText(text));
    setHeadwordCol(NO_COLUMN);
    setStatus('idle');
  }

  async function importMatched() {
    setStatus('importing');
    const now = new Date();
    const events: Evidence[] = results
      .filter((r) => r.status === 'matched' || r.status === 'ambiguous')
      .map((r) => ({ item: { kind: 'word', id: r.word!.id }, skill: 'recognition', kind: 'anki_import_seen', at: now }));
    await learnerService.recordBulk(events, now);
    setDoneMessage(`Imported ${events.length} matched/ambiguous words.`);
    setStatus('done');
  }

  async function addUnmatchedAsCustom() {
    setStatus('importing');
    const now = new Date();
    const unmatched = results.filter((r) => r.status === 'unmatched' && r.headword);
    const customWords = unmatched.map((r) =>
      buildCustomWord(
        r.headword,
        pinyinCol !== NO_COLUMN ? (r.row[pinyinCol] ?? '') : '',
        glossCol !== NO_COLUMN ? (r.row[glossCol] ?? '') : '',
      ),
    );
    await db.customWords.bulkPut(customWords);
    const events: Evidence[] = customWords.map((w) => ({
      item: { kind: 'word', id: w.id },
      skill: 'recognition',
      kind: 'anki_import_seen',
      at: now,
    }));
    await learnerService.recordBulk(events, now);
    setDoneMessage(`Added ${customWords.length} unmatched words as custom entries.`);
    setStatus('done');
  }

  if (lexiconState.status === 'loading') return <p>Loading…</p>;
  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;

  return (
    <div className="anki-import-page">
      <h1>Anki import</h1>
      <p className="anki-import-note">
        Export your deck from Anki as "Notes in Plain Text" (tsv/csv). <code>.apkg</code> import isn't supported
        yet — export from Anki as plain text first.
      </p>

      <input
        type="file"
        accept=".txt,.csv,.tsv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
        }}
      />

      {rows.length > 0 && (
        <>
          <p className="anki-import-rowcount">{rows.length} rows parsed.</p>

          <div className="anki-column-pickers">
            <ColumnPicker label="Headword column (required)" value={headwordCol} onChange={setHeadwordCol} maxCols={maxCols} sample={rows[0]} />
            <ColumnPicker label="Pinyin column (optional)" value={pinyinCol} onChange={setPinyinCol} maxCols={maxCols} sample={rows[0]} allowNone />
            <ColumnPicker label="Gloss column (optional)" value={glossCol} onChange={setGlossCol} maxCols={maxCols} sample={rows[0]} allowNone />
          </div>

          {headwordCol !== NO_COLUMN && (
            <>
              <div className="anki-summary">
                <div>Total: {summary.total}</div>
                <div className="anki-summary-matched">Matched: {summary.matched}</div>
                <div className="anki-summary-ambiguous">Ambiguous: {summary.ambiguous}</div>
                <div className="anki-summary-unmatched">Unmatched: {summary.unmatched}</div>
              </div>

              <div className="anki-actions">
                <button disabled={status === 'importing' || summary.matched + summary.ambiguous === 0} onClick={importMatched}>
                  Import {summary.matched + summary.ambiguous} matched/ambiguous as "seen"
                </button>
                <button disabled={status === 'importing' || summary.unmatched === 0} onClick={addUnmatchedAsCustom}>
                  Add {summary.unmatched} unmatched as custom words
                </button>
              </div>

              {status === 'done' && <p className="anki-done">{doneMessage}</p>}

              <table className="anki-preview">
                <thead>
                  <tr>
                    <th>Headword</th>
                    <th>Status</th>
                    <th>Matched word</th>
                  </tr>
                </thead>
                <tbody>
                  {results.slice(0, 200).map((r, i) => (
                    <tr key={i} className={`anki-row anki-row--${r.status}`}>
                      <td data-label="Headword" lang="zh-Hant">
                        {r.headword}
                      </td>
                      <td data-label="Status">{r.status}</td>
                      <td data-label="Matched word">
                        {r.word ? `${r.word.headword} (${r.word.pinyin})` : '—'}
                        {r.candidates && r.candidates.length > 1 && (
                          <span className="anki-ambiguous-note"> +{r.candidates.length - 1} more sense(s)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {results.length > 200 && <p className="anki-truncated">showing first 200 of {results.length} rows</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}

function ColumnPicker({
  label,
  value,
  onChange,
  maxCols,
  sample,
  allowNone,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  maxCols: number;
  sample?: string[];
  allowNone?: boolean;
}) {
  return (
    <label className="anki-column-picker">
      {label}
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {allowNone && <option value={NO_COLUMN}>(none)</option>}
        {!allowNone && value === NO_COLUMN && <option value={NO_COLUMN}>(pick one)</option>}
        {Array.from({ length: maxCols }, (_, i) => (
          <option key={i} value={i}>
            Column {i + 1}: {sample?.[i]?.slice(0, 20) ?? ''}
          </option>
        ))}
      </select>
    </label>
  );
}
