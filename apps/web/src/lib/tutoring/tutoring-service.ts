// Phase 39: a tutoring class from its summary PDF. Extraction and the sentence check make a draft;
// nothing is stored until Save (the session record and the custom words it needs, in one
// transaction). Phase 40: the ticked words are then introduced at once with every face, in review
// right away (`introduce`); levels and topics the code can't work out take one checked call.
import {
  applyTutorCheck,
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
    // the clips take a while (several server rounds): Save doesn't wait for them
    const record = saved!;
    return { record, introduced, audio: this.withAudio(record) };
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
