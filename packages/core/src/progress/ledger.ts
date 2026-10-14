// Phase 29 Part A: the progress ledger, the ONLY door to progress. Every number or decision the app
// shows or makes about progress (New, in session, needs water, Learned, Mastered, lesson and level
// shares, new-word allowances, comprehensible words, read credit, days and weeks) comes from one
// `Ledger`, built once from the profile's cards, evidence, legacy known list and settings. Nothing
// outside `core/progress` reads a card's scheduling fields or builds its own count: the predicates
// below are not exported from `@anan/core`, and a lint rule checks the rest (CLAUDE.md "Progress
// rule (Phase 29)"). Pure; time is always injected.

import type { SkillCard } from '../learner/types.js';
import type { Lexicon } from '../lexicon.js';
import { LEVEL_IDS, type Level } from '../levels.config.js';
import type { Textbook, Lesson } from '../textbook/types.js';
import { lessonProgress, lessonDone, type LessonProgress } from '../textbook/progress.js';
import type { ClassScope } from '../textbook/scope.js';
import type { Evidence, ItemRef, Skill, Word } from '../types.js';
import type { PriorityConfig } from '../curriculum/priority.config.js';
import { answeredFaceKeys, faceGateOpen } from './face-order.js';
import { recentTutorWordIds, tutorLessonItems, TUTOR_FACES, type TutorLesson } from '../tutor/session.js';
import { TUTOR_CONFIG } from '../tutor/tutor.config.js';
import { extrasCountForMastery, getStudyFocus, lessonIndex, type StudyFocus, type StudySettings } from '../study/study-focus.js';
import { pickNewForSession } from '../study/queue.js';
import { computeStreak, streakDays, type StreakConfig, type StreakDay, type StreakResult } from '../game/streak.js';
import { knownCharacters } from '../learner/char-stats.js';
import { levelNewCandidates } from '../curriculum.js';
import { PROGRESS_CONFIG, type ProgressConfig } from './progress.config.js';
import {
  countWindowStart,
  sessionAt,
  statusEvidenceSince,
  type SessionSettings,
  type SessionWindow,
} from './review-sessions.js';
import {
  newWordState,
  reviewStatus,
  sessionCardKey,
  sessionCards,
  sessionForecast,
  type ForecastDay,
  type NewState,
  type ReviewStatus,
} from './review-status.js';
import {
  grammarDots,
  grammarUsesFromEvidence,
  isActiveCard,
  isDueBefore,
  isLearnedCard,
  isNewCard,
  isPracticeSkill,
  isPractisedListening,
  isScheduledCard,
  isStrongListening,
  itemKeyOf,
  lessonCoreItems,
  levelItems,
  ProgressIndex,
  type GrammarUse,
  type ItemProgress,
  type LearnedMastered,
  type WordSets,
} from './terms.js';
import { dayKey, weekRange, type WeekRange } from './time.js';
import { vocabLadder, type VocabLadder, type VocabLadderOptions } from './vocabLadder.js';

type EvidenceLike = Pick<Evidence, 'item' | 'skill' | 'kind' | 'at'> & Partial<Pick<Evidence, 'context'>>;

/** The queues that add new items (Phase 29 Part B.4). */
export type NewQueue = keyof ProgressConfig['newPerQueue'];

export interface LedgerStudyInputs {
  lexicon: Pick<Lexicon, 'allWords' | 'byId'>;
  /** Phase 38: can the loaded word list (lexicon plus grammar) show this item? Absent: a word
   * resolves when `lexicon.byId` has it, a grammar point always. */
  resolves?: (item: ItemRef) => boolean;
  /** Imported books, in course order. */
  books: readonly Textbook[];
  settings: StudySettings;
  myClass?: { enabled: boolean; textbookId: string; currentLesson: number };
  /** "My level" (the header picker). Absent: the ledger's frontier level. */
  level?: Level;
  /** My class scope (visibility only). */
  classScope?: ClassScope;
  /** Priority config override (tests); default `PRIORITY_CONFIG`. */
  config?: PriorityConfig;
  /** Phase 39: saved tutoring sessions (their ticked words go into study first). */
  tutorLessons?: readonly TutorLesson[];
}

