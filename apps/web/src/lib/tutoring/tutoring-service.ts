// Phase 39: a tutoring class from its summary PDF. Extraction and the sentence check make a draft;
// nothing is stored until Save (the session record and the custom words it needs, in one
// transaction). Phase 40: the ticked words are then introduced at once with every face, in review
// right away (`introduce`); levels and topics the code can't work out take one checked call.
import {
  acceptGrammarPractice,
  applyTutorCheck,
  countPracticeSentences,
  draftGrammarPractice,
  grammarPracticeRequest,
  MIN_PRACTICE_SENTENCES,
  recheckTutorGrammar,
  setTutorGrammarMatch,
  tutorLessonOf,
  type PracticeSentence,
  type SentenceBankEntry,
  applyTutorClassify,
  buildTutorDraft,
  charLevelIndex,
  displayLevel,
  draftSentencesToCheck,
  estimateWordLevel,
  finalizeTutorSession,
  replaceSimplifiedChars,
  topicTagsFor,
  tutorClassifyRequest,
  tutorCustomWord,
  tutorScenario,
  tutorScenarioRequest,
  TOPIC_TAGS,
  type TutorClassifyResponse,
  type TopicTag,
  type Word,
  type Ledger,
  type Level,
  type Lexicon,
  type TutorDraft,
  type TutorExtraction,
  type TutoringLLM,
  type TutorPageImage,
  type TutorScenarioResponse,
} from '@anan/core';
import type { AnanDB, CustomWordRow, TutorSessionRow } from '../../db/schema.js';
import { markStudyDirty } from '../study-dirty.js';
import type { TaiwanConverters } from '../opencc.js';
import { classPracticeSentences } from '../grammar-practice.js';

export interface DraftResult {
  draft: TutorDraft;
  /** The same class (date and tutor) is already saved: Save updates it. */
  existing?: TutorSessionRow;
}

export class TutoringService {
  constructor(
    private readonly db: AnanDB,
    private readonly lexicon: Lexicon,
    private readonly llm: TutoringLLM,
    private readonly ledger: (now: Date) => Promise<Ledger>,
    private readonly converters: () => Promise<TaiwanConverters>,
    /** Introduces the tutoring words due to join now (`ensureTutorCards`); returns how many. */
    private readonly introduce: (now: Date) => Promise<number>,
    private readonly options: {
      /** Phase 40 Part B: "This tutor is from Taiwan" (default on). */
      tutorFromTaiwan?: (tutor: string) => Promise<boolean>;
      /** Phase 40 Part D.1: asks the server for the class's clips after Save (never fails Save). */
      audio?: (rec: TutorSessionRow) => Promise<TutorSessionRow['audio']>;
      /** The lexicon changed (custom words written): rebuild it now. */
      lexiconChanged?: () => void;
      /** Phase 46 Part B: the textbook sentences and the banks (to tell whether a grammar point of a
       * class has 3 practice sentences; without it Save writes none). */
      practiceSources?: () => Promise<{ textbook: SentenceBankEntry[]; bank: PracticeSentence[] }>;
    } = {},
  ) {}

  /** Part A: one extraction call with every page, then the draft. A quota stop throws (nothing kept). */
  async draftFromPages(pages: TutorPageImage[], now: Date = new Date()): Promise<DraftResult> {
    const extraction = await this.llm.extractTutorSummary({ pages });
    return this.draftFromExtraction(extraction, now);
  }

  /** Part B: Taiwan characters and words, the word list, the learner's progress, then one check. */
  async draftFromExtraction(extraction: TutorExtraction, now: Date = new Date()): Promise<DraftResult> {
    const [conv, ledger] = await Promise.all([this.converters(), this.ledger(now)]);
    const fromTaiwan = (await this.options.tutorFromTaiwan?.(extraction.tutor).catch(() => true)) ?? true;
    let draft = buildTutorDraft(extraction, {
      lexicon: this.lexicon,
      ...conv,
      learned: (ref) => ledger.learned(ref),
      comprehensibleIds: ledger.comprehensible().ids,
      tutorFromTaiwan: fromTaiwan,
    });
    const toCheck = draftSentencesToCheck(draft);
    const checked =
      toCheck.length > 0
        ? await this.llm.checkTutorSentences({ sentences: toCheck.slice(0, 60).map((s) => ({ id: s.id, zh: s.zh, en: s.en })) })
        : undefined;
    draft = applyTutorCheck(draft, checked);
    const existing = await this.db.tutorSessions.get(draft.sessionId);
    return { draft, ...(existing ? { existing } : {}) };
  }

