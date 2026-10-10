// Phase 36: what every chat shows around the bubbles, the same in scenario chat and open chat:
// under the learner's message the "Read as" (fixable), the gentle correction (Why?, Ask about this,
// I think mine is right) or a small ✓, and the gap options with "Add to review"; on a reply that
// went against the learner, a warning with Try again; and the "Words from this chat" panel.
import { useEffect, useState } from 'react';
import type { JournalIssue, Lexicon } from '@anan/core';
import type { JournalEntryRow, JournalReviewRow, TurnRow } from '../db/schema.js';
import type { ChatEngine, ChatWordEntry } from '../lib/chat-engine.js';
import { aiErrorText } from '../lib/tutor-llm.js';
import { useReadingScript } from './AnnotatedInline.js';
import {
  AnnotationContext,
  AskPanel,
  BracketList,
  DisputeLine,
  TYPE_LABEL,
  WhyToggle,
  Zh,
} from './CorrectionParts.js';
import {
  ADD_TO_REVIEW,
  ANSWER_THIS,
  CHAT_WORD_SOURCE,
  CHECKING_MESSAGE,
  CORRECTIONS_PAUSED,
  COULD_NOT_CHECK,
  IN_REVIEW,
  MAY_HAVE_MISUNDERSTOOD,
  MESSAGE_LOOKS_RIGHT,
  MESSAGE_LOOKS_RIGHT_LABEL,
  NOT_WHAT_I_MEANT,
  TRY_AGAIN,
  WHAT_DID_YOU_MEAN,
  WORDS_FROM_THIS_CHAT,
  chatWordsCount,
  readAsLine,
} from '../lib/labels.js';
import '../pages/JournalPage.css';

/** The learner's message with every kept correction put in, the changed parts marked. */
function CorrectedLine({ text, issues }: { text: string; issues: readonly { issue: JournalIssue }[] }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  [...issues]
    .sort((a, b) => a.issue.span[0] - b.issue.span[0])
    .forEach(({ issue }, i) => {
      if (issue.span[0] < cursor) return;
      if (issue.span[0] > cursor) parts.push(<Zh key={`t${i}`} text={text.slice(cursor, issue.span[0])} />);
      parts.push(
        <mark key={i} className={`journal-hl journal-hl--${issue.type}`} title={TYPE_LABEL[issue.type]}>
          {issue.correction}
        </mark>,
      );
      cursor = issue.span[1];
    });
  if (cursor < text.length) parts.push(<Zh key="tail" text={text.slice(cursor)} />);
  return (
    <p className="chat-corrected" lang="zh-Hant" data-testid="chat-corrected">
      {parts}
    </p>
  );
}