export interface LedgerInputs {
  /** Every card of the profile (any skill, any state). */
  cards: readonly SkillCard[];
  /** Active evidence (undone answers removed): every grammar answer, and every row since
   * `ledgerEvidenceSince(now, session)`. More is fine. */
  evidence: readonly EvidenceLike[];
  /** The legacy (Phase 14) "already known" list ("word:id" / "grammar:id"). Always given. */
  knownItems: readonly string[];
  /** The profile's review settings (sessions, time zone, cap). */
  session: SessionSettings;
  /** The learner's lesson share (Settings → Study order). */
  masteryShare: number;
  now: Date;
  /** The study context, for `focus`, `ladder`, `level`, `lesson` items and new-word picks. */
  study?: LedgerStudyInputs;
  config?: ProgressConfig;
  /** Phase 32: the profile's active days (the synced `activeDays` table's day keys). */
  activeDays?: Iterable<string>;
  /** Phase 38: overrides the study context's `resolves` (tests). A card that doesn't resolve is held
   * out of every count and session and listed by `unresolved()`. */
  resolves?: (item: ItemRef) => boolean;
}

/** Phase 38: which items the ledger can show: the study context's check, else words the study
 * lexicon has (grammar always), else everything (no study context). */
function resolverFor(inputs: Pick<LedgerInputs, 'resolves' | 'study'>): (item: ItemRef) => boolean {
  if (inputs.resolves) return inputs.resolves;
  const study = inputs.study;
  if (!study) return () => true;
  if (study.resolves) return study.resolves;
  return (item) => item.kind !== 'word' || study.lexicon.byId(item.id) !== undefined;
}

/** The earliest evidence the ledger needs besides grammar answers (the session count window and
 * the profile-zone day). */
export const ledgerEvidenceSince = statusEvidenceSince;

export interface ItemView {
  status: ItemProgress;
  learned: boolean;
  mastered: boolean;
  imported: boolean;
  /** Removed by Nope ("Not now" / "Never show"): out of every count. */
  removed: boolean;
  /** Learned but keeps lapsing: never Mastered. */
  leech: boolean;
  /** Grammar: the progress dots (0–3), from the same tally as Mastered. */
  dots: number;
}

export interface TutorSessionView extends LearnedMastered {
  items: ItemRef[];
  /** Every ticked word is Learned. */
  done: boolean;
  /** Ticked words not Learned yet. */
  toLearn: ItemRef[];
}

export interface SessionView {
  status: ReviewStatus;
  /** This session's cards (with `early` between sessions, the next session's). */
  cards: SkillCard[];
  window?: SessionWindow;
  /** Distinct words among `cards`. */
  words: string[];
}

export interface NewAllowance {
  state: NewState;
  /** New items this queue may add in one session. */
  allowed: number;
  /** Review only: new Pick / Say it faces of words already being learned. */
  faces: number;
  message?: string;
}

export interface LessonView extends LessonProgress {
  /** Counted items (core items minus removed ones). */
  items: ItemRef[];
  /** Mastered at the learner's lesson share. */
  done: boolean;
  /** The counted items, not Mastered yet, the lesson still needs to be done at the learner's
   * share (in lesson order). Empty exactly when `done`. */
  stillToMaster: ItemRef[];
}

export interface LevelView extends LearnedMastered {
  level: Level;
  /** The level-up prompt: the next level, once this level's Learned share passed the line. */
  next?: Level;
  readyForNext: boolean;
}

export interface ComprehensibleSets extends WordSets {
  /** Learned ∪ in session ∪ learning: the words a reader is expected to understand. */
  ids: Set<string>;
}

export interface PracticeView {
  /** Answered cards of that skill in this review session's window. */
  due: SkillCard[];
  /** New cards of that skill, at most the queue's allowance. */
  fresh: SkillCard[];
  /** Every answered card of that skill, weakest first ("Practise anyway"). */
  answered: SkillCard[];
}

/** Everything the app may ask about progress. Build it with `buildLedger`. */
export class Ledger {
  readonly now: Date;
  readonly timeZone: string;
  readonly settings: SessionSettings;
  readonly masteryShare: number;
  private readonly cfg: ProgressConfig;
  private readonly index: ProgressIndex;
  private readonly allCards: readonly SkillCard[];
  private readonly heldCards: readonly SkillCard[];
  private readonly resolvesItem: (item: ItemRef) => boolean;
  private readonly evidence: readonly EvidenceLike[];
  private readonly study?: LedgerStudyInputs;
  private readonly storedActiveDays: ReadonlySet<string>;
  private readonly grammarUses: Map<string, GrammarUse>;
  private memo = new Map<string, unknown>();