  /**
   * Part C "Save": the class scenario (one call; a plain one when the quota is out), then the
   * session and its custom words in one transaction. The same class again replaces its record.
   */
  async save(
    draft: TutorDraft,
    level: Level,
    now: Date = new Date(),
  ): Promise<{ record: TutorSessionRow; introduced: number; audio: Promise<TutorSessionRow> }> {
    let res: TutorScenarioResponse | undefined;
    try {
      res = await this.llm.writeTutorScenario(tutorScenarioRequest(draft, level));
    } catch {
      res = undefined; // the plain scenario built from the topics
    }
    const scenario = tutorScenario(draft, res);
    // Phase 40 Parts A.2.3 / C.1: one checked call for levels and topics the code couldn't work out.
    const req = tutorClassifyRequest(draft, (id) => {
      const w = this.lexicon.byId(id);
      return !!w && displayLevel(w) !== null;
    });
    let classifiedRes: TutorClassifyResponse | undefined;
    if (req && this.llm.classifyTutorWords) {
      try {
        classifiedRes = await this.llm.classifyTutorWords(req);
      } catch {
        classifiedRes = undefined; // estimates stay empty ("Other") until "Re-check levels and topics"
      }
    }
    const classified = applyTutorClassify(draft, classifiedRes);
    let saved: TutorSessionRow | undefined;
    await this.db.transaction('rw', this.db.tutorSessions, this.db.customWords, async () => {
      const existing = await this.db.tutorSessions.get(draft.sessionId);
      const { record, customWords } = finalizeTutorSession(draft, { now, scenario, classified, ...(existing ? { existing } : {}) });
      if (customWords.length > 0) await this.db.customWords.bulkPut(customWords);
      await this.db.tutorSessions.put(record);
      saved = record;
    });
    markStudyDirty();
    this.options.lexiconChanged?.();
    // Owner, 2026-10-14: the class's words are in review the moment it is saved, every face.
    const introduced = await this.introduce(now);
    // Phase 46 Part B.1.4: a matched grammar point with fewer than 3 practice sentences gets some
    // written (one checked call each); a failure (the quota) leaves "Write practice" for later.
    let record = saved!;
    try {
      record = await this.fillGrammarPractice(record, level, now);
    } catch {
      /* the class page offers "Write practice" */
    }
    // the clips take a while (several server rounds): Save doesn't wait for them
    return { record, introduced, audio: this.withAudio(record) };
  }

  /** Phase 46: the class's grammar points (by item id) with fewer than 3 practice sentences. */
  async grammarPointsNeedingPractice(rec: TutorSessionRow, now: Date = new Date()): Promise<string[]> {
    if (!this.options.practiceSources) return [];
    const [{ textbook, bank }, ledger] = await Promise.all([this.options.practiceSources(), this.ledger(now)]);
    const known = ledger.comprehensible().ids;
    const classSentences = classPracticeSentences(rec);
    return tutorLessonOf(rec).grammarIds.filter((id) => {
      const item = this.lexicon.grammarItemById(id);
      if (!item) return false;
      const sources = { textbook, classSentences, bank, known: (w: string) => known.has(w) };
      return countPracticeSentences(item, sources, this.lexicon) < MIN_PRACTICE_SENTENCES;
    });
  }

  private async fillGrammarPractice(rec: TutorSessionRow, level: Level, now: Date): Promise<TutorSessionRow> {
    let current = rec;
    for (const id of await this.grammarPointsNeedingPractice(rec, now)) {
      const next = await this.writeGrammarPractice(current.id, id, level, now);
      if (next) current = next;
    }
    return current;
  }

  /**
   * Phase 46 Part B.1.4 / B.3: one call on the checker chain writes practice sentences for a
   * class's grammar point from the learner's known words; they are converted and checked in code,
   * then by a fresh check, and only the ones that pass are stored with the class. `retry` ("Write
   * practice" again) is never answered from the proxy's cache. Returns the updated class, or
   * undefined when nothing was kept.
   */
  async writeGrammarPractice(
    sessionId: string,
    grammarId: string,
    level: Level,
    now: Date = new Date(),
    opts: { retry?: boolean } = {},
  ): Promise<TutorSessionRow | undefined> {
    const item = this.lexicon.grammarItemById(grammarId);
    const rec = await this.db.tutorSessions.get(sessionId);
    if (!item || !rec || !this.llm.writeGrammarPractice) return undefined;
    const [conv, ledger] = await Promise.all([this.converters(), this.ledger(now)]);
    const known = [...ledger.comprehensible().ids].flatMap((id) => {
      const w = this.lexicon.byId(id);
      return w ? [w.headword] : [];
    });
    const res = await this.llm.writeGrammarPractice(grammarPracticeRequest(item, known, level, opts.retry));
    const written = rec.sentences.filter((s) => s.written && s.grammarId === grammarId).length;
    const candidates = draftGrammarPractice(res, item, {
      lexicon: this.lexicon,
      toTaiwan: conv.toTaiwan,
      idPrefix: `${sessionId}:gp:${grammarId}:${written + now.getTime().toString(36)}`,
    }).filter((c) => !rec.sentences.some((s) => s.zh === c.zh));
    if (candidates.length === 0) return undefined;
    const check = await this.llm.checkTutorSentences({ sentences: candidates });
    const kept = acceptGrammarPractice(candidates, check, item, this.lexicon);
    if (kept.length === 0) return undefined;
    const sentences = [...rec.sentences, ...kept];
    await this.db.tutorSessions.update(sessionId, { sentences, updatedAt: now });
    return { ...rec, sentences, updatedAt: now };
  }

