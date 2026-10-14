// Phase 39: tutoring classes. Upload the summary PDF a tutor sends after a class, check what was read
// (Part C), Save, and the class becomes a lesson-like page. Phase 40: the same depth as a textbook
// lesson (Vocab, Grammar, Listening, Chat, Journal, Story), each word with its level, topics, 🔊 and
// card faces; the words are in review the moment the class is saved ("Review these N words now").
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  displayLevel,
  glossFor,
  isEstimatedLevel,
  levelShort,
  tutorJournalPrompt,
  tutorLessonOf,
  type Ledger,
  type Level,
  type Lexicon,
  type SkillCard,
  type TopicTag,
  type TutorDraft,
  type TutorDraftSentence,
} from '@anan/core';
import { SpeakerButton } from '../components/SpeakerButton.js';
import { useListeningClips, useListeningEnabled } from '../lib/listening.js';
import { JournalPage } from './JournalPage.js';
import { ListenPage } from './ListenPage.js';
import { learnerService } from '../db/instance.js';
import type { TutorSessionRow } from '../db/schema.js';
import { LearnedMastered } from '../components/LearnedMastered.js';
import { AnnotatedInline, useReadingScript } from '../components/AnnotatedInline.js';
import { GrammarDots } from '../components/GrammarDots.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { getLedgerNow, useLedger } from '../lib/ledger.js';
import { saveProgressNow } from '../lib/save-progress.js';
import { canWriteStories } from '../lib/stories.js';
import { aiErrorText, ProxyTurnError } from '../lib/tutor-llm.js';
import { useLexicon } from '../lib/useLexicon.js';
import {
  appTutoringService,
  getPendingDraft,
  setPendingDraft,
  takePendingTutorClass,
} from '../lib/tutoring/app-service.js';
import { ensureTutorCards } from '../lib/tutoring/introduce.js';
import { pdfToPageImages } from '../lib/tutoring/pdf-pages.js';
import { notifyTutorSessionsChanged, useTutorSessions } from '../lib/tutoring/useTutorSessions.js';
import { useTutorSpeechState } from '../lib/tutoring/tutor-audio.js';
import type { DraftResult } from '../lib/tutoring/tutoring-service.js';
import {
  AUDIO_FAILED,
  AUDIO_WAITING_KEY,
  DISCARD,
  estimatedLevelLabel,
  FACE_NAMES,
  notesMainlandLine,
  alsoSaidLine,
  reviewTheseNow,
  topicName,
  tutorAudioLine,
  NEXT,
  NOT_PRACTISED,
  NOTE_ONLY,
  notesSaid,
  READING_NOTES,
  TUTOR_EXTRACT_FAILED,
  SAVE,
  STUDY_THIS_CLASS,
  TUTOR_NO_CLASSES,
  TUTOR_STATUS,
  TUTOR_UPDATES_EXISTING,
  TUTORING,
  tutorAddedLine,
  tutorClassTitle,
  UPLOAD_CLASS_SUMMARY,
} from '../lib/labels.js';
import { ChatPage } from './ChatPage.js';
import { GrammarExerciseCard, useSingleGrammarExercise } from './GrammarStep.js';
import { ReviewPage } from './ReviewPage.js';
import { StoryStep } from './TextbookPage.js';
import './TextbookPage.css';
import './TutoringPage.css';

type View =
  | { kind: 'list' }
  | { kind: 'check' }
  | { kind: 'class'; id: string }
  | { kind: 'study'; id: string }
  | { kind: 'now'; id: string };

