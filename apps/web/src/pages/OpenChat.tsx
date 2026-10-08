// Phase 18: Open chat. A friend (安安) to talk to about anything; the words she uses are
// weighted towards what you know and what your class covers next (see core's openChat.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  openChatChips,
  OPEN_CHAT_NPC,
  type Lexicon,
  type Level,
  type SkillCard,
  type Textbook,
  type TopicChip,
  type TutorLLM,
} from '@anan/core';
import { AnnotatedText, type AnnotatedToken } from '../components/AnnotatedText.js';
import { db, learnerService } from '../db/instance.js';
import type { ConversationRow, TurnRow } from '../db/schema.js';
import { annotate, withReadingDisplay } from '../lib/annotate.js';
import type { ChatService } from '../lib/chat-service.js';
import { onStudyDirty } from '../lib/study-dirty.js';
import { useReadingSettings } from '../lib/reading.js';
import { AnnotatedInline } from '../components/AnnotatedInline.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import {
  BACK_TO_CHATS,
  CHAT_FINISHED,
  END_CHAT,
  NEW_WORDS_MET,
  UNRELIABLE_REPLY,
  messagesFromYou,
} from '../lib/labels.js';
import {
  OpenChatService,
  type OpenChatSummary,
  type OpenTurnResult,
} from '../lib/open-chat-service.js';
import { getStudyFocusNow } from '../lib/study.js';
import { useKeyboardOpen } from '../lib/viewport.js';
import { useSetting } from '../lib/useSetting.js';
import './ChatPage.css';
import './OpenChat.css';

type Scaffolding = 'high' | 'medium' | 'low';
const SUGGESTED_REPLY_CAP: Record<Scaffolding, number> = { high: 2, medium: 1, low: 0 };

export function OpenChatEntryCard({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="open-chat-card" onClick={onOpen} data-testid="open-chat-card">
      <div className="open-chat-card-title" lang="zh-Hant">
        Open chat · 和{OPEN_CHAT_NPC.name}聊天
      </div>
      <div className="open-chat-card-sub">Talk about anything you like. No goals, no script.</div>
    </button>
  );
}

interface Props {
  lexicon: Lexicon;
  tutorLLM: TutorLLM;
  chatService: ChatService | null;
  books: Textbook[];
  learnerLevel: Level;
  cardsByWordId: Map<string, SkillCard>;
  refreshCards: () => Promise<void>;
  onExit: () => void;
}