  /**
   * Phase 46 Part D.4: the owner's "Matched to … · Change" for one class point: an item, or null =
   * "Make this a note" (its exercise goes; answers already recorded stay with their item).
   */
  async setGrammarMatch(sessionId: string, rowIndex: number, grammarId: string | null, now: Date = new Date()): Promise<TutorSessionRow | undefined> {
    const rec = await this.db.tutorSessions.get(sessionId);
    if (!rec) return undefined;
    if (grammarId && !this.lexicon.grammarItemById(grammarId)) return undefined;
    const grammar = setTutorGrammarMatch(rec.grammar, rowIndex, grammarId);
    await this.db.tutorSessions.update(sessionId, { grammar, updatedAt: now });
    markStudyDirty();
    // a newly matched item gets its card, as at Save
    await this.introduce(now);
    return { ...rec, grammar, updatedAt: now };
  }

  /**
   * Phase 46 Parts C.2 and D.5 (once per profile): every saved class's grammar names, notes and
   * examples in Taiwan characters (OpenCC, never AI), and its matches re-checked with the stricter
   * rules (an owner's match is kept). Changed matches are listed once on the class page. Returns how
   * many classes changed.
   */
  async migrateGrammar(now: Date = new Date()): Promise<number> {
    const sessions = await this.db.tutorSessions.toArray();
    if (sessions.length === 0) return 0;
    const conv = await this.converters();
    let changed = 0;
    let matchesChanged = false;
    for (const s of sessions) {
      const { grammar, changes } = recheckTutorGrammar(s, this.lexicon, conv);
      if (JSON.stringify(grammar) === JSON.stringify(s.grammar)) continue;
      changed++;
      if (changes.length > 0) matchesChanged = true;
      await this.db.tutorSessions.update(s.id, {
        grammar,
        ...(changes.length > 0 ? { grammarRecheck: { at: now, changes } } : {}),
        updatedAt: now,
      });
    }
    if (matchesChanged) {
      markStudyDirty();
      await this.introduce(now);
    }
    return changed;
  }

  /** The class page showed "We re-checked N grammar points": not again. */
  async markGrammarRecheckSeen(sessionId: string, now: Date = new Date()): Promise<void> {
    const rec = await this.db.tutorSessions.get(sessionId);
    if (!rec?.grammarRecheck || rec.grammarRecheck.seen) return;
    await this.db.tutorSessions.update(sessionId, { grammarRecheck: { ...rec.grammarRecheck, seen: true }, updatedAt: now });
  }

  /** Phase 40 Part D.1: the class's clips (made on the server); the answer is kept on the record. */
  async withAudio(rec: TutorSessionRow): Promise<TutorSessionRow> {
    if (!this.options.audio) return rec;
    const audio = await this.options.audio(rec).catch(() => ({ status: 'error' as const, at: new Date() }));
    if (!audio) return rec;
    const next = { ...rec, audio };
    await this.db.tutorSessions.update(rec.id, { audio });
    return next;
  }