export function TutoringPage() {
  const lexiconState = useLexicon();
  const rows = useTutorSessions();
  const [view, setView] = useState<View>(() => {
    const id = takePendingTutorClass();
    if (id) return { kind: 'class', id };
    return getPendingDraft() ? { kind: 'check' } : { kind: 'list' };
  });
  const [note, setNote] = useState<string | null>(null);

  if (lexiconState.status === 'loading' || !rows) return <p>Loading…</p>;
  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;
  const lexicon = lexiconState.lexicon;

  if (view.kind === 'check') {
    const pending = getPendingDraft();
    if (!pending) return <TutoringList rows={rows} lexicon={lexicon} onOpen={(id) => setView({ kind: 'class', id })} onDraft={() => setView({ kind: 'check' })} />;
    return (
      <TutorCheckScreen
        pending={pending}
        lexicon={lexicon}
        onDiscard={() => {
          setPendingDraft(undefined);
          setView({ kind: 'list' });
        }}
        onSaved={(rec, introduced) => {
          setPendingDraft(undefined);
          notifyTutorSessionsChanged();
          setNote(tutorAddedLine(introduced));
          setView({ kind: 'class', id: rec.id });
        }}
      />
    );
  }
  const rec = view.kind !== 'list' ? rows.find((r) => r.id === view.id) : undefined;
  if (rec && view.kind === 'now') return <TutorReviewNow rec={rec} onExit={() => setView({ kind: 'class', id: rec.id })} />;
  if (rec && view.kind === 'study')
    return <TutorStudy rec={rec} lexicon={lexicon} onExit={() => setView({ kind: 'class', id: rec.id })} />;
  if (rec)
    return (
      <TutorClassPage
        rec={rec}
        lexicon={lexicon}
        note={note}
        onBack={() => {
          setNote(null);
          setView({ kind: 'list' });
        }}
        onStudy={() => setView({ kind: 'study', id: rec.id })}
        onReviewNow={() => setView({ kind: 'now', id: rec.id })}
      />
    );
  return <TutoringList rows={rows} lexicon={lexicon} onOpen={(id) => setView({ kind: 'class', id })} onDraft={() => setView({ kind: 'check' })} />;
}

