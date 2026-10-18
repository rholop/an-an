import { useEffect, useState } from 'react';
import { glossFor, type ErrorItem, type Lexicon } from '@anan/core';
import { db, learnerService } from '../db/instance.js';
import { getLedgerNow } from '../lib/ledger.js';
import { markStudyDirty, onStudyDirty } from '../lib/study-dirty.js';

/**
 * Phase 47 Part B.3: journal fixes waiting for words the learner hasn't learned yet (Cloze shows a
 * fix only once every word of its answer is known). Each word has "Add to review": it takes the
 * next new-word slot, under the day's limit.
 */
export function WaitingFixes({ lexicon }: { lexicon: Lexicon }) {
  const [waiting, setWaiting] = useState<Array<{ item: ErrorItem; wordIds: string[] }> | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);
  useEffect(() => onStudyDirty(() => setReload((k) => k + 1)), []);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([getLedgerNow(new Date()), db.errorItems.toArray()]).then(([ledger, items]) => {
      if (!cancelled) setWaiting(ledger.errorItems(items).waiting);
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function add(id: string) {
    const now = new Date();
    await learnerService.record(
      { item: { kind: 'word', id }, skill: 'recognition', kind: 'review_restore', at: now, context: { source: 'journal', priority: true } },
      now,
    );
    setAdded((a) => new Set(a).add(id));
    markStudyDirty();
  }

  return (
    <section id="waiting-fixes">
      <h2>Journal fixes waiting for words</h2>
      {!waiting ? (
        <p>Loading…</p>
      ) : waiting.length === 0 ? (
        <p>Nothing is waiting.</p>
      ) : (
        <>
          <p>Cloze asks for these fixes once you know every word in the answer.</p>
          <ul className="reported-list" data-testid="waiting-fixes">
            {waiting.map(({ item, wordIds }) => (
              <li key={item.id}>
                <p lang="zh-Hant-TW" className="reported-sentence">
                  {item.corrected}
                </p>
                {item.en && (
                  <p>
                    <small>{item.en}</small>
                  </p>
                )}
                {wordIds.map((id) => {
                  const w = lexicon.byId(id);
                  return (
                    <p key={id}>
                      <span lang="zh-Hant-TW">{w?.headword ?? id}</span>
                      {w ? ` (${glossFor(w)})` : ''}{' '}
                      {added.has(id) ? (
                        <span role="status">Added to review</span>
                      ) : (
                        <button type="button" data-testid="waiting-add" onClick={() => void add(id)}>
                          Add to review
                        </button>
                      )}
                    </p>
                  );
                })}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