  /**
   * Phase 40 Part A.3 / C: "Re-check levels and topics" (Settings → Tutoring), also run once for
   * classes saved before Phase 40. For every saved class: its topic tags from the table (plus the
   * model's answer for unknown topics), and its custom words' level estimates (characters, then the
   * model) and topic tags. Idempotent: a second run changes nothing. Returns how many records changed.
   */
  async recheckLevelsAndTopics(now: Date = new Date(), opts: { useModel?: boolean } = {}): Promise<number> {
    const sessions = await this.db.tutorSessions.toArray();
    if (sessions.length === 0) return 0;
    const custom = new Map((await this.db.customWords.toArray()).map((w) => [w.id, w]));
    const chars = charLevelIndex(this.lexicon.allWords());
    // Phase 40 Part B: classes saved earlier lose any simplified character, by OpenCC (cn → tw) and
    // the character table, never AI. Text with no character OpenCC would change is left as it is.
    const conv = await this.converters();
    const fix = (t: string): string =>
      replaceSimplifiedChars([...t].some((c) => conv.toTraditional(c) !== c) ? conv.toTraditional(t) : t);
    let changed = 0;
    for (const s of sessions) {
      const unmapped = s.topics.filter((t) => topicTagsFor(t).length === 0);
      let topicTags: TopicTag[] = [...new Set([...(s.topicTags ?? []), ...s.topics.flatMap((t) => topicTagsFor(t))])];
      const needLevel: Array<{ key: string; zh: string; en: string; wordId: string }> = [];
      const updates = new Map<string, Word>();
      for (const w of s.words) {
        if (!w.ticked) continue;
        const cw = custom.get(w.wordId);
        const lexWord = this.lexicon.byId(w.wordId);
        if (cw) {
          // Phase 40 Part B: a word saved before the character table pass loses any simplified character
          let next: Word = {
            ...(cw as Word),
            headword: fix(cw.headword),
            variants: cw.variants.map(fix),
          };
          if (!next.level && !next.estimatedLevel) {
            const e = estimateWordLevel({ headword: next.headword, level: null }, { chars });
            if (e) next = { ...next, ...e };
          }
          if (!next.level && !next.estimatedLevel) needLevel.push({ key: w.wordId, zh: w.zh, en: w.gloss, wordId: w.wordId });
          updates.set(w.wordId, next);
        } else if (lexWord && displayLevel(lexWord) === null && !w.estimatedLevel) {
          needLevel.push({ key: w.wordId, zh: w.zh, en: w.gloss, wordId: w.wordId });
        }
      }
      let modelLevels = new Map<string, Word['level']>();
      if (opts.useModel !== false && this.llm.classifyTutorWords && (needLevel.length > 0 || unmapped.length > 0)) {
        try {
          const res = await this.llm.classifyTutorWords({
            words: needLevel.map((n) => ({ zh: n.zh, en: n.en.slice(0, 200) })).slice(0, 60),
            topics: unmapped.map((t) => ({ zh: t.zh, en: t.en })).slice(0, 12),
            tags: [...TOPIC_TAGS],
          });
          const cls = applyTutorClassify({ words: needLevel.map((n) => ({ key: n.key, zh: n.zh })) as never }, res);
          modelLevels = cls.levels;
          topicTags = [...new Set([...topicTags, ...cls.topicTags])];
        } catch {
          /* the quota: try again later */
        }
      }
      const words = s.words.map((w) => {
        const zh = fix(w.zh);
        const fixed = zh === w.zh ? w : { ...w, zh };
        const lv = modelLevels.get(w.wordId);
        return lv && !custom.has(w.wordId) && !w.estimatedLevel ? { ...fixed, estimatedLevel: lv, levelSource: 'model' as const } : fixed;
      });
      const sentences = s.sentences.map((x) => {
        const zh = fix(x.zh);
        return zh === x.zh ? x : { ...x, zh };
      });
      const customRows: CustomWordRow[] = [];
      for (const [id, w] of updates) {
        const next = tutorCustomWord(w, s.id, topicTags, modelLevels.get(id) ?? undefined);
        const before = custom.get(id)!;
        if (JSON.stringify({ ...before, updatedAt: 0 }) !== JSON.stringify({ ...next, updatedAt: 0 })) {
          const row = { ...next, updatedAt: now } as CustomWordRow;
          customRows.push(row);
          custom.set(id, row);
        }
      }
      const sameTags = JSON.stringify([...(s.topicTags ?? [])].sort()) === JSON.stringify([...topicTags].sort());
      const sameWords = JSON.stringify(words) === JSON.stringify(s.words);
      const sameSentences = JSON.stringify(sentences) === JSON.stringify(s.sentences);
      if (customRows.length === 0 && sameTags && sameWords && sameSentences) continue;
      changed++;
      await this.db.transaction('rw', this.db.tutorSessions, this.db.customWords, async () => {
        if (customRows.length > 0) await this.db.customWords.bulkPut(customRows);
        await this.db.tutorSessions.update(s.id, {
          ...(topicTags.length > 0 ? { topicTags } : {}),
          words,
          sentences,
          recheckedAt: now,
          updatedAt: now,
        });
      });
    }
    if (changed > 0) {
      markStudyDirty();
      this.options.lexiconChanged?.();
    }
    return changed;
  }

  /** Every saved class, newest first. */
  async list(): Promise<TutorSessionRow[]> {
    return (await this.db.tutorSessions.toArray()).sort((a, b) => b.date.localeCompare(a.date));
  }
}