/** The list of classes and the upload (also on the Textbook page, as its Tutoring section). */
export function TutoringList({
  rows,
  lexicon,
  onOpen,
  onDraft,
  embedded = false,
}: {
  rows: readonly TutorSessionRow[];
  lexicon: Lexicon;
  onOpen: (id: string) => void;
  onDraft: () => void;
  embedded?: boolean;
}) {
  const ledger = useLedger();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Heading = embedded ? 'h2' : 'h1';

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      let pages;
      try {
        pages = await pdfToPageImages(file);
      } catch {
        throw new Error("Couldn't read that PDF. Is it the class summary file?");
      }
      if (pages.length === 0) throw new Error('That PDF has no pages.');
      // The page images go to the proxy once and are dropped here (never stored).
      const result = await appTutoringService(lexicon).draftFromPages(pages);
      setPendingDraft(result);
      onDraft();
    } catch (err) {
      setError(err instanceof ProxyTurnError && !err.quota ? TUTOR_EXTRACT_FAILED : aiErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={embedded ? 'tutoring tutoring--embedded' : 'textbook-page tutoring'} aria-label={TUTORING} id="tutoring">
      <Heading>{TUTORING}</Heading>
      <label className="tutoring-upload">
        <span>{busy ? READING_NOTES : UPLOAD_CLASS_SUMMARY}</span>
        <input
          type="file"
          accept="application/pdf"
          disabled={busy}
          data-testid="tutor-upload"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void upload(file);
          }}
        />
      </label>
      {busy && (
        <p role="status" aria-busy="true" className="textbook-muted">
          {READING_NOTES}
        </p>
      )}
      {error && (
        <p role="alert" data-testid="tutor-upload-error">
          {error}
        </p>
      )}
      {getPendingDraft() && !busy && (
        <p>
          <button type="button" onClick={onDraft} data-testid="tutor-open-draft">
            Check the class you uploaded →
          </button>
        </p>
      )}
      {rows.length === 0 ? (
        <p className="textbook-muted">{TUTOR_NO_CLASSES}</p>
      ) : (
        <ol className="textbook-path" data-testid="tutor-classes">
          {rows.map((r) => {
            const p = ledger?.tutorSession(tutorLessonOf(r));
            return (
              <li key={r.id} className="textbook-lesson" data-testid="tutor-class">
                <button type="button" className="textbook-lesson-btn" onClick={() => onOpen(r.id)}>
                  <span className="textbook-lesson-title">
                    <span>{tutorClassTitle(r.tutor, r.date)}</span>
                    <small>
                      {r.topics.map((t) => t.en).join(' · ')}
                    </small>
                  </span>
                </button>
                {p && (
                  <div className="textbook-progress" aria-label="Class progress">
                    <LearnedMastered p={p} compact />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Part C: the check screen. Nothing is introduced or created before Save.
// ---------------------------------------------------------------------------

/** Phase 40 Part B: tutors whose "This tutor is from Taiwan" is off (lower-case names). */
/** A word's shown level: its official one, else an estimate (lexicon, custom word or the model). */
function draftLevel(
  w: { wordId: string; custom?: { level: Level | null; estimatedLevel?: Level } | boolean; estimatedLevel?: Level },
  lexicon: Lexicon,
): { level: Level; estimated: boolean } | undefined {
  const word = lexicon.byId(w.wordId) ?? (typeof w.custom === 'object' ? w.custom : undefined);
  const lv = word ? displayLevel(word) : null;
  if (word && lv) return { level: lv, estimated: isEstimatedLevel(word) };
  return w.estimatedLevel ? { level: w.estimatedLevel, estimated: true } : undefined;
}

function LevelChip({ level }: { level: { level: Level; estimated: boolean } | undefined }) {
  if (!level) return null;
  return (
    <span className="textbook-chip textbook-chip--soft" data-testid="tutor-word-level">
      {level.estimated ? estimatedLevelLabel(level.level) : levelShort(level.level)}
    </span>
  );
}

function TopicChips({ tags }: { tags: readonly TopicTag[] }) {
  return (
    <p className="tutoring-chips" data-testid="tutor-topics">
      {tags.map((t) => (
        <span key={t} className="textbook-chip textbook-chip--soft">
          {topicName(t)}
        </span>
      ))}
    </p>
  );
}

function SentenceLine({ s }: { s: TutorDraftSentence }) {
  if (!s.zh) return null;
  return (
    <p className="tutoring-example">
      <span lang="zh-Hant">{s.zh}</span>
      {s.fixed && <small className="textbook-muted"> (fixed by the check)</small>}
      <br />
      <small className="textbook-muted">
        {s.en}
        {!s.practice && ` · ${NOT_PRACTISED}${s.reason ? `: ${s.reason}` : ''}`}
      </small>
    </p>
  );
}

function TutorCheckScreen({
  pending,
  lexicon,
  onDiscard,
  onSaved,
}: {
  pending: DraftResult;
  lexicon: Lexicon;
  onDiscard: () => void;
  onSaved: (rec: TutorSessionRow, introduced: number) => void;
}) {
  const { level } = useCurrentLevel();
  const [draft, setDraft] = useState<TutorDraft>(pending.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticked = draft.words.filter((w) => w.ticked).length;

  function toggle(key: string) {
    const next = { ...draft, words: draft.words.map((w) => (w.key === key ? { ...w, ticked: !w.ticked } : w)) };
    setDraft(next);
    setPendingDraft({ ...pending, draft: next });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { record, introduced, audio } = await appTutoringService(lexicon).save(draft, level);
      saveProgressNow();
      void audio
        .then(() => {
          saveProgressNow();
          notifyTutorSessionsChanged();
        }).catch(() => undefined);
      onSaved(record, introduced);
    } catch (err) {
      setError(aiErrorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="textbook-page tutoring-check" data-testid="tutor-check">
      <h1>{tutorClassTitle(draft.tutor, draft.date)}</h1>
      {draft.topics.length > 0 && (
        <p className="textbook-muted">
          {draft.topics.map((t, i) => (
            <span key={i}>
              {i > 0 && ' · '}
              <span lang="zh-Hant">{t.zh}</span> {t.en}
            </span>
          ))}
        </p>
      )}
      {pending.existing && <p role="status">{TUTOR_UPDATES_EXISTING}</p>}

      {draft.topicTags.length > 0 && <TopicChips tags={draft.topicTags} />}

      <h2>Words ({draft.words.length})</h2>
      <p className="textbook-muted">
        Ticked words ({ticked}) are in your review the moment you save, with every card face, ahead of everything else.
      </p>
      <ul className="tutoring-words">
        {draft.words.map((w) => (
          <li
            key={w.key}
            data-testid="tutor-word"
            data-status={w.statuses.join(' ')}
          >
            <label className="tutoring-word">
              <input type="checkbox" checked={w.ticked} onChange={() => toggle(w.key)} aria-label={`Study ${w.zh}`} />
              <span className="tutoring-word-main">
                <span className="tutoring-zh" lang="zh-Hant">
                  {w.zh}
                </span>{' '}
                <span>{w.pinyin}</span> <span className="textbook-muted">{w.zhuyin}</span>
                {w.pinyinNote && <small className="textbook-muted"> ({notesSaid(w.pinyinNote)})</small>}
                <br />
                <span>{w.gloss}</span>
                {w.notesGloss && <small className="textbook-muted"> · also: {w.notesGloss}</small>}
                {w.mainlandForm && (
                  <small className="textbook-muted" data-testid="tutor-notes-mainland">
                    <br />
                    <span lang="zh-Hant">{notesMainlandLine(w.printed, [w.zh, ...(w.alsoTaiwan ?? [])])}</span>
                  </small>
                )}
                {w.alsoSaid && (
                  <small className="textbook-muted">
                    {' · '}
                    <span lang="zh-Hant">{alsoSaidLine(w.alsoSaid)}</span>
                  </small>
                )}
              </span>
              <span className="tutoring-chips">
                <LevelChip level={draftLevel(w, lexicon)} />
                {w.statuses.map((s) => (
                    <span key={s} className={`textbook-chip textbook-chip--soft tutoring-chip--${s}`}>
                      {TUTOR_STATUS[s]}
                    </span>
                  ))}
              </span>
            </label>
            <SentenceLine s={w.example} />
          </li>
        ))}
      </ul>

      <h2>Grammar ({draft.grammar.length})</h2>
      <ul className="tutoring-grammar">
        {draft.grammar.map((g) => (
          <li key={g.key} data-testid="tutor-grammar" data-matched={g.matchId ? 'yes' : 'no'}>
            <strong lang="zh-Hant">{g.name}</strong>{' '}
            {g.matchId ? (
              <span className="textbook-chip textbook-chip--soft">
                → <span lang="zh-Hant">{g.matchPattern}</span>
              </span>
            ) : (
              <span className="textbook-chip textbook-chip--soft">{NOTE_ONLY}</span>
            )}
            <br />
            <small>{g.explanationEn}</small>
            <SentenceLine s={g.example} />
          </li>
        ))}
      </ul>

      {error && <p role="alert">{error}</p>}
      <div className="tutoring-actions">
        <button type="button" className="btn-primary" disabled={busy} aria-busy={busy} onClick={() => void save()} data-testid="tutor-save">
          {busy ? 'Saving…' : SAVE}
        </button>{' '}
        <button type="button" disabled={busy} onClick={onDiscard} data-testid="tutor-discard">
          {DISCARD}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Part D: a saved class, lesson-like.
// ---------------------------------------------------------------------------

function TutorClassPage({
  rec,
  lexicon,
  note,
  onBack,
  onStudy,
  onReviewNow,
}: {
  rec: TutorSessionRow;
  lexicon: Lexicon;
  note: string | null;
  onBack: () => void;
  onStudy: () => void;
  onReviewNow: () => void;
}) {
  const ledger = useLedger();
  const script = useReadingScript();
  const clips = useListeningClips();
  const p = ledger?.tutorSession(tutorLessonOf(rec));
  const nowCards = ledger?.tutorClassNow(rec.id) ?? [];
  const nowWords = new Set(nowCards.map((c) => c.item.id)).size;
  // Phase 40: faces a class saved before Phase 40 is missing join now (Save does this for new ones).
  useEffect(() => {
    void ensureTutorCards().catch(() => 0);
  }, [rec.id]);
  // Part D.1: a class with no clips yet (saved before Phase 40, or the speech key came later) asks once.
  const speech = useTutorSpeechState();
  const askedAudio = useRef(new Set<string>());
  useEffect(() => {
    if (speech !== 'configured' || askedAudio.current.has(rec.id)) return;
    if (rec.audio && rec.audio.status === 'ok') return;
    askedAudio.current.add(rec.id);
    void appTutoringService(lexicon)
      .withAudio(rec)
      .then(() => notifyTutorSessionsChanged())
      .catch(() => undefined);
  }, [rec, speech, lexicon]);
  const sentenceFor = (pred: (s: TutorSessionRow['sentences'][number]) => boolean) => rec.sentences.find(pred);
  return (
    <div className="textbook-page" data-testid="tutor-class-page">
      <button type="button" onClick={onBack}>
        ← {TUTORING}
      </button>
      <h1>{tutorClassTitle(rec.tutor, rec.date)}</h1>
      <p className="textbook-muted">{rec.topics.map((t) => `${t.zh} ${t.en}`).join(' · ')}</p>
      {rec.topicTags && rec.topicTags.length > 0 && <TopicChips tags={rec.topicTags} />}
      {note && <p role="status">{note}</p>}
      {p && (
        <div className="textbook-progress" aria-label="Class progress" data-testid="tutor-class-progress">
          <LearnedMastered p={p} compact />
        </div>
      )}
      {nowWords > 0 && (
        <button type="button" className="btn-primary" onClick={onReviewNow} data-testid="tutor-review-now">
          {reviewTheseNow(nowWords)}
        </button>
      )}{' '}
      <button type="button" className="textbook-study-btn" onClick={onStudy} data-testid="study-tutor-class">
        {STUDY_THIS_CLASS}
      </button>
      <AudioLine rec={rec} speech={speech} />

      <h2>Words ({rec.words.filter((w) => w.ticked).length})</h2>
      <ul className="textbook-words">
        {rec.words
          .filter((w) => w.ticked)
          .map((w) => {
            const word = lexicon.byId(w.wordId);
            const ex = sentenceFor((s) => s.wordId === w.wordId);
            return (
              <li key={w.wordId} data-testid="tutor-class-word">
                <span lang="zh-Hant">{w.zh}</span> {w.pinyin} <SpeakerButton kind="word" id={w.wordId} />{' '}
                <LevelChip level={draftLevel(w, lexicon)} />{' '}
                <span className="textbook-muted">{word ? glossFor(word) : w.gloss}</span>
                {w.mainlandForm && (
                  <small className="textbook-muted">
                    {' '}
                    (<span lang="zh-Hant">{notesMainlandLine(w.printed, [w.zh, ...(w.alsoTaiwan ?? [])])}</span>)
                  </small>
                )}
                {ledger && <WordFaces ledger={ledger} wordId={w.wordId} hasClip={clips.hasClip('word', w.wordId)} />}
                {ex && (
                  <p className="tutoring-example">
                    <span lang="zh-Hant">
                      <AnnotatedInline text={ex.zh} lexicon={lexicon} script={script} />
                    </span>{' '}
                    <SpeakerButton kind="sentence" id={ex.id} text={ex.zh} />
                    <br />
                    <small className="textbook-muted">{ex.en}</small>
                  </p>
                )}
              </li>
            );
          })}
      </ul>

      <h2>Grammar ({rec.grammar.length})</h2>
      {rec.grammar.map((g, i) => {
        const item = g.grammarId ? lexicon.grammarItemById(g.grammarId) : undefined;
        return (
          <article key={i} className="textbook-grammar" data-testid={item ? 'tutor-grammar-point' : 'tutor-grammar-note'}>
            <h3>
              <span lang="zh-Hant">{item?.pattern ?? g.name}</span>{' '}
              {item ? <GrammarDots dots={ledger?.item({ kind: 'grammar', id: item.id }).dots ?? 0} /> : <small className="textbook-muted">{NOTE_ONLY}</small>}
            </h3>
            <p>{g.explanationEn || item?.explanationEn}</p>
            {g.example.zh && (
              <p className="textbook-example">
                <span lang="zh-Hant">
                  <AnnotatedInline text={g.example.zh} lexicon={lexicon} script={script} />
                </span>
                <br />
                <small className="textbook-muted">{g.example.en}</small>
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

/** Phase 40 Part D.1: what the server said about the class's clips. */
function AudioLine({ rec, speech }: { rec: TutorSessionRow; speech: 'unknown' | 'configured' | 'not_configured' }) {
  if (!rec.audio && speech !== 'not_configured') return null;
  const text =
    !rec.audio || rec.audio.status === 'waiting_key' ? AUDIO_WAITING_KEY : rec.audio.status === 'error' ? AUDIO_FAILED : tutorAudioLine(rec.audio.made ?? 0);
  return (
    <p className="textbook-muted" data-testid="tutor-audio-status">
      {text}
    </p>
  );
}

/** Phase 40 Part D.5: "Meaning ✓ · Pick · Recall ✓ · Say it · Listening", from the ledger. */
function WordFaces({ ledger, wordId, hasClip }: { ledger: Ledger; wordId: string; hasClip: boolean }) {
  const faces = ledger.wordFaces(wordId).filter((f) => f.carded || (f.skill === 'listening' && hasClip));
  if (faces.length === 0) return null;
  return (
    <small className="textbook-muted tutoring-faces" data-testid="tutor-word-faces">
      {' · '}
      {faces.map((f, i) => (
        <span key={f.skill} data-face={f.skill} data-answered={f.answered ? 'yes' : 'no'}>
          {i > 0 && ' · '}
          {FACE_NAMES[f.skill]}
          {f.learned ? ' ✓' : ''}
        </span>
      ))}
    </small>
  );
}

/** Phase 40 Part E.1: this class's cards in review now, at any time of day (not "Review early"). */
function TutorReviewNow({ rec, onExit }: { rec: TutorSessionRow; onExit: () => void }) {
  const [cards, setCards] = useState<SkillCard[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const now = new Date();
      await ensureTutorCards(now).catch(() => 0);
      const ledger = await getLedgerNow(now);
      if (!cancelled) setCards(ledger.tutorClassNow(rec.id));
    })();
    return () => {
      cancelled = true;
    };
  }, [rec.id]);
  if (!cards) return <p>Loading…</p>;
  if (cards.length === 0)
    return (
      <p data-testid="tutor-vocab-empty">
        Nothing from this class to review right now.{' '}
        <button type="button" onClick={onExit}>
          {NEXT}
        </button>
      </p>
    );
  return (
    <ReviewPage
      focusCards={cards}
      keepEvery
      onExit={onExit}
      exitLabel={`← ${tutorClassTitle(rec.tutor, rec.date)}`}
      title={`${tutorClassTitle(rec.tutor, rec.date)} vocabulary`}
    />
  );
}

type Step = 'vocab' | 'grammar' | 'listening' | 'chat' | 'journal' | 'story';
// Phase 40 Part D.3: the textbook lesson's steps (a class's chat is its scenario step).
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'vocab', label: 'Vocabulary review' },
  { id: 'grammar', label: 'Grammar practice' },
  { id: 'listening', label: 'Listening round' },
  { id: 'chat', label: 'Chat about the class' },
  { id: 'journal', label: 'Journal prompt' },
  { id: 'story', label: 'A short story (optional)' },
];

function TutorStudy({ rec, lexicon, onExit }: { rec: TutorSessionRow; lexicon: Lexicon; onExit: () => void }) {
  const clips = useListeningClips();
  const listeningOn = useListeningEnabled();
  const ledger = useLedger();
  const wordIds = useMemo(() => tutorLessonOf(rec).wordIds, [rec]);
  const steps = useMemo(
    () =>
      STEPS.filter((s) =>
        s.id === 'grammar'
          ? rec.grammar.length > 0
          : s.id === 'listening'
            ? listeningOn && clips.ready && wordIds.some((id) => clips.hasClip('word', id))
            : s.id === 'story'
              ? canWriteStories()
              : s.id === 'chat'
                ? !!rec.scenario
                : s.id === 'journal'
                  ? wordIds.length > 0
                  : true,
      ),
    // the step list is fixed when the session starts
    [rec.id, clips.ready, listeningOn],
  );
  const journal = useMemo(
    () => ({
      label: tutorClassTitle(rec.tutor, rec.date),
      prompt: { ...tutorJournalPrompt(rec, (id) => !!ledger?.learned({ kind: 'word', id })), lessonId: rec.id },
    }),
    // built once per class
    [rec.id],
  );
  const [i, setI] = useState(0);
  const step = steps[i];
  const next = () => {
    saveProgressNow();
    if (i + 1 >= steps.length) onExit();
    else setI(i + 1);
  };
  if (!step) return null;
  return (
    <div className="textbook-study" data-testid="tutor-study">
      <div className="textbook-study-bar">
        <strong data-testid="tutor-study-step">
          {tutorClassTitle(rec.tutor, rec.date)} · Step {i + 1} of {steps.length}: {step.label}
        </strong>
        <span>
          <button type="button" onClick={next} data-testid="study-skip">
            {i + 1 >= steps.length ? 'Finish' : 'Skip step →'}
          </button>{' '}
          <button type="button" onClick={onExit}>
            Exit
          </button>
        </span>
      </div>
      {step.id === 'vocab' && <TutorVocabStep rec={rec} onDone={next} />}
      {step.id === 'grammar' && <TutorGrammarStep rec={rec} lexicon={lexicon} onDone={next} />}
      {step.id === 'listening' && (
        <ListenPage
          key={`listen-${rec.id}`}
          title={`${tutorClassTitle(rec.tutor, rec.date)} — listening`}
          size={6}
          onlyWordIds={new Set(wordIds)}
          onExit={next}
          exitLabel={NEXT}
        />
      )}
      {step.id === 'chat' && rec.scenario && <ChatPage key={rec.scenario.id} initialScenario={rec.scenario} onExit={next} />}
      {step.id === 'journal' && (
        <JournalPage key={`journal-${rec.id}`} tutorPrompt={journal} initialPromptId={journal.prompt.id} onDone={next} />
      )}
      {step.id === 'story' && <StoryStep lexicon={lexicon} onDone={next} />}
    </div>
  );
}

/** The class's cards in review now (every face, at any time of day), then nothing else. */
function TutorVocabStep({ rec, onDone }: { rec: TutorSessionRow; onDone: () => void }) {
  const [plan, setPlan] = useState<{ due: SkillCard[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const now = new Date();
      await ensureTutorCards(now).catch(() => 0);
      const ledger = await getLedgerNow(now);
      // Phase 23: reading (Say it) cards stay in Review and Pinyin & tones, as in a textbook lesson.
      const due = ledger.tutorClassNow(rec.id).filter((c) => c.skill !== 'reading');
      if (!cancelled) setPlan({ due });
    })();
    return () => {
      cancelled = true;
    };
    // built once per class (later changes must not rebuild the running session)
  }, [rec.id]);
  if (!plan) return <p>Loading…</p>;
  if (plan.due.length === 0)
    return (
      <p data-testid="tutor-vocab-empty">
        Nothing from this class to review this session.{' '}
        <button type="button" onClick={onDone}>
          {NEXT}
        </button>
      </p>
    );
  return (
    <ReviewPage
      focusCards={plan.due}
      onExit={onDone}
      exitLabel="Done with vocabulary →"
      title={`${tutorClassTitle(rec.tutor, rec.date)} vocabulary`}
    />
  );
}

/** Matched points: one exercise each (from the textbook sentences, when there are some), with the
 * class's own example. Notes are shown with their example and have no exercise. */
function TutorGrammarStep({ rec, lexicon, onDone }: { rec: TutorSessionRow; lexicon: Lexicon; onDone: () => void }) {
  const script = useReadingScript();
  const ledger = useLedger();
  const points = rec.grammar.filter((g) => g.grammarId && lexicon.grammarItemById(g.grammarId));
  const notes = rec.grammar.filter((g) => !points.includes(g));
  const [i, setI] = useState(0);
  const point = points[i];
  const ex = useSingleGrammarExercise(point?.grammarId, lexicon, `tutor|${rec.id}|${point?.grammarId ?? ''}`);

  async function done(ok: boolean) {
    const now = new Date();
    await learnerService.record(
      {
        item: { kind: 'grammar', id: point!.grammarId! },
        skill: 'recognition',
        kind: ok ? 'cloze_correct_nohint' : 'cloze_wrong',
        at: now,
        context: { source: 'tutor', refId: rec.id },
      },
      now,
    );
    setI((k) => k + 1);
  }

  if (point) {
    const item = lexicon.grammarItemById(point.grammarId!)!;
    return (
      <section className="tutoring-grammar-step" data-testid="tutor-grammar-step">
        <p className="textbook-muted">
          {i + 1} of {points.length} · <span lang="zh-Hant">{item.pattern}</span>{' '}
          <GrammarDots dots={ledger?.item({ kind: 'grammar', id: item.id }).dots ?? 0} />
        </p>
        <p>{point.explanationEn || item.explanationEn}</p>
        {point.example.zh && (
          <p className="textbook-example">
            <span lang="zh-Hant">
              <AnnotatedInline text={point.example.zh} lexicon={lexicon} script={script} />
            </span>
            <br />
            <small className="textbook-muted">{point.example.en}</small>
          </p>
        )}
        {ex === undefined ? (
          <p>Loading…</p>
        ) : ex ? (
          <GrammarExerciseCard key={`${rec.id}:${i}`} ex={ex} lexicon={lexicon} script={script} onDone={(ok) => void done(ok)} />
        ) : (
          <button type="button" onClick={() => setI((k) => k + 1)}>
            {NEXT}
          </button>
        )}
      </section>
    );
  }
  return (
    <section className="tutoring-grammar-step" data-testid="tutor-grammar-step">
      {notes.length > 0 && (
        <>
          <h3>Notes from the class</h3>
          {notes.map((g, k) => (
            <article key={k} className="textbook-grammar">
              <h4 lang="zh-Hant">{g.name}</h4>
              <p>{g.explanationEn}</p>
              {g.example.zh && (
                <p className="textbook-example">
                  <span lang="zh-Hant">{g.example.zh}</span>
                  <br />
                  <small className="textbook-muted">{g.example.en}</small>
                </p>
              )}
            </article>
          ))}
        </>
      )}
      <button type="button" className="btn-primary" onClick={onDone}>
        {NEXT}
      </button>
    </section>
  );
}
