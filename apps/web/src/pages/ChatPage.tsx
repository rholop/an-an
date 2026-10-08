import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatDuration,
  classLevelHint,
  stepName,
  courseLessonLevel,
  courseOrdinal,
  filterByLevel,
  LAIXUE_COURSE,
  scenarioMatchesLevels,
  type Level,
  type Lexicon,
  type Scenario,
  type SkillCard,
} from '@anan/core';
import { AnnotatedText, type AnnotatedToken } from '../components/AnnotatedText.js';
import { db, gameService, learnerService } from '../db/instance.js';
import { recognitionCardsByWordId } from '../db/queries.js';
import type { ConversationRow, TurnRow } from '../db/schema.js';
import { annotate, withReadingDisplay } from '../lib/annotate.js';
import { ChatService, type ChatSummary } from '../lib/chat-service.js';
import { FakeTutorLLM } from '../lib/fake-tutor-llm.js';
import { LevelChips } from '../components/LevelPicker.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { loadGameSnapshot, type GameSnapshot } from '../lib/game-data.js';
import { FetchTutorLLM } from '../lib/tutor-llm.js';
import { useKeyboardOpen } from '../lib/viewport.js';
import { useLexicon } from '../lib/useLexicon.js';
import { useMyClass } from '../lib/my-class.js';
import { useReadingSettings } from '../lib/reading.js';
import { AnnotatedInline } from '../components/AnnotatedInline.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import {
  BACK_TO_CHATS,
  CHAT_FINISHED,
  CURRENT_LESSON,
  END_CHAT,
  UNRELIABLE_REPLY,
  YOUR_LEVEL,
  coverageLine,
  lessonLabel,
  levelShort,
  messagesFromYou,
  yourClassLabel,
} from '../lib/labels.js';
import { useTextbook } from '../lib/textbook-data.js';
import { currentClassScope, getStudyFocusNow, useClassScope, useStudyFocus } from '../lib/study.js';
import { OpenChatEntryCard, OpenChatView } from './OpenChat.js';
import { useScenarios } from '../lib/useScenarios.js';
import { useSetting } from '../lib/useSetting.js';
import './ChatPage.css';
import './OpenChat.css';

type Scaffolding = 'high' | 'medium' | 'low';
const SCAFFOLDING_LEVELS: Scaffolding[] = ['high', 'medium', 'low'];
const SUGGESTED_REPLY_CAP: Record<Scaffolding, number> = { high: 2, medium: 1, low: 0 };

/** `initialScenarioId` / `onExit` let the textbook's "Study this lesson" session
 * run a specific scenario inside its own flow and carry on when it ends. */
