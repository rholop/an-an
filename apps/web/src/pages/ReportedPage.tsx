import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildErrorCloze,
  CLOZE_REPORT_REASONS,
  checkErrorItem,
  type ErrorItem,
  type JournalSentenceVerdict,
  type SourceReport,
} from '@anan/core';
import { db } from '../db/instance.js';
import {
  alsoInOtherProfiles,
  deleteJournalItem,
  deleteSource,
  loadSourceReports,
  restoreJournalItem,
  restoreSource,
} from '../lib/cloze-reports.js';
import { allowedLatinNames, loadSentenceVerdicts } from '../lib/journal-cloze-check.js';
import { FetchTutorLLM } from '../lib/tutor-llm.js';
import { useLexicon } from '../lib/useLexicon.js';

const reasonLabel = (id: string) => CLOZE_REPORT_REASONS.find((r) => r.id === id)?.label ?? id;

interface Row {
  key: string;
  zh: string;
  where: string;
  why: string;
  note?: string;
  item?: ErrorItem;
  source?: SourceReport;
  verdictKey?: string;
  verdict?: JournalSentenceVerdict;
}

const fmt = (d: Date) => d.toLocaleDateString();

/** Phase 16 Part D: everything reported or blocked, with Fix it / It was
 * fine / Delete, and a plain-text export for prompt fixes. */
