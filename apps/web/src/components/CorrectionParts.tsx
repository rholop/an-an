// Phase 36: the parts of a correction the journal (Phase 31) and every chat show the same way:
// the "Why?", "Ask about this", "I think mine is right" and gap options with "Add to review".
import { createContext, useContext, useState } from 'react';
import {
  ruleNoteFor,
  sameMistakeCount,
  JOURNAL_ASK_MAX_TURNS,
  type JournalIssue,
  type Lexicon,
  type Word,
} from '@anan/core';
import { AnnotatedInline, AnnotatedWord } from './AnnotatedInline.js';
import type { AnnotationScript } from './AnnotatedText.js';
import type { ResolvedBracket } from '../db/schema.js';
import type { JournalService } from '../lib/journal-service.js';
import { getLedgerNow } from '../lib/ledger.js';
import { aiErrorText } from '../lib/tutor-llm.js';
import {
  ADD_TO_REVIEW,
  ADDED_TO_REVIEW,
  ASK_ABOUT_THIS,
  CHECKING_EXPLANATION,
  ISSUE_TYPE_LABEL,
  MINE_IS_RIGHT_JOURNAL,
  NOT_SURE_EXPLANATION,
  UNDERSTANDABLE_NOTE,
  WHY,
  YOU_ARE_RIGHT_REMOVED,
  sameMistakeLine,
  stillAMistake,
} from '../lib/labels.js';

export const TYPE_LABEL: Record<JournalIssue['type'], string> = ISSUE_TYPE_LABEL;

/** Chinese shown by the journal (prompts, corrections, suggested words) is
 * annotated text: reading always on screen, definition on hover and click.
 * The lexicon and the reading script are provided once at the top. */
export const AnnotationContext = createContext<{ lexicon: Lexicon; script: AnnotationScript } | null>(
  null,
);

export function Zh({ text }: { text: string }) {
  const ctx = useContext(AnnotationContext);
  return ctx ? (
    <AnnotatedInline text={text} lexicon={ctx.lexicon} script={ctx.script} />
  ) : (
    <span lang="zh-Hant">{text}</span>
  );
}

export function ZhWord({ word }: { word: Word }) {
  const ctx = useContext(AnnotationContext);
  return ctx ? (
    <AnnotatedWord word={word} script={ctx.script} />
  ) : (
    <span lang="zh-Hant">{word.headword}</span>
  );
}