function ChatCorrection({ engine, entryId, onChange }: { engine: ChatEngine; entryId: string; onChange: () => void }) {
  const [data, setData] = useState<{ entry: JournalEntryRow; review: JournalReviewRow } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([engine.journal.getEntry(entryId), engine.journal.getReview(entryId)]).then(([entry, review]) => {
      if (!cancelled && entry && review) setData({ entry, review });
    });
    return () => {
      cancelled = true;
    };
  }, [engine, entryId, tick]);
  if (!data) return null;
  const { entry, review } = data;
  const changed = () => {
    setTick((t) => t + 1);
    onChange();
  };
  const kept = review.issues
    .map((issue, index) => ({ issue, index }))
    .filter(({ index }) => review.disputes?.[index]?.verdict !== 'upheld');
  return (
    <div className="chat-correction" data-testid="chat-correction">
      {kept.length > 0 && <CorrectedLine text={entry.text} issues={kept} />}
      <ul className="chat-correction-list">
        {review.issues.map((issue, i) => (
          <li key={i} data-testid="chat-issue">
            <span className={`journal-hl journal-hl--${issue.type}`}>{TYPE_LABEL[issue.type]}</span>{' '}
            <span lang="zh-Hant" className="journal-pair">
              <span className="journal-pair-wrong">{entry.text.slice(issue.span[0], issue.span[1])}</span> →{' '}
              <span className="journal-ok">
                <Zh text={issue.correction} />
              </span>
            </span>
            <div className="chat-correction-actions">
              <WhyToggle issue={issue} pastIssues={[]} />
              <AskPanel service={engine.journal} entryId={entry.id} index={i} turns={review.asks?.[i] ?? []} onChange={changed} />
              <DisputeLine service={engine.journal} entryId={entry.id} index={i} dispute={review.disputes?.[i]} onChange={changed} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Read as: …", which the learner can fix on their last message (the reply is regenerated). */
function ReadAs({
  turn,
  canFix,
  onFix,
}: {
  turn: TurnRow;
  canFix: boolean;
  onFix: (meaningEn: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(turn.meaningEn ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!turn.meaningEn && !canFix) return null;
  return (
    <div className="chat-read-as" data-testid="chat-read-as">
      {!editing && (
        <span>
          {turn.meaningEn ? (turn.meaningFixed ? `You meant: ${turn.meaningEn}` : readAsLine(turn.meaningEn)) : ''}{' '}
          {canFix && (
            <button type="button" className="journal-link" onClick={() => setEditing(true)}>
              {turn.meaningEn ? NOT_WHAT_I_MEANT : WHAT_DID_YOU_MEAN}
            </button>
          )}
        </span>
      )}
      {editing && (
        <div className="journal-ask-form">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={WHAT_DID_YOU_MEAN}
            placeholder="I meant…"
            enterKeyHint="send"
          />
          <button
            type="button"
            disabled={busy || !value.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onFix(value);
                setEditing(false);
              } catch (err) {
                setError(aiErrorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '…' : ANSWER_THIS}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="journal-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Everything under one learner bubble. */
export function LearnerExtras({
  turn,
  isLast,
  engine,
  lexicon,
  onFixMeaning,
  onChange,
}: {
  turn: TurnRow;
  isLast: boolean;
  engine: ChatEngine;
  lexicon: Lexicon;
  onFixMeaning: (turnId: number, meaningEn: string) => Promise<void>;
  onChange: () => void;
}) {
  const script = useReadingScript();
  const status = turn.correction?.status;
  return (
    <AnnotationContext.Provider value={{ lexicon, script }}>
      <div className="chat-learner-extras">
        <ReadAs turn={turn} canFix={isLast && turn.id !== undefined} onFix={(m) => onFixMeaning(turn.id!, m)} />
        {status === 'pending' && (
          <p className="chat-correction-note" role="status">
            {CHECKING_MESSAGE}
          </p>
        )}
        {status === 'clean' && (
          <span className="chat-correction-ok" aria-label={MESSAGE_LOOKS_RIGHT_LABEL} title={MESSAGE_LOOKS_RIGHT_LABEL} data-testid="chat-clean">
            {MESSAGE_LOOKS_RIGHT}
          </span>
        )}
        {status === 'paused' && (
          <p className="chat-correction-note" data-testid="chat-corrections-paused">
            {CORRECTIONS_PAUSED}
          </p>
        )}
        {status === 'failed' && <p className="chat-correction-note">{COULD_NOT_CHECK}</p>}
        {status === 'issues' && turn.correction?.entryId && (
          <ChatCorrection engine={engine} entryId={turn.correction.entryId} onChange={onChange} />
        )}
        {turn.gaps && turn.gaps.length > 0 && (
          <BracketList
            brackets={turn.gaps}
            title="Your gaps"
            onAdd={async (en, zh) => {
              await engine.addGapWord(turn.id!, en, zh);
              onChange();
            }}
          />
        )}
      </div>
    </AnnotationContext.Provider>
  );
}

/** On a reply that still went against what the learner said. */
export function MisunderstoodNote({ onTryAgain }: { onTryAgain: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="chat-misunderstood" role="note" data-testid="chat-misunderstood">
      {MAY_HAVE_MISUNDERSTOOD}{' '}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onTryAgain();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '…' : TRY_AGAIN}
      </button>
    </div>
  );
}

/** "Words from this chat": its words in one list, each with a checkbox and "Add to review". */
export function ChatWordsPanel({
  entries,
  onAdd,
}: {
  entries: readonly ChatWordEntry[];
  onAdd: (chosen: ChatWordEntry[]) => Promise<void>;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const toggle = (key: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <section className="chat-words" data-testid="chat-words">
      <h3>{WORDS_FROM_THIS_CHAT}</h3>
      {entries.length === 0 ? (
        <p className="journal-muted">Words you look up, ask for in [brackets] or get corrected show up here.</p>
      ) : (
        <>
          <ul className="open-chat-met">
            {entries.map((w) => (
              <li key={w.key}>
                <label>
                  {w.inReview ? (
                    <span className="chat-in-review">{IN_REVIEW}</span>
                  ) : (
                    <input type="checkbox" checked={chosen.has(w.key)} onChange={() => toggle(w.key)} />
                  )}{' '}
                  <span lang="zh-Hant">{w.zh}</span>
                  {w.pinyin && <span className="journal-muted"> {w.pinyin}</span>} · {w.glossEn}
                  <span className="open-chat-looked"> · {w.sources.map((s) => CHAT_WORD_SOURCE[s]).join(', ')}</span>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={chosen.size === 0 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onAdd(entries.filter((e) => chosen.has(e.key)));
                setChosen(new Set());
              } finally {
                setBusy(false);
              }
            }}
          >
            {ADD_TO_REVIEW}
            {chosen.size > 0 ? ` (${chosen.size})` : ''}
          </button>
        </>
      )}
    </section>
  );
}

/** The 📚 count in a chat's header, and the panel it opens. */
export function useChatWords(engine: ChatEngine | null, conversationId: number | null, tick: number) {
  const [entries, setEntries] = useState<ChatWordEntry[]>([]);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!engine || conversationId === null) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    void engine.wordPanel(conversationId).then((e) => {
      if (!cancelled) setEntries(e);
    });
    return () => {
      cancelled = true;
    };
  }, [engine, conversationId, tick, reload]);
  return {
    entries,
    count: entries.filter((e) => !e.inReview).length,
    add: async (chosen: ChatWordEntry[]) => {
      if (!engine) return;
      await engine.addToReview(chosen);
      setReload((r) => r + 1);
    },
  };
}

export function ChatWordsButton({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="chat-words-button"
      aria-expanded={open}
      aria-label={`${WORDS_FROM_THIS_CHAT}: ${count}`}
      onClick={onToggle}
      data-testid="chat-words-button"
    >
      {chatWordsCount(count)}
    </button>
  );
}