export function ReportedPage() {
  const lexiconState = useLexicon();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const [items, sources, verdicts, entries] = await Promise.all([
      db.errorItems.filter((i) => i.status === 'reported' || i.status === 'blocked').toArray(),
      loadSourceReports(db),
      loadSentenceVerdicts(db),
      db.journalEntries.toArray(),
    ]);
    const entryDate = new Map(entries.map((e) => [e.id, e.createdAt]));
    const out: Row[] = [];
    for (const it of items) {
      const date = entryDate.get(it.journalEntryId);
      out.push({
        key: `item:${it.id}`,
        zh: it.corrected,
        where: `journal entry${date ? ` of ${fmt(date)}` : ''}`,
        why: it.status === 'reported' ? reasonLabel(it.report?.reason ?? 'other') : `Blocked: ${it.blockedReason ?? 'failed the check'}`,
        note: it.report?.note,
        item: it,
      });
    }
    for (const s of sources.filter((x) => x.state === 'reported')) {
      out.push({
        key: `src:${s.zh}`,
        zh: s.zh,
        where: s.sourceLabel || s.sourceKind,
        why: reasonLabel(s.reason),
        note: s.note,
        source: s,
      });
    }
    for (const [key, v] of verdicts) {
      if (v.ok) continue;
      const date = v.entryId ? entryDate.get(v.entryId) : undefined;
      out.push({
        key,
        zh: v.zh,
        where: `journal sentence${date ? ` of ${fmt(date)}` : ''}`,
        why: `Blocked: ${v.reason ?? 'failed the check'}`,
        verdictKey: key,
        verdict: v,
      });
    }
    setRows(out);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } finally {
      setBusy(null);
    }
  };

  const text = useMemo(
    () =>
      (rows ?? [])
        .map(
          (r) =>
            `Sentence: ${r.zh}\nSource: ${r.where}\nReason: ${r.why}${r.note ? `\nNote: ${r.note}` : ''}`,
        )
        .join('\n\n'),
    [rows],
  );

  async function exportJson() {
    const data = {
      journalEntries: await db.journalEntries.toArray(),
      journalReviews: await db.journalReviews.toArray(),
      errorItems: await db.errorItems.toArray(),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'journal-and-error-bank.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!rows) return <p>Loading…</p>;
  return (
    <div className="reported-page">
      <h1>Reported clozes</h1>
      {rows.length === 0 ? (
        <p>Nothing reported or blocked.</p>
      ) : (
        <>
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(text)
                .then(() => setMessage('Copied.'))
                .catch(() => setMessage('Could not copy.'))
            }
          >
            Copy all as text
          </button>
          {message && <span role="status"> {message}</span>}
          <ul className="reported-list">
            {rows.map((r) => (
              <li key={r.key}>
                <p lang="zh-Hant-TW" className="reported-sentence">
                  {r.zh}
                </p>
                <p>
                  <small>
                    {r.where} — {r.why}
                    {r.note ? ` — “${r.note}”` : ''}
                  </small>
                </p>
                {r.item && lexiconState.status === 'ready' && (
                  <FixIt
                    item={r.item}
                    busy={busy === r.key}
                    onSave={(next) => run(r.key, () => fixItem(r.item!, next, lexiconState.lexicon))}
                  />
                )}
                <button
                  disabled={busy === r.key}
                  onClick={() =>
                    void run(r.key, async () => {
                      if (r.item) await restoreJournalItem(db, r.item);
                      else if (r.source) {
                        await restoreSource(db, r.source.zh);
                        await alsoInOtherProfiles(r.source.sourceKind, r.source.profileId, (o) =>
                          restoreSource(o, r.source!.zh),
                        );
                      } else if (r.verdictKey && r.verdict)
                        await db.settings.put({
                          key: r.verdictKey,
                          value: { ...r.verdict, ok: true, reason: undefined },
                        });
                    })
                  }
                >
                  It was fine
                </button>
                <button
                  disabled={busy === r.key}
                  onClick={() =>
                    void run(r.key, async () => {
                      if (r.item) await deleteJournalItem(db, r.item);
                      else if (r.source) {
                        await deleteSource(db, r.source.zh);
                        await alsoInOtherProfiles(r.source.sourceKind, r.source.profileId, (o) =>
                          deleteSource(o, r.source!.zh),
                        );
                      } else if (r.verdictKey && r.verdict)
                        // stays excluded: a reported-then-deleted sentence is never offered
                        await db.settings.put({
                          key: r.verdictKey,
                          value: { ...r.verdict, ok: false, reason: 'deleted' },
                        });
                    })
                  }
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {import.meta.env.DEV && (
        <p>
          <button onClick={() => void exportJson()}>Export journal + error bank as JSON</button>
        </p>
      )}
    </div>
  );
}

/** Fix it (journal items only): edit the corrected sentence; it goes through
 * the Part B checks before the item comes back. */
function FixIt({
  item,
  busy,
  onSave,
}: {
  item: ErrorItem;
  busy: boolean;
  onSave: (corrected: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(item.corrected);
  const [error, setError] = useState('');
  if (!open)
    return (
      <button disabled={busy} onClick={() => setOpen(true)}>
        Fix it
      </button>
    );
  return (
    <div className="reported-fix">
      <p>
        <small>
          You wrote: <span lang="zh-Hant-TW">{item.original}</span>
          {item.pattern ? ` — ${item.pattern}` : ''}
        </small>
      </p>
      <label>
        Corrected sentence (must still contain “{buildErrorCloze(item).answer}”)
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          lang="zh-Hant-TW"
          style={{ width: '100%', fontSize: 16 }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button
        disabled={busy}
        onClick={() =>
          void onSave(text.trim()).then(
            () => setOpen(false),
            (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
          )
        }
      >
        Save and check
      </button>
      <button onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

async function fixItem(
  item: ErrorItem,
  corrected: string,
  lexicon: import('@anan/core').Lexicon,
): Promise<void> {
  const answer = buildErrorCloze(item).answer;
  const at = corrected.indexOf(answer);
  if (at === -1 || corrected.indexOf(answer, at + 1) !== -1)
    throw new Error(`The sentence must contain “${answer}” exactly once.`);
  const candidate: ErrorItem = {
    ...item,
    corrected,
    blank: [at, at + answer.length],
    status: 'pending_check',
    report: undefined,
    blockedReason: undefined,
  };
  const checked = await checkErrorItem(candidate, {
    lexicon,
    llm: new FetchTutorLLM(),
    allowedNames: await allowedLatinNames(db),
  });
  if (checked.status === 'active') {
    await db.errorItems.put(checked);
    return;
  }
  if (checked.status === 'blocked') throw new Error(checked.blockedReason ?? 'Failed the check.');
  throw new Error("Couldn't run the naturalness check just now. Try again later.");
}