/** Phase 31 Part A: the "Why?" of one correction, shown only once it passed the check. */
export function IssueWhy({ issue, pastIssues }: { issue: JournalIssue; pastIssues: readonly JournalIssue[] }) {
  if (issue.explainStatus === 'pending')
    return (
      <p className="journal-muted" role="status">
        {CHECKING_EXPLANATION}
      </p>
    );
  if (issue.explainStatus === 'unsure')
    return (
      <p className="journal-muted" role="status" data-testid="journal-unsure">
        {NOT_SURE_EXPLANATION}
      </p>
    );
  const e = issue.explain;
  const rule = ruleNoteFor(issue.pattern);
  const n = sameMistakeCount(issue.pattern, pastIssues);
  return (
    <div className="journal-why" data-testid="journal-why">
      {e ? (
        <>
          <p>
            <strong>What&apos;s wrong:</strong> {e.wrongEn}
          </p>
          <p>
            <strong>The fix:</strong> {e.fixEn}
          </p>
          <p lang="zh-Hant" className="journal-pair">
            <span className="journal-pair-wrong">
              <Zh text={e.exampleWrong} /> ✗
            </span>{' '}
            →{' '}
            <span className="journal-ok">
              <Zh text={e.exampleRight} /> ✓
            </span>
          </p>
          {issue.type === 'unnatural' && (
            <p>
              {e.nativeEn ? `${e.nativeEn} ` : ''}
              {UNDERSTANDABLE_NOTE}
            </p>
          )}
        </>
      ) : (
        <p>{issue.explanationEn}</p>
      )}
      {rule && (
        <details className="journal-rule">
          <summary>{rule.title}</summary>
          <p>{rule.explanationEn}</p>
          <ul lang="zh-Hant">
            {rule.examples.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </details>
      )}
      {n >= 2 && <p className="journal-muted">{sameMistakeLine(n)}</p>}
    </div>
  );
}

/** A "Why?" button that opens the explanation (open by default once the answers are shown). */
export function WhyToggle({
  issue,
  pastIssues,
  initiallyOpen = false,
}: {
  issue: JournalIssue;
  pastIssues: readonly JournalIssue[];
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {WHY}
      </button>
      {open && <IssueWhy issue={issue} pastIssues={pastIssues} />}
    </>
  );
}

/** Phase 31 Part C.1: "Ask about this", up to 5 questions, saved with the entry. */
export function AskPanel({
  service,
  entryId,
  index,
  turns,
  onChange,
}: {
  service: JournalService;
  entryId: string;
  index: number;
  turns: readonly { q: string; a: string; examples: { zh: string; en: string }[] }[];
  onChange: () => void;
}) {
  const ctx = useContext(AnnotationContext);
  const [open, setOpen] = useState(turns.length > 0);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    setError(null);
    try {
      // examples are built from the words the learner knows (vocabulary ladder rung 1)
      const ledger = await getLedgerNow(new Date());
      const known = ctx
        ? [...ledger.comprehensible().knownIds].slice(0, 400).flatMap((id) => ctx.lexicon.byId(id)?.headword ?? []).slice(0, 80)
        : [];
      await service.ask(entryId, index, q, known);
      setQ('');
      onChange();
    } catch (err) {
      setError(aiErrorText(err));
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)}>
        {ASK_ABOUT_THIS}
      </button>
    );
  return (
    <div className="journal-ask" data-testid="journal-ask">
      {turns.map((t, i) => (
        <div key={i} className="journal-ask-turn">
          <p className="journal-ask-q">{t.q}</p>
          <p>{t.a}</p>
          {t.examples.length > 0 && (
            <ul>
              {t.examples.map((x) => (
                <li key={x.zh}>
                  <span lang="zh-Hant">
                    <Zh text={x.zh} />
                  </span>{' '}
                  <span className="journal-muted">{x.en}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {turns.length < JOURNAL_ASK_MAX_TURNS && (
        <div className="journal-ask-form">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Why is this wrong if…?"
            aria-label={ASK_ABOUT_THIS}
            enterKeyHint="send"
            onKeyDown={(e) => e.key === 'Enter' && q.trim() && !busy && void send()}
          />
          <button type="button" onClick={send} disabled={busy || !q.trim()}>
            {busy ? 'Asking…' : 'Ask'}
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

/** Phase 31 Part C.3: "I think mine is right", with the check's answer once it has one. */
export function DisputeLine({
  service,
  entryId,
  index,
  dispute,
  onChange,
}: {
  service: JournalService;
  entryId: string;
  index: number;
  dispute?: { verdict: 'upheld' | 'still_wrong'; problem?: string };
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (dispute)
    return (
      <p role="status" className={dispute.verdict === 'upheld' ? 'journal-ok' : 'journal-muted'}>
        {dispute.verdict === 'upheld' ? YOU_ARE_RIGHT_REMOVED : stillAMistake(dispute.problem)}
      </p>
    );
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await service.dispute(entryId, index);
            onChange();
          } catch (err) {
            setError(aiErrorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Checking…' : MINE_IS_RIGHT_JOURNAL}
      </button>
      {error && (
        <p role="alert" className="journal-error">
          {error}
        </p>
      )}
    </>
  );
}

/** Phase 31 Part D: each gap's options, with pinyin, meaning and a usage note. Nothing goes to
 * review until the learner taps "Add to review". */
export function BracketList({
  brackets,
  onAdd,
  title = 'Gaps filled in',
}: {
  brackets: readonly ResolvedBracket[];
  /** "Add to review" on one option (absent: read-only). */
  onAdd?: (en: string, zh: string) => Promise<void>;
  title?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (brackets.length === 0) return null;
  return (
    <div className="journal-brackets">
      <h3>{title}</h3>
      <ul>
        {brackets.map((b) => {
          const options =
            b.options ?? (b.zh ? [{ zh: b.zh, pinyin: '', meaningEn: '', usageEn: '', corrected: '', checked: false }] : []);
          return (
            <li key={b.en} data-testid="journal-gap">
              <span>[{b.en}]</span>
              {options.length === 0 ? (
                <span className="journal-muted"> no good fit found — look this one up</span>
              ) : (
                <ol className="journal-gap-options">
                  {options.map((o) => {
                    const added = b.added?.includes(o.zh) ?? (!b.options && !!b.wordId);
                    return (
                      <li key={o.zh}>
                        <strong lang="zh-Hant">
                          <Zh text={o.zh} />
                        </strong>
                        {o.pinyin && <span className="journal-muted"> {o.pinyin}</span>}
                        {o.meaningEn && <span> · {o.meaningEn}</span>}
                        {o.usageEn && <div className="journal-muted">{o.usageEn}</div>}
                        {o.corrected && (
                          <div lang="zh-Hant" className="journal-muted">
                            <Zh text={o.corrected} />
                          </div>
                        )}
                        {b.options && onAdd && (
                          <button
                            type="button"
                            disabled={added || busy === `${b.en}:${o.zh}`}
                            onClick={async () => {
                              setBusy(`${b.en}:${o.zh}`);
                              try {
                                await onAdd(b.en, o.zh);
                              } finally {
                                setBusy(null);
                              }
                            }}
                          >
                            {added ? ADDED_TO_REVIEW : ADD_TO_REVIEW}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