export function OpenChatView({
  lexicon,
  tutorLLM,
  chatService,
  books,
  learnerLevel,
  cardsByWordId,
  refreshCards,
  onExit,
}: Props) {
  // The service reads the books through a ref, so a freshly imported textbook applies at once.
  const booksRef = useRef(books);
  booksRef.current = books;
  const service = useMemo(
    () =>
      new OpenChatService(db, lexicon, learnerService, tutorLLM, {
        books: () => booksRef.current,
        studyFocus: () => getStudyFocusNow(),
      }),
    [lexicon, tutorLLM],
  );

  const [conversationId, setConversationId] = useState<number | null>(null);
  const [conversation, setConversation] = useState<ConversationRow | null>(null);
  const [turns, setTurns] = useState<TurnRow[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookedUpByTurnId, setLookedUpByTurnId] = useState<Map<number, Set<string>>>(new Map());
  const [stuckLevel, setStuckLevel] = useState(0);
  const [ended, setEnded] = useState(false);
  const [summary, setSummary] = useState<OpenChatSummary | null>(null);
  const [pickingTopic, setPickingTopic] = useState(false);
  const [lastResult, setLastResult] = useState<OpenTurnResult | null>(null);
  const [scaffolding, setScaffolding] = useSetting<Scaffolding>('chatScaffolding', 'high');
  const [englishFallback, setEnglishFallback] = useSetting('chatEnglishFallback', false);
  const [privacySeen, setPrivacySeen, privacyLoaded] = useSetting('openChatPrivacySeen', false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const keyboardOpen = useKeyboardOpen();

  // Chips follow the header level and the study focus: change either and the list changes, no reload.
  const [chips, setChips] = useState<TopicChip[]>([]);
  const [studyTick, setStudyTick] = useState(0);
  useEffect(() => onStudyDirty(() => setStudyTick((t) => t + 1)), []);
  const { script, mode } = useReadingSettings();
  useEffect(() => {
    let cancelled = false;
    service
      .vocabFor('', learnerLevel, new Date())
      .then((v) => {
        if (!cancelled) setChips(openChatChips(v.upcoming, learnerLevel));
      })
      .catch(() => {
        if (!cancelled) setChips(openChatChips({ lessons: [] }, learnerLevel));
      });
    return () => {
      cancelled = true;
    };
  }, [service, learnerLevel, books, studyTick]);

  const refresh = useCallback(
    async (cid: number) => {
      const [t, conv] = await Promise.all([service.getTurns(cid), db.conversations.get(cid)]);
      setTurns(t);
      setConversation(conv ?? null);
    },
    [service],
  );

  async function start(topic: string) {
    setError(null);
    setSummary(null);
    setEnded(false);
    setStuckLevel(0);
    setLookedUpByTurnId(new Map());
    setLastResult(null);
    if (!privacySeen) void setPrivacySeen(true);
    const cid = await service.startConversation(topic);
    setConversationId(cid);
    await refresh(cid);
    // Warm the topic list while the learner reads the opener.
    if (topic.trim()) void service.getTopicWords(topic, learnerLevel).catch(() => undefined);
  }

  async function changeTopic(topic: string) {
    if (conversationId === null) return;
    setPickingTopic(false);
    await service.setTopic(conversationId, topic);
    await refresh(conversationId);
    if (topic.trim()) void service.getTopicWords(topic, learnerLevel).catch(() => undefined);
  }

  const lastNpcTurn = [...turns].reverse().find((t) => t.role === 'npc');
  const suggestions = lastNpcTurn?.suggestedReplies ?? [];
  const visibleSuggestions = suggestions.slice(0, SUGGESTED_REPLY_CAP[scaffolding]);

  function makeOnLookup(turnId: number | undefined) {
    return async (at: AnnotatedToken, kind: 'gloss' | 'reading') => {
      if (!at.wordId) return;
      const now = new Date();
      await learnerService.record(
        {
          item: { kind: 'word', id: at.wordId },
          skill: 'recognition',
          kind: kind === 'gloss' ? 'chat_lookup_gloss' : 'chat_hover_reading',
          at: now,
          context: { source: 'chat' },
        },
        now,
      );
      if (turnId !== undefined) {
        const wordId = at.wordId;
        setLookedUpByTurnId((prev) => {
          const next = new Map(prev);
          const set = new Set(next.get(turnId));
          set.add(wordId);
          next.set(turnId, set);
          return next;
        });
      }
      await refreshCards();
    };
  }

  async function sendMessage() {
    if (conversationId === null || sending) return;
    const text = input.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    try {
      if (lastNpcTurn?.id !== undefined && chatService) {
        const lookedUp = lookedUpByTurnId.get(lastNpcTurn.id) ?? new Set<string>();
        await chatService.recordNoLookupEvidence(lastNpcTurn.zh, lookedUp);
      }
      setInput('');
      setStuckLevel(0);
      const result = await service.sendLearnerTurn(conversationId, text, {
        learnerLevel,
        scaffolding,
        englishFallback,
      });
      setLastResult(result);
      await refresh(conversationId);
      await refreshCards();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refresh(conversationId); // the learner's own message is already saved
    } finally {
      setSending(false);
    }
  }

  async function endNow() {
    if (conversationId === null) return;
    await service.endConversation(conversationId);
    setEnded(true);
    setSummary(await service.getSummary(conversationId));
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, keyboardOpen, sending, pickingTopic]);

  // ---- topic screen -------------------------------------------------------------
  if (conversationId === null) {
    return (
      <div className="chat-page chat-page--convo open-chat-topic" data-testid="open-chat-topic">
        <div className="chat-header">
          <button onClick={onExit}>{BACK_TO_CHATS}</button>
          <h1 lang="zh-Hant">Open chat · {OPEN_CHAT_NPC.name}</h1>
        </div>
        <div className="chat-scroll">
          {privacyLoaded && !privacySeen && (
            <p className="open-chat-privacy" role="note" data-testid="open-chat-privacy">
              Open chat is sent to Google or OpenAI. Don't share anything private.{' '}
              <button className="chat-chip" onClick={() => void setPrivacySeen(true)}>
                Got it
              </button>
            </p>
          )}
          <TopicPicker
            chips={chips}
            onPick={(t) => void start(t)}
            onJustChat={() => void start('')}
            submitLabel="Start"
          />
        </div>
      </div>
    );
  }

  // ---- conversation -------------------------------------------------------------
  const topic = conversation?.topic ?? '';
  return (
    <div className="chat-page chat-page--convo" data-testid="open-chat">
      <div className="chat-header">
        <button onClick={onExit}>{BACK_TO_CHATS}</button>
        <h1 lang="zh-Hant">
          {OPEN_CHAT_NPC.name} · {topic || 'Just chat'}
        </h1>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-messages">
          {turns.map((turn) => {
            const annotated = withReadingDisplay(
              annotate(
                turn.zh,
                lexicon,
                new Map(
                  (turn.tokens ?? []).flatMap((t) => {
                    const id = (t as { sense_id?: string }).sense_id;
                    return id ? [[t.text, id] as const] : [];
                  }),
                ),
                { textbook: false },
              ),
              cardsByWordId,
            );
            const tiers = turn.validatorReport?.tiers;
            return (
              <div key={turn.id} className={`chat-bubble chat-bubble--${turn.role}`}>
                {turn.recastZh && (
                  <div className="chat-recast">
                    You could say: <AnnotatedInline text={turn.recastZh} lexicon={lexicon} script={script} />
                  </div>
                )}
                <AnnotatedText
                  tokens={annotated}
                  mode={mode}
                  script={script}
                  onLookup={turn.role === 'npc' ? makeOnLookup(turn.id) : undefined}
                  lookupSource="chat"
                  currentLevel={learnerLevel}
                />
                <SpeakerButton kind="sentence" text={turn.zh} />
                {turn.glosses && turn.glosses.length > 0 && (
                  <div className="open-chat-glosses" data-testid="open-chat-glosses">
                    {turn.glosses.map((g) => (
                      <span key={g.text} className="open-chat-gloss">
                        <span lang="zh-Hant">{g.text}</span> = {g.gloss}
                      </span>
                    ))}
                  </div>
                )}
                {englishFallback && turn.en && <div className="chat-en">{turn.en}</div>}
                {import.meta.env.DEV && tiers && (
                  <div className="chat-debug" data-testid="open-chat-debug">
                    A {tiers.a} · B {tiers.b} · C {tiers.c} · allowed {tiers.allowed} · A-share{' '}
                    {(tiers.shareA * 100).toFixed(0)}% · upcoming {tiers.usesUpcoming ? 'yes' : 'no'} ·
                    attempts {turn.validatorReport?.attempts} ·{' '}
                    {turn.validatorReport?.pass ? 'passed' : 'FAILED (shown anyway, glossed)'}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {error && (
          <div className="chat-error">
            {error === UNRELIABLE_REPLY ? error : `${UNRELIABLE_REPLY} (${error})`}
          </div>
        )}
        {import.meta.env.DEV && lastResult && (
          <div className="chat-debug" data-testid="open-chat-vocab-debug">
            tier A {lastResult.vocab.tierAIds.size} · tier B {lastResult.vocab.tierBIds.size} ·
            upcoming {lastResult.vocab.upcoming.source} ({lastResult.vocab.upcoming.lessons.length}{' '}
            lessons) · topic words {lastResult.vocab.topicCounts.a}/{lastResult.vocab.topicCounts.b}/
            {lastResult.vocab.topicCounts.c}
            {lastResult.vocab.hardTopic ? ' · hard topic' : ''}
          </div>
        )}

        {ended && summary && (
          <OpenSummaryPanel
            lexicon={lexicon}
            summary={summary}
            onAdd={async (ids) => {
              await service.addToReview(ids);
              await refreshCards();
              setSummary(await service.getSummary(conversationId));
            }}
          />
        )}
      </div>

      {!ended && (
        <div className="chat-composer">
          {pickingTopic ? (
            <TopicPicker
              chips={chips}
              onPick={(t) => void changeTopic(t)}
              onJustChat={() => void changeTopic('')}
              onCancel={() => setPickingTopic(false)}
              submitLabel="Switch"
              compact
            />
          ) : (
            <>
              {visibleSuggestions.length > 0 && (
                <div className="chat-chips">
                  {visibleSuggestions.map((s, i) => (
                    <button key={i} className="chat-chip" onClick={() => setInput(s.zh)}>
                      {s.zh}
                    </button>
                  ))}
                </div>
              )}
              {stuckLevel === 1 && suggestions[0] && (
                <div className="chat-hint">Hint: {suggestions[0].en}</div>
              )}
              {stuckLevel >= 2 && suggestions[0] && (
                <div className="chat-hint">
                  Try:{' '}
                  <button className="chat-chip" onClick={() => setInput(suggestions[0]!.zh)}>
                    {suggestions[0].zh}
                  </button>
                </div>
              )}
              {input !== '' && suggestions.some((x) => x.zh === input) && (
                <p className="chat-reply-preview" lang="zh-Hant" data-testid="chat-reply-preview">
                  <AnnotatedInline text={input} lexicon={lexicon} script={script} />
                </p>
              )}
              <div className="chat-input-row">
                <input
                  className="chat-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder={englishFallback ? '中文 or English, or [word] for one you do not know…' : '輸入中文…'}
                  lang="zh-Hant-TW"
                  enterKeyHint="send"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={sending}
                />
                <button className="btn-primary" onClick={sendMessage} disabled={sending || !input.trim()}>
                  {sending ? '…' : 'Send'}
                </button>
                <button
                  onClick={() => {
                    void service.recordStuck(conversationId);
                    setStuckLevel((l) => Math.min(l + 1, 2));
                  }}
                  disabled={suggestions.length === 0}
                >
                  I'm stuck
                </button>
              </div>
              <div className="chat-controls">
                <label>
                  Scaffolding:{' '}
                  <select
                    value={scaffolding}
                    onChange={(e) => setScaffolding(e.target.value as Scaffolding)}
                  >
                    {(['high', 'medium', 'low'] as const).map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                {(learnerLevel === 'N1' || learnerLevel === 'N2') && (
                  <label>
                    <input
                      type="checkbox"
                      checked={englishFallback}
                      onChange={(e) => setEnglishFallback(e.target.checked)}
                    />
                    English fallback
                  </label>
                )}
                <button onClick={() => setPickingTopic(true)}>New topic</button>
                <button onClick={endNow}>{END_CHAT}</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** "What do you want to talk about?": a text box (English or Chinese), up to 8 chips, Just chat. */
function TopicPicker({
  chips,
  onPick,
  onJustChat,
  onCancel,
  submitLabel,
  compact,
}: {
  chips: TopicChip[];
  onPick: (topic: string) => void;
  onJustChat: () => void;
  onCancel?: () => void;
  submitLabel: string;
  compact?: boolean;
}) {
  const [text, setText] = useState('');
  const go = () => {
    if (text.trim()) onPick(text.trim());
  };
  return (
    <div className={`open-topic-picker${compact ? ' open-topic-picker--compact' : ''}`}>
      <h2>What do you want to talk about?</h2>
      <div className="chat-chips open-topic-chips" data-testid="open-chat-chips">
        {chips.map((c) => (
          <button key={c.id} className="chat-chip" onClick={() => onPick(c.topic)}>
            {c.label}
          </button>
        ))}
        <button className="chat-chip open-just-chat" onClick={onJustChat}>
          Just chat
        </button>
      </div>
      <div className="chat-input-row open-topic-row">
        <input
          className="chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          placeholder="A topic, in English or 中文…"
          aria-label="Topic"
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="go"
          data-testid="open-chat-topic-input"
        />
        <button onClick={go} disabled={!text.trim()}>
          {submitLabel}
        </button>
        {onCancel && <button onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

function OpenSummaryPanel({
  summary,
  onAdd,
  lexicon,
}: {
  summary: OpenChatSummary;
  onAdd: (wordIds: string[]) => Promise<void>;
  lexicon: Lexicon;
}) {
  const { script } = useReadingSettings();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="chat-summary" data-testid="open-chat-summary">
      <h2>{CHAT_FINISHED}</h2>
      <ul>
        <li>{messagesFromYou(summary.learnerTurns)}</li>
        <li data-testid="open-chat-tier-mix">
          {Math.round(summary.tierShareA * 100)}% words you know or are learning soon
        </li>
        <li>
          {Math.round(summary.upcomingTurnShare * 100)}% of replies used words from your next lessons
        </li>
      </ul>
      {summary.wordsMet.length > 0 && (
        <>
          <h3>{NEW_WORDS_MET}</h3>
          <ul className="open-chat-met">
            {summary.wordsMet.map((w) => (
              <li key={w.wordId}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(w.wordId)}
                    onChange={() => toggle(w.wordId)}
                  />{' '}
                  <span lang="zh-Hant">{w.headword}</span> · {w.glossEn}
                  {w.lookedUp && <span className="open-chat-looked"> · looked up</span>}
                </label>
              </li>
            ))}
          </ul>
          <button
            disabled={chosen.size === 0 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onAdd([...chosen]);
                setChosen(new Set());
              } finally {
                setBusy(false);
              }
            }}
          >
            Add to review{chosen.size > 0 ? ` (${chosen.size})` : ''}
          </button>
        </>
      )}
      {summary.wordsLookedUp.length > 0 && (
        <>
          <h3>Words you looked up</h3>
          <p className="chat-summary-words" lang="zh-Hant">
            <AnnotatedInline text={summary.wordsLookedUp.join('、')} lexicon={lexicon} script={script} />
          </p>
        </>
      )}
    </div>
  );
}