export function ChatPage({
  initialScenarioId,
  onExit,
}: { initialScenarioId?: string; onExit?: () => void } = {}) {
  const lexiconState = useLexicon();
  const scenariosState = useScenarios();

  const myClass = useMyClass();
  const textbookState = useTextbook();
  const { focus: studyFocus } = useStudyFocus();
  const scope = useClassScope();
  const { script, mode } = useReadingSettings();
  // Phase 14: the active lesson's scenarios are pinned on top and ignore the level filter.
  // Phase 21: the catch-up lessons' scenarios follow (all from the study focus; lessons found by n).
  const pinnedIds: string[] =
    studyFocus?.enabled && studyFocus.activeLesson && textbookState.status === 'ready'
      ? [studyFocus.activeLesson, ...studyFocus.reviewLessons].flatMap(
          (l) => textbookState.books.find((b) => b.id === l.bookId)?.lessons.find((x) => x.n === l.n)?.scenarios ?? [],
        )
      : [];
  const [cardsByWordId, setCardsByWordId] = useState<Map<string, SkillCard>>(new Map());
  const refreshCards = useCallback(async () => {
    setCardsByWordId(await recognitionCardsByWordId(db));
  }, []);
  useEffect(() => {
    refreshCards();
  }, [refreshCards]);

  // Phase 7: the one global "My level" (header picker), not a local copy.
  const { level: learnerLevel } = useCurrentLevel();
  // Per-screen scenario filter; follows the global level until the learner
  // picks chips themselves, and never writes back to it.
  const [levelFilter, setLevelFilter] = useState<Level[]>([learnerLevel]);
  useEffect(() => setLevelFilter([learnerLevel]), [learnerLevel]);

  // Dev-only escape hatch: this sandbox has no real Gemini/OpenAI keys, so
  // the proxy's DisabledAdapter will reject every real turn. Flip to the
  // fake tutor to exercise the rest of the chat UI without a live LLM.
  const [useFakeLLM, setUseFakeLLM] = useState(false);
  const tutorLLM = useMemo(
    () => (useFakeLLM ? new FakeTutorLLM() : new FetchTutorLLM()),
    [useFakeLLM],
  );

  const chatService = useMemo(() => {
    if (lexiconState.status !== 'ready') return null;
    return new ChatService(
      db,
      lexiconState.lexicon,
      learnerService,
      tutorLLM,
      undefined,
      undefined,
      (c) => gameService.onScenarioCompleted(c),
      // Phase 12: read fresh each turn, so changing the class lesson applies at once.
      () =>
        textbookState.status === 'ready'
          ? { scope: currentClassScope(), books: textbookState.books }
          : undefined,
      getStudyFocusNow,
    );
  }, [lexiconState, tutorLLM, textbookState]);

  // Phase 6: the scenario map (stars, unlocks, real-world coverage), refreshed
  // whenever we return to the picker.
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [mapKey, setMapKey] = useState(0);
  useEffect(() => {
    if (lexiconState.status !== 'ready' || scenariosState.status !== 'ready') return;
    let cancelled = false;
    loadGameSnapshot(
      db,
      lexiconState.lexicon,
      scenariosState.scenarios,
      new Date(),
      undefined,
      learnerLevel,
    ).then((snap) => {
      if (!cancelled) setSnapshot(snap);
    });
    return () => {
      cancelled = true;
    };
  }, [lexiconState, scenariosState, mapKey, learnerLevel]);

  // Phase 18: Open chat is its own mode next to the scenarios.
  const [openChat, setOpenChat] = useState(false);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [conversation, setConversation] = useState<ConversationRow | null>(null);
  const [turns, setTurns] = useState<TurnRow[]>([]);
  // Phone layout: messages scroll inside the screen with the composer pinned
  // below. The latest message stays in view when a turn arrives and when the
  // on-screen keyboard opens (which shrinks the visible area).
  const scrollRef = useRef<HTMLDivElement>(null);
  const keyboardOpen = useKeyboardOpen();
  // Phase 8: per profile (stored in the profile's database).
  const [scaffolding, setScaffolding] = useSetting<Scaffolding>('chatScaffolding', 'high');
  const [englishFallback, setEnglishFallback] = useSetting('chatEnglishFallback', false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookedUpByTurnId, setLookedUpByTurnId] = useState<Map<number, Set<string>>>(new Map());
  const [stuckLevel, setStuckLevel] = useState(0);
  const [ended, setEnded] = useState(false);
  const [summary, setSummary] = useState<ChatSummary | null>(null);

  const refresh = useCallback(
    async (cid: number) => {
      if (!chatService) return;
      const [t, conv] = await Promise.all([chatService.getTurns(cid), db.conversations.get(cid)]);
      setTurns(t);
      setConversation(conv ?? null);
    },
    [chatService],
  );

  async function startScenario(s: Scenario) {
    if (!chatService) return;
    setError(null);
    setSummary(null);
    setEnded(false);
    setStuckLevel(0);
    setLookedUpByTurnId(new Map());
    const cid = await chatService.startConversation(s);
    setScenario(s);
    setConversationId(cid);
    await refresh(cid);
  }

  function backToScenarios() {
    if (onExit) {
      onExit();
      return;
    }
    setMapKey((k) => k + 1);
    setScenario(null);
    setConversationId(null);
    setConversation(null);
    setTurns([]);
    setSummary(null);
    setEnded(false);
    setError(null);
  }

  const autoStarted = useRef(false);
  useEffect(() => {
    if (
      !initialScenarioId ||
      autoStarted.current ||
      !chatService ||
      scenariosState.status !== 'ready'
    )
      return;
    const s = scenariosState.scenarios.find((x) => x.id === initialScenarioId);
    if (!s) return;
    autoStarted.current = true;
    void startScenario(s);
  }, [initialScenarioId, chatService, scenariosState]);

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

  const lastNpcTurn = [...turns].reverse().find((t) => t.role === 'npc');
  const suggestions = lastNpcTurn?.suggestedReplies ?? [];
  const visibleSuggestions = suggestions.slice(0, SUGGESTED_REPLY_CAP[scaffolding]);

  async function sendMessage() {
    if (!chatService || !scenario || conversationId === null || sending) return;
    const text = input.trim();
    if (!text) return;

    setSending(true);
    setError(null);
    try {
      if (lastNpcTurn?.id !== undefined) {
        const lookedUp = lookedUpByTurnId.get(lastNpcTurn.id) ?? new Set<string>();
        await chatService.recordNoLookupEvidence(lastNpcTurn.zh, lookedUp);
      }
      setInput('');
      setStuckLevel(0);
      await chatService.sendLearnerTurn(conversationId, scenario, text, {
        learnerLevel,
        scaffolding,
        englishFallback,
      });
      await refresh(conversationId);

      const completed = await chatService.maybeCompleteConversation(conversationId, scenario);
      if (completed) {
        await refresh(conversationId);
        setEnded(true);
        setSummary(await chatService.getSummary(conversationId));
      }
      await refreshCards();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refresh(conversationId); // the learner's own message is already persisted even if the reply failed
    } finally {
      setSending(false);
    }
  }

  async function endNow() {
    if (!chatService || conversationId === null) return;
    await chatService.endConversation(conversationId);
    setEnded(true);
    setSummary(await chatService.getSummary(conversationId));
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, keyboardOpen, sending]);
  // The scroll area shrinks when the keyboard opens (and grows when it closes):
  // keep the newest message in view through that, as long as the learner hadn't
  // scrolled up to read older ones.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastHeight = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const nearBottom = el.scrollHeight - el.scrollTop - lastHeight < 80;
      lastHeight = el.clientHeight;
      if (nearBottom) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [conversationId]);

  if (lexiconState.status === 'loading' || scenariosState.status === 'loading')
    return <p>Loading…</p>;
  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;
  if (scenariosState.status === 'error') {
    return (
      <p>
        Failed to load scenarios: {scenariosState.error}. Run <code>pnpm pipeline:build</code> then{' '}
        <code>pnpm --filter @anan/web sync:scenarios</code>.
      </p>
    );
  }

  if (openChat && lexiconState.status === 'ready') {
    return (
      <OpenChatView
        lexicon={lexiconState.lexicon}
        tutorLLM={tutorLLM}
        chatService={chatService}
        books={textbookState.status === 'ready' ? textbookState.books : []}
        learnerLevel={learnerLevel}
        cardsByWordId={cardsByWordId}
        refreshCards={refreshCards}
        onExit={() => setOpenChat(false)}
      />
    );
  }

  if (!scenario || conversationId === null) {
    return (
      <div className="chat-page">
        <h1>An'an chat</h1>
        <p className="chat-level-note">
          {YOUR_LEVEL}: {levelShort(learnerLevel)}
        </p>
        <LevelChips selected={levelFilter} onChange={setLevelFilter} current={learnerLevel} />
        <div className="open-chat-entry">
          <OpenChatEntryCard onOpen={() => setOpenChat(true)} />
        </div>
        {pinnedIds.length > 0 && (
          <section className="chat-pinned-section" aria-label="Current lesson" data-testid="pinned-scenarios">
            <h2 lang="zh-Hant">
              {CURRENT_LESSON}: {studyFocus?.activeLesson ? stepName(studyFocus.activeLesson) : ''}
            </h2>
            <div className="chat-scenario-list">
              {scenariosState.scenarios
                .filter((sc) => pinnedIds.includes(sc.id))
                .map((sc) => (
                  <button
                    key={sc.id}
                    className="chat-scenario-card"
                    onClick={() => startScenario(sc)}
                    data-testid={`pinned-${sc.id}`}
                  >
                    <div className="chat-scenario-title">{sc.title}</div>
                    <div className="chat-scenario-range">Current lesson</div>
                  </button>
                ))}
            </div>
          </section>
        )}
        <div className="chat-scenario-list">
          {(
            snapshot?.nodes ??
            scenariosState.scenarios.map((sc) => ({
              scenario: sc,
              unlocked: true,
              stars: null,
              attempts: 0,
              bestUnassistedMs: undefined,
            }))
          )
            // Textbook scenarios are governed by "My class", never by the level picker.
            .filter((node) => !node.scenario.textbook)
            .filter((node) => scenarioMatchesLevels(node.scenario, levelFilter))
            .map((node) => {
              const s = node.scenario;
              const coverage = snapshot?.coverage.get(s.id);
              return (
                <button
                  key={s.id}
                  className="chat-scenario-card"
                  disabled={!node.unlocked}
                  onClick={() => startScenario(s)}
                  title={node.unlocked ? undefined : `Unlocks when you reach ${s.levelRange.min}`}
                >
                  <div className="chat-scenario-title">{s.title}</div>
                  <div className="chat-scenario-range">
                    {s.levelRange.min}–{s.levelRange.max}
                    {!node.unlocked && ' · 🔒 locked'}
                  </div>
                  {node.stars && (
                    <div className="chat-stars" aria-label={`${node.stars.count} of 3 stars`}>
                      <span title="Completed">{node.stars.completed ? '★' : '☆'}</span>
                      <span title="Completed without “I'm stuck”">
                        {node.stars.noStuck ? '★' : '☆'}
                      </span>
                      <span title="Completed with no English fallback">
                        {node.stars.noEnglish ? '★' : '☆'}
                      </span>
                      {node.bestUnassistedMs !== undefined && (
                        <span className="chat-best-time">
                          {' '}
                          best unassisted {formatDuration(node.bestUnassistedMs)}
                        </span>
                      )}
                    </div>
                  )}
                  {coverage && node.unlocked && (
                    <div className="chat-coverage">
                      {coverageLine(coverage.coverage)}
                    </div>
                  )}
                </button>
              );
            })}
        </div>
        {myClass.enabled && (
          <section className="chat-class-section" aria-label="My class scenarios">
            <h2 lang="zh-Hant">
              {yourClassLabel(myClass.currentLesson, myClass.textbookId)}
            </h2>
            <p className="chat-level-note" data-testid="class-level-hint">
              {classLevelHint(myClass.textbookId, myClass.currentLesson)}
            </p>
            <div className="chat-scenario-list">
              {classScenarios(scenariosState.scenarios, myClass, learnerLevel, new Set(pinnedIds)).map((sc) => {
                  // Phase 21: open once the class has reached the lesson (the shared class scope; a
                  // preview lesson's scenarios are pinned above while it is the study lesson).
                  const unlocked =
                    scope.enabled &&
                    (courseOrdinal(LAIXUE_COURSE, sc.textbook!.textbookId, sc.textbook!.lesson) ?? Infinity) <=
                      scope.courseOrdinal;
                  return (
                    <button
                      key={sc.id}
                      className="chat-scenario-card"
                      disabled={!unlocked}
                      onClick={() => startScenario(sc)}
                      title={
                        unlocked
                          ? undefined
                          : `Unlocks when the class reaches ${lessonLabel(sc.textbook!.lesson, sc.textbook!.textbookId)}`
                      }
                      data-testid={`class-scenario-${sc.id}`}
                    >
                      <div className="chat-scenario-title">{sc.title}</div>
                      <div className="chat-scenario-range">
                        <span className="textbook-badge" lang="zh-Hant">
                          {lessonLabel(sc.textbook!.lesson, sc.textbook!.textbookId)}
                        </span>
                        {!unlocked && ' · 🔒 locked'}
                      </div>
                    </button>
                  );
                })}
            </div>
          </section>
        )}
        {import.meta.env.DEV && (
          <label className="chat-dev-toggle">
            <input
              type="checkbox"
              checked={useFakeLLM}
              onChange={(e) => setUseFakeLLM(e.target.checked)}
            />
            Use fake tutor (dev, no API key needed)
          </label>
        )}
      </div>
    );
  }

  return (
    <div className="chat-page chat-page--convo">
      <div className="chat-header">
        <button onClick={backToScenarios}>{BACK_TO_CHATS}</button>
        <h1>{scenario.title}</h1>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        <GoalChecklist scenario={scenario} conversation={conversation} />

        <div className="chat-messages">
          {turns.map((turn) => {
            const annotated = withReadingDisplay(
              annotate(
                turn.zh,
                lexiconState.lexicon,
                // Phase 7: the model's per-token sense picks (validated when stored).
                new Map(
                  (turn.tokens ?? []).flatMap((t) =>
                    t.sense_id ? [[t.text, t.sense_id] as const] : [],
                  ),
                ),
                { textbook: Boolean(scenario.textbook) },
              ),
              cardsByWordId,
            );
            return (
              <div key={turn.id} className={`chat-bubble chat-bubble--${turn.role}`}>
                {turn.recastZh && (
                  <div className="chat-recast">
                    You could say:{' '}
                    <AnnotatedInline text={turn.recastZh} lexicon={lexiconState.lexicon} script={script} />
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
                  <div className="open-chat-glosses" data-testid="chat-glosses">
                    {turn.glosses.map((g) => (
                      <span key={g.text} className="open-chat-gloss">
                        <span lang="zh-Hant">{g.text}</span> = {g.gloss}
                      </span>
                    ))}
                  </div>
                )}
                {englishFallback && turn.en && <div className="chat-en">{turn.en}</div>}
                {import.meta.env.DEV && turn.validatorReport && (
                  <div className="chat-debug">
                    coverage {(turn.validatorReport.coverage * 100).toFixed(0)}% · max{' '}
                    {turn.validatorReport.maxLevel ?? '—'} · unknown{' '}
                    {turn.validatorReport.unknownCount} · attempts {turn.validatorReport.attempts} ·{' '}
                    {turn.validatorReport.pass ? 'passed' : 'FAILED (shown anyway)'}
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

        {ended && summary && (
          <ChatSummaryPanel
            scenario={scenario}
            summary={summary}
            learnerTurns={turns.filter((t) => t.role === 'learner').length}
            lexicon={lexiconState.lexicon}
          />
        )}
      </div>

      {!ended && (
        <div className="chat-composer">
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
              <AnnotatedInline text={input} lexicon={lexiconState.lexicon} script={script} />
            </p>
          )}
          <div className="chat-input-row">
            <input
              className="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
              placeholder={englishFallback ? '中文 or English…' : '輸入中文…'}
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
                if (chatService && conversationId !== null)
                  void chatService.recordStuck(conversationId);
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
                {SCAFFOLDING_LEVELS.map((s) => (
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
            <button onClick={endNow}>{END_CHAT}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function GoalChecklist({
  scenario,
  conversation,
}: {
  scenario: Scenario;
  conversation: ConversationRow | null;
}) {
  const done = new Set(conversation?.goalStepsDone ?? []);
  return (
    <ul className="chat-goals">
      {scenario.goalSteps.map((step) => (
        <li key={step.id} className={done.has(step.id) ? 'chat-goal--done' : ''}>
          {done.has(step.id) ? '✓' : '○'} {step.description}
        </li>
      ))}
    </ul>
  );
}

function ChatSummaryPanel({
  scenario,
  summary,
  learnerTurns,
  lexicon,
}: {
  scenario: Scenario;
  summary: ChatSummary;
  learnerTurns: number;
  lexicon: Lexicon;
}) {
  const { script } = useReadingSettings();
  return (
    <div className="chat-summary">
      <h2>{CHAT_FINISHED}</h2>
      <p>{scenario.successLine.en}</p>
      <ul>
        <li>{messagesFromYou(learnerTurns)}</li>
        <li>{coverageLine(summary.avgCoverage)}</li>
        <li>
          {summary.goalStepsDone.length}/{scenario.goalSteps.length} goals completed
        </li>
      </ul>
      {summary.wordsEncountered.length > 0 && (
        <>
          <h3>Words you met</h3>
          <p className="chat-summary-words" lang="zh-Hant">
            <AnnotatedInline text={summary.wordsEncountered.join('、')} lexicon={lexicon} script={script} />
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Phase 13: the class section lists the textbook scenarios of every book up to
 * the class position (earlier books count as covered) plus the rest of the
 * current book (locked). The header level picker filters them like everything
 * else: your level first, easier below, harder hidden.
 */
function classScenarios(
  all: readonly Scenario[],
  klass: { textbookId: string; currentLesson: number },
  chosen: Level,
  /** Scenarios of the active study step: shown whatever the level picker says. */
  keep: ReadonlySet<string> = new Set(),
): Scenario[] {
  const here = courseOrdinal(LAIXUE_COURSE, klass.textbookId, klass.currentLesson) ?? 0;
  const ord = (sc: Scenario) =>
    courseOrdinal(LAIXUE_COURSE, sc.textbook!.textbookId, sc.textbook!.lesson) ?? 99;
  const visible = all
    .filter((sc) => sc.textbook)
    .filter((sc) => ord(sc) <= here || sc.textbook!.textbookId === klass.textbookId)
    .sort((a, b) => ord(a) - ord(b));
  const filtered = filterByLevel(
    visible,
    (sc) => courseLessonLevel(LAIXUE_COURSE, sc.textbook!.textbookId, sc.textbook!.lesson),
    chosen,
  );
  return visible
    .filter((sc) => keep.has(sc.id) || filtered.includes(sc))
    .sort((a, b) => Number(keep.has(b.id)) - Number(keep.has(a.id)) || filtered.indexOf(a) - filtered.indexOf(b));
}