  constructor(inputs: LedgerInputs) {
    this.now = inputs.now;
    this.settings = inputs.session;
    this.timeZone = inputs.session.timeZone;
    this.masteryShare = inputs.masteryShare;
    this.cfg = inputs.config ?? PROGRESS_CONFIG;
    // Phase 38: a card whose item the loaded word list can't show (a stale cached lexicon, a custom
    // word not merged yet) is held: it is in no count and no session until the word list has it.
    this.resolvesItem = resolverFor(inputs);
    const resolved: SkillCard[] = [];
    const held: SkillCard[] = [];
    for (const c of inputs.cards) (this.resolvesItem(c.item) ? resolved : held).push(c);
    this.allCards = resolved;
    this.heldCards = held;
    // The session counts read only this window (older rows, e.g. grammar answers, are for the dots).
    const since = statusEvidenceSince(inputs.now, inputs.session).getTime();
    this.evidence = inputs.evidence.filter((e) => e.at.getTime() >= since && e.at.getTime() <= inputs.now.getTime());
    this.study = inputs.study;
    this.storedActiveDays = new Set(inputs.activeDays ?? []);
    // Phase 25: a grammar point's days are the profile's days.
    this.grammarUses = grammarUsesFromEvidence(inputs.evidence, this.cfg, this.timeZone);
    this.index = new ProgressIndex({
      cards: resolved,
      grammarUses: this.grammarUses,
      knownItems: inputs.knownItems,
      config: this.cfg,
    });
  }

  private once<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as T;
  }

  /** Every card the loaded word list can show, as stored (for session builders that order cards).
   * Held cards (`unresolved()`) are left out. */
  get cards(): readonly SkillCard[] {
    return this.allCards;
  }

  /** Phase 38: does the loaded word list have this item? */
  resolves(item: ItemRef): boolean {
    return this.resolvesItem(item);
  }

  /** Phase 38: met, not removed cards whose item the loaded word list lacks. They are never shown,
   * counted, rescheduled or deleted; Review says they are waiting for the latest word list. */
  unresolved(): SkillCard[] {
    return this.once('unresolved', () => this.heldCards.filter((c) => c.state !== 'unseen' && isActiveCard(c)));
  }

  // -------------------------------------------------------------------------------------------
  // Items

  item(ref: ItemRef): ItemView {
    const learned = this.index.learned(ref);
    const mastered = this.index.mastered(ref);
    return {
      status: this.index.status(ref),
      learned: learned || mastered,
      mastered,
      imported: this.index.imported(ref),
      removed: this.index.removed(ref),
      leech: this.index.leech(ref),
      // ●●● is Mastered and nothing else: a wrong last use or a Tricky point keeps the third dot empty
      dots:
        ref.kind !== 'grammar'
          ? 0
          : mastered
            ? this.cfg.mastered.grammarCorrectUses
            : Math.min(grammarDots(this.index.grammarUse(ref.id), this.cfg), this.cfg.mastered.grammarCorrectUses - 1),
    };
  }

  learned(ref: ItemRef): boolean {
    return this.index.learned(ref) || this.index.mastered(ref);
  }

  mastered(ref: ItemRef): boolean {
    return this.index.mastered(ref);
  }

  removed(ref: ItemRef): boolean {
    return this.index.removed(ref);
  }

  hasCard(ref: ItemRef): boolean {
    return this.index.hasCard(ref);
  }

  /** A grammar point's correct-use tally (the dots). */
  grammarUse(id: string): GrammarUse | undefined {
    return this.index.grammarUse(id);
  }

  /** Every item the learner has met (a Review-skill card past unseen), removed ones left out: the
   * Progress page's "all words" line. */
  metItems(): ItemRef[] {
    return this.once('metItems', () => {
      const out = new Map<string, ItemRef>();
      for (const c of this.metCards())
        if (!isPracticeSkill(c.skill) && !this.index.removed(c.item)) out.set(itemKeyOf(c.item), c.item);
      return [...out.values()];
    });
  }

  /** Every card past `unseen` (any skill, removed ones included): what the learner has met. */
  metCards(): SkillCard[] {
    return this.once('metCards', () => this.allCards.filter((c) => c.state !== 'unseen'));
  }

  /** "skill|word:id" keys of the met cards (e.g. "does this word have a production card yet?"). */
  hasMetCard(item: ItemRef, skill: Skill): boolean {
    return this.once('metKeys', () => new Set(this.metCards().map((c) => `${c.skill}|${itemKeyOf(c.item)}`))).has(`${skill}|${itemKeyOf(item)}`);
  }

  /** Grammar points Learned but not Mastered yet (not removed): Cloze's grammar round. */
  grammarToPractise(): string[] {
    const ids = new Set<string>(this.grammarUses.keys());
    for (const c of this.allCards) if (c.item.kind === 'grammar') ids.add(c.item.id);
    return [...ids].filter((id) => {
      const ref: ItemRef = { kind: 'grammar', id };
      return this.learned(ref) && !this.mastered(ref) && !this.removed(ref);
    });
  }

  /** Phase 15: a lesson's listening numbers (shown apart; never toward mastery). Practised =
   * answered at least once; strong = stable past `listeningStrongDays`. */
  listeningStats(wordIds: Iterable<string>): { practised: number; strong: number } {
    const mine = new Set(wordIds);
    let practised = 0;
    let strong = 0;
    for (const c of this.allCards) {
      if (c.skill !== 'listening' || c.item.kind !== 'word' || !mine.has(c.item.id)) continue;
      if (isPractisedListening(c)) practised++;
      if (isStrongListening(c, this.cfg)) strong++;
    }
    return { practised, strong };
  }

  /** Learned % and Mastered % over `items`. Removed items are always left out. */
  summary(items: readonly ItemRef[]): LearnedMastered {
    return this.index.summarize(items.filter((i) => !this.index.removed(i)));
  }

  /** Learned words (Mastered included): the "known" set every tab uses. */
  learnedWordIds(): Set<string> {
    return this.once('learnedWords', () => {
      const out = new Set<string>();
      for (const c of this.allCards) {
        if (c.item.kind !== 'word' || isPracticeSkill(c.skill)) continue;
        if (this.learned(c.item)) out.add(c.item.id);
      }
      return out;
    });
  }

  /** Phase 23: "Pinyin 80%": Learned words whose reading card is Learned too. */
  pinyinShare(): { share: number; learned: number; withPinyin: number } {
    const learned = this.learnedWordIds();
    let withPinyin = 0;
    for (const c of this.allCards)
      if (c.skill === 'reading' && c.item.kind === 'word' && learned.has(c.item.id) && isLearnedCard(c)) withPinyin++;
    return { share: learned.size === 0 ? 0 : withPinyin / learned.size, learned: learned.size, withPinyin };
  }

  // -------------------------------------------------------------------------------------------
  // The review session (Part B.1: due = in the current session)

  /** This session's status: the only "due" numbers (Home, Review, Garden, the badge). */
  get status(): ReviewStatus {
    return this.once('status', () =>
      reviewStatus({
        cards: this.allCards,
        evidence: this.evidence,
        now: this.now,
        settings: this.settings,
        baseNew: this.cfg.newPerQueue.review,
        newHalfShare: this.cfg.newHalfShare,
        ...(this.tutorWordIds().size > 0 ? { tutor: this.tutorCardTest(), tutorOrder: this.tutorOrder() } : {}),
      }),
    );
  }

  /** Phase 40 Part E: is this card one of a tutoring word's (any saved class, ticked)? */
  isTutorCard(card: Pick<SkillCard, 'item'>): boolean {
    return card.item.kind === 'word' && this.tutorWordIds().has(card.item.id);
  }

  /** Tutoring word id → place in class order (oldest class first). */
  private tutorOrder(): ReadonlyMap<string, number> {
    return this.once('tutorOrder', () => {
      const order = new Map<string, number>();
      for (const l of this.tutorLessons()) for (const id of l.wordIds) if (!order.has(id)) order.set(id, order.size);
      return order;
    });
  }

  private tutorCardTest(): (c: Pick<SkillCard, 'item'>) => boolean {
    return (c) => this.isTutorCard(c);
  }

  /** This session's cards (or with `early`, between sessions, the next session's). */
  session(opts: { early?: boolean } = {}): SessionView {
    return this.once(`session:${opts.early ? 'early' : 'now'}`, () => {
      const picked = sessionCards({
        cards: this.allCards,
        evidence: this.evidence,
        now: this.now,
        settings: this.settings,
        ...(opts.early ? { early: true } : {}),
        ...(this.tutorWordIds().size > 0 ? { tutor: this.tutorCardTest(), tutorOrder: this.tutorOrder() } : {}),
      });
      const words = [...new Set(picked.cards.filter((c) => c.item.kind === 'word').map((c) => c.item.id))];
      return { status: this.status, ...picked, words };
    });
  }

  /** Two bars a day (morning, evening) for the next `days` days. */
  forecast(days = 7): ForecastDay[] {
    return sessionForecast({ cards: this.allCards, evidence: this.evidence, now: this.now, settings: this.settings, days });
  }

  private sessionKeys(): Set<string> {
    return this.once('sessionKeys', () => new Set(this.status.sessionCardKeys));
  }

  /** The card is in the current review session. */
  inSession(card: Pick<SkillCard, 'item' | 'skill'>): boolean {
    return this.sessionKeys().has(sessionCardKey(card));
  }

  private nextKeys(): Set<string> {
    return this.once('nextKeys', () => new Set(this.status.nextSessionCardKeys));
  }

  /** The card is in the next session (a faint droplet outline: not thirsty yet). */
  inNextSession(card: Pick<SkillCard, 'item' | 'skill'>): boolean {
    return this.nextKeys().has(sessionCardKey(card));
  }

  /** "Needs water": the card is in the current review session (listening never is). */
  needsWater(card: Pick<SkillCard, 'item' | 'skill'>): boolean {
    return card.skill !== 'listening' && this.inSession(card);
  }

  /** Distinct words with a card in this session ("💧 Water all (N)"). */
  thirstyWords(): string[] {
    return this.status.thirstyWordIds;
  }

  /** The start of this session's count window (between sessions: the end of the last one). */
  countWindowStart(): Date {
    return countWindowStart(sessionAt(this.now, this.settings));
  }

  // -------------------------------------------------------------------------------------------
  // New items (Part B.4: one allowance for every queue)

  /** New items `queue` may add this session, from the one backlog state. */
  newAllowance(queue: NewQueue): NewAllowance {
    const st = this.status;
    const n = newWordState({
      // Phase 40: tutoring cards never hold the other new words back (they're outside the cap).
      dueNow: st.sessionCards - st.tutorCards,
      capLeft: st.capLeft,
      cap: st.cap,
      baseNew: this.cfg.newPerQueue[queue],
      newHalfShare: this.cfg.newHalfShare,
    });
    const faces =
      queue !== 'review'
        ? 0
        : n.newState === 'open'
          ? this.cfg.newFacesPerSession
          : n.newState === 'reduced'
            ? Math.floor(this.cfg.newFacesPerSession / 2)
            : 0;
    // Phase 40 Part E: tutoring words are added on top of the textbook order, never in place of it, so
    // they no longer use up the allowance (Phase 39 counted them against it).
    return { state: n.newState, allowed: n.newAllowed, faces, ...(n.newMessage ? { message: n.newMessage } : {}) };
  }

  // -------------------------------------------------------------------------------------------
  // Phase 39: tutoring words (owner, 2026-10-13: added as soon as a class is uploaded)

  /** Saved classes, oldest first. */
  private tutorLessons(): TutorLesson[] {
    return [...(this.study?.tutorLessons ?? [])].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  }

  /** Every ticked word of a saved class. */
  tutorWordIds(): ReadonlySet<string> {
    return this.once('tutorWordIds', () => new Set(this.tutorLessons().flatMap((l) => l.wordIds)));
  }

  /** Phase 40 Part E.4: the ticked words of the last `n` classes (default 3), newest class first. */
  recentTutorWordIds(n = TUTOR_CONFIG.recentClasses): string[] {
    return this.once(`recentTutor:${n}`, () => recentTutorWordIds(this.tutorLessons(), n));
  }

  /** Phase 40 Part E.1: this class's cards in the session now ("Review these N words now"). */
  tutorClassNow(sessionId: string): SkillCard[] {
    const lesson = this.tutorLessons().find((l) => l.id === sessionId);
    if (!lesson) return [];
    const ids = new Set(lesson.wordIds);
    return this.session().cards.filter((c) => c.item.kind === 'word' && ids.has(c.item.id));
  }

  /** Phase 40 Part D.5: a word's faces so far (the class page's "Meaning ✓ · Pick ✓ · Recall · Say
   * it · Listening"). `answered`: the face's card was answered at least once here. */
  wordFaces(wordId: string): Array<{ skill: Skill; carded: boolean; answered: boolean; learned: boolean }> {
    const mine = this.allCards.filter((c) => c.item.kind === 'word' && c.item.id === wordId && c.state !== 'unseen');
    return (['recognition', 'production', 'reading', 'listening'] as const).map((skill) => {
      const c = mine.find((x) => x.skill === skill);
      return { skill, carded: !!c, answered: !!c && !isNewCard(c), learned: !!c && isLearnedCard(c) };
    });
  }

  /** Tutoring words introduced in this session's count window (shown on the class page; Phase 40:
   * they no longer count against the allowance). */
  tutorIntroducedThisSession(): number {
    return this.once('tutorIntroduced', () => {
      const since = this.countWindowStart().getTime();
      const ids = new Set<string>();
      for (const e of this.evidence)
        if (e.kind === 'textbook_lesson_covered' && e.context?.source === 'tutor' && e.at.getTime() >= since)
          ids.add(itemKeyOf(e.item));
      return ids.size;
    });
  }

  /**
   * Phase 40 Part E.2–E.3: the ticked tutoring words' faces to introduce now (New cards, in the
   * session at once): every face in `TUTOR_FACES` the word has no card for yet, for every word not
   * Learned or removed, oldest class first. No per-session limit (owner, 2026-10-14).
   */
  tutorToIntroduce(): Array<{ item: ItemRef; sessionId: string; skills: Skill[] }> {
    return this.once('tutorToIntroduce', () => {
      const out: Array<{ item: ItemRef; sessionId: string; skills: Skill[] }> = [];
      const seen = new Set<string>();
      const carded = new Set(this.allCards.filter((c) => c.item.kind === 'word').map((c) => `${c.skill}|${c.item.id}`));
      // Phase 42: faces enter in order (Meaning, Pick, Say it): a face is added once the one before
      // it has been answered. (Which New cards are in the session is `tutorNowFilter`'s daily limit.)
      const answered = answeredFaceKeys(this.allCards);
      const ready = (s: Skill, id: string) => s === 'recognition' || answered.has(`${s === 'production' ? 'recognition' : 'production'}|${id}`);
      for (const l of this.tutorLessons())
        for (const id of l.wordIds) {
          const item: ItemRef = { kind: 'word', id };
          if (seen.has(id)) continue;
          seen.add(id);
          if (this.index.removed(item) || this.learned(item) || !this.resolvesItem(item)) continue;
          const skills = TUTOR_FACES.filter((s) => !carded.has(`${s}|${id}`) && ready(s, id));
          if (skills.length > 0) out.push({ item, sessionId: l.id, skills });
        }
      return out;
    });
  }

  /** New (never answered) tutoring word cards, oldest class first: they join Review ahead of every
   * other new word and outside the allowance. */
  tutorNewCards(): SkillCard[] {
    return this.once('tutorNewCards', () => {
      const order = new Map<string, number>();
      for (const l of this.tutorLessons()) for (const id of l.wordIds) if (!order.has(id)) order.set(id, order.size);
      return this.newCards()
        .filter((c) => c.skill === 'recognition' && c.item.kind === 'word' && order.has(c.item.id))
        .sort((a, b) => order.get(a.item.id)! - order.get(b.item.id)!);
    });
  }

  /** Phase 42: the New cards Review may introduce now: a Pick card waits for its word's Meaning to be
   * answered, a Say it card for Pick (lesson words and tutoring words alike). */
  reviewNewCards(): SkillCard[] {
    return this.once('reviewNewCards', () => {
      const answered = answeredFaceKeys(this.allCards);
      return this.newCards().filter((c) => faceGateOpen(c, answered));
    });
  }

  /** New cards (introduced, never answered, not removed) of the Review skills. */
  newCards(): SkillCard[] {
    return this.once('newCards', () => this.allCards.filter((c) => isNewCard(c) && isActiveCard(c) && c.skill !== 'listening'));
  }

  /**
   * The new items one session of `queue` introduces: the one picker (`pickNewForSession`) under the
   * queue's allowance. With no study focus the picked level's words are the candidates.
   */
  pickNew(
    queue: NewQueue,
    opts: {
      onlyItems?: ReadonlySet<string>;
      extraItems?: readonly ItemRef[];
      allowed?: number;
      scenarioTags?: readonly string[];
      /** The level the general candidates come from (default: My level, else the frontier). */
      level?: Level;
    } = {},
  ): { cards: SkillCard[]; items: ItemRef[] } {
    const allowance = this.newAllowance(queue);
    const focus = this.focus();
    // General (level) words join only when the study order allows them (no focus, or the gate is open).
    const general = !focus?.enabled || focus.generalNewItemsAllowed;
    const fallback = general ? this.levelCandidates(opts.scenarioTags, opts.level) : [];
    return pickNewForSession({
      // New words only: new faces (Pick / Say it) of words already learned have Review's own allowance.
      // Phase 40: tutoring words are in the session already, outside the allowance.
      newCards: this.newCards().filter((c) => c.skill === 'recognition' && !this.isTutorCard(c)),
      ...(focus ? { focus } : {}),
      ...(this.lessonIdx() ? { lessonIdx: this.lessonIdx()! } : {}),
      allowed: Math.min(allowance.allowed, opts.allowed ?? Infinity),
      ...(opts.onlyItems ? { onlyItems: opts.onlyItems } : {}),
      extraItems: [...(opts.extraItems ?? []), ...fallback],
      resolves: this.resolvesItem,
    });
  }

  private levelCandidates(scenarioTags?: readonly string[], at?: Level): ItemRef[] {
    if (!this.study) return [];
    const level = at ?? this.study.level ?? this.frontierLevel();
    const carded = new Set(this.allCards.filter((c) => c.state !== 'unseen').map((c) => c.item.id));
    return levelNewCandidates({
      lexicon: this.study.lexicon,
      level,
      nextLevelToo: this.level(level).readyForNext,
      carded,
      knownChars: knownCharacters(this.learnedWordIds(), this.study.lexicon),
      ...(this.study.classScope ? { classScope: this.study.classScope } : {}),
      ...(scenarioTags ? { scenarioTags } : {}),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Practice queues (Part B.2: listening and pinyin are their own queues)

  /** The due and new sets of a practice skill's own queue, in this session's window. */
  practice(skill: 'listening' | 'reading', opts: { early?: boolean } = {}): PracticeView {
    const pos = sessionAt(this.now, this.settings);
    const window = pos.current ?? (opts.early ? pos.next : undefined);
    const mine = this.allCards.filter((c) => c.skill === skill && c.item.kind === 'word' && isActiveCard(c));
    const due =
      skill === 'reading'
        ? opts.early && !pos.current
          ? this.session({ early: true }).cards.filter((c) => c.skill === 'reading')
          : mine.filter((c) => this.inSession(c))
        : window
          ? mine.filter((c) => isDueBefore(c, window.cutoff))
          : [];
    const allowance = this.newAllowance(skill === 'reading' ? 'pinyin' : 'listening');
    const fresh = mine.filter((c) => c.card.reps === 0).slice(0, allowance.allowed);
    const answered = mine.filter((c) => c.card.reps > 0).sort((a, b) => a.card.stability - b.card.stability);
    return { due, fresh, answered };
  }

  // -------------------------------------------------------------------------------------------
  // Lessons and levels (Part B.6–B.7)

  /** A lesson's numbers: counted items, Learned / Mastered, still to master, done. */
  lesson(
    lesson: Lesson,
    extras: { completedScenarioIds?: ReadonlySet<string>; donePromptIds?: ReadonlySet<string> } = {},
  ): LessonView {
    const withExtras = this.study ? extrasCountForMastery(this.study.config, this.study.settings) : false;
    const p = lessonProgress(lesson, { index: this.index, withExtras, ...extras });
    const items = lessonCoreItems(lesson, { withExtras }).filter((i) => !this.index.removed(i));
    const done = lessonDone(p, this.masteryShare);
    // "Still to master" is what the lesson needs to be done at the learner's share, so the chip's
    // done and "0 still to master" are one fact (Phase 29 Part C.3).
    const unmastered = items.filter((i) => !this.index.mastered(i));
    const mastered = items.length - unmastered.length;
    const need = done ? 0 : Math.max(1, Math.ceil(this.masteryShare * items.length - 1e-9) - mastered);
    return { ...p, items, done, stillToMaster: unmastered.slice(0, need) };
  }

  /** Phase 39: a tutoring session's numbers (its ticked words and matched grammar). Done once every
   * word is Learned (Mastered still counts for Progress but never holds anything up). */
  tutorSession(lesson: TutorLesson): TutorSessionView {
    const items = tutorLessonItems(lesson).filter((i) => !this.index.removed(i));
    const words = items.filter((i) => i.kind === 'word');
    const toLearn = words.filter((i) => !this.index.learned(i));
    return { ...this.index.summarize(items), items, done: words.length > 0 && toLearn.length === 0, toLearn };
  }

  /** A TOCFL level's numbers (its official words, removed ones left out) and the level-up prompt. */
  level(level: Level): LevelView {
    return this.once(`level:${level}`, () => {
      const words = this.study?.lexicon.allWords() ?? [];
      const sum = this.summary(levelItems(level, words as Word[]));
      const next = LEVEL_IDS[LEVEL_IDS.indexOf(level) + 1];
      const readyForNext = !!next && sum.total > 0 && sum.learnedShare >= this.cfg.levelUpLearnedShare;
      return { ...sum, level, readyForNext, ...(readyForNext && next ? { next } : {}) };
    });
  }

  /** The lowest level whose Learned share is below the level-up line (the last level when all are past it). */
  frontierLevel(): Level {
    return this.once('frontier', () => {
      for (const lv of LEVEL_IDS) {
        const v = this.level(lv);
        if (v.total > 0 && v.learnedShare < this.cfg.levelUpLearnedShare) return lv;
      }
      return LEVEL_IDS[LEVEL_IDS.length - 1]!;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Study focus and the vocabulary ladder

  /** The study focus (Now studying, catch-up, the TOCFL gate); undefined without a textbook. */
  focus(): StudyFocus | undefined {
    return this.once('focus', () => {
      const s = this.study;
      if (!s || s.books.length === 0) return undefined;
      const focus = getStudyFocus(
        {
          lexicon: s.lexicon,
          books: s.books,
          cards: this.allCards,
          grammarUses: this.grammarUses,
          index: this.index,
          settings: s.settings,
          ...(s.config ? { config: s.config } : {}),
          ...(s.myClass ? { myClass: s.myClass } : {}),
          ...(s.tutorLessons ? { tutorLessons: s.tutorLessons } : {}),
        },
        this.now,
      );
      // Phase 38: a word the loaded word list lacks is never introduced (no "(unknown item)" card).
      return { ...focus, newItemsAllowed: focus.newItemsAllowed.filter(this.resolvesItem) };
    });
  }

  private lessonIdx(): Map<string, string> | undefined {
    return this.once('lessonIdx', () => (this.study && this.study.books.length > 0 ? lessonIndex(this.study.books, undefined, this.study.settings.teachExtras !== false) : undefined));
  }

  /** The vocabulary ladder (stories, open chat) from the ledger's own sets and focus. */
  ladder(
    level: Level,
    options: Partial<VocabLadderOptions> = {},
    /** The books and focus to rank by (default: the ledger's own study context). */
    context: { books?: readonly Textbook[]; focus?: StudyFocus } = {},
  ): VocabLadder {
    const sets = this.comprehensible();
    const focus = context.focus ?? this.focus();
    return vocabLadder(
      {
        lexicon: this.study?.lexicon ?? { allWords: () => [] },
        level,
        knownIds: sets.knownIds,
        dueIds: sets.dueIds,
        learningIds: sets.learningIds,
        books: context.books ?? this.study?.books ?? [],
        ...(focus ? { studyFocus: focus } : {}),
        ...(this.recentTutorWordIds().length > 0 ? { tutorWordIds: this.recentTutorWordIds() } : {}),
      },
      options,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Comprehensible and read credit (Part B.10–B.11)

  /** Learned ∪ in session ∪ learning (answered at least once): the same set for chat, open chat,
   * the Reader, Cloze coverage and stories. */
  comprehensible(): ComprehensibleSets {
    return this.once('comprehensible', () => {
      const knownIds = this.learnedWordIds();
      const dueIds = new Set<string>();
      const learningIds = new Set<string>();
      const newIds = new Set<string>();
      for (const c of this.allCards) {
        if (c.item.kind !== 'word' || isPracticeSkill(c.skill) || c.state === 'unseen') continue;
        if (!isActiveCard(c) && !c.flags.markedKnown) continue;
        const id = c.item.id;
        if (this.inSession(c)) dueIds.add(id);
        if (knownIds.has(id)) continue;
        if (isNewCard(c)) newIds.add(id);
        else learningIds.add(id);
      }
      for (const id of [...learningIds, ...dueIds, ...knownIds]) newIds.delete(id);
      return { knownIds, dueIds, learningIds, newIds, ids: new Set([...knownIds, ...dueIds, ...learningIds]) };
    });
  }

  /** May reading this card without a lookup earn read credit? Answered at least once, not removed,
   * and in this session or learning (the comprehensible learning set: answered, not Learned yet,
   * imports included). A New or Nope'd card never does. */
  creditsRead(card: SkillCard | undefined): boolean {
    if (!card || !isScheduledCard(card)) return false;
    if (this.inSession(card)) return true;
    return card.state === 'learning' || (card.item.kind === 'word' && this.comprehensible().learningIds.has(card.item.id));
  }

  // -------------------------------------------------------------------------------------------
  // Days (Part B.12: always the profile's time zone)

  /** The profile-zone day of `at` ("YYYY-MM-DD"); today without an argument. */
  dayKey(at: Date = this.now): string {
    return dayKey(at, this.timeZone);
  }

  /** This week: Monday to Sunday in the profile's zone. */
  /** Phase 40 Part E.4: `at` falls on today or one of the `days - 1` days before it (profile zone). */
  withinDays(at: Date, days: number): boolean {
    const key = dayKey(at, this.timeZone);
    for (let i = 0; i < days; i++) if (dayKey(new Date(this.now.getTime() - i * 86_400_000), this.timeZone) === key) return true;
    return false;
  }

  weekRange(): WeekRange {
    return weekRange(this.now, this.timeZone);
  }

  /** Phase 32: the days the learner did something meaningful (the only input to the streak). */
  activeDays(): ReadonlySet<string> {
    return this.storedActiveDays;
  }

  /** Has today (profile zone) been active yet? */
  activeToday(): boolean {
    return this.storedActiveDays.has(this.dayKey());
  }

  /** The gentle streak over active days (day keys from `dayKey`). Home and Progress both pass
   * `ledger.activeDays()`. */
  streak(activeDays: Iterable<string>, config?: StreakConfig): StreakResult {
    return computeStreak(activeDays, this.now, config, this.timeZone);
  }

  /** Phase 32: the Home bar's last seven days (oldest first, today last). */
  streakWeek(activeDays: Iterable<string>, config?: StreakConfig): StreakDay[] {
    return streakDays(activeDays, this.now, config, this.timeZone);
  }

  // -------------------------------------------------------------------------------------------

  /** The item key helper every caller uses ("word:id"). */
  static key(ref: ItemRef): string {
    return itemKeyOf(ref);
  }

  /** Skills a word's plant shows (Review skills). */
  static isReviewSkill(skill: Skill): boolean {
    return skill !== 'listening';
  }
}

/** Build the ledger: the only way to get progress numbers. */
export function buildLedger(inputs: LedgerInputs): Ledger {
  return new Ledger(inputs);
}
