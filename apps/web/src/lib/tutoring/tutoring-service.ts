// Phase 39: a tutoring class from its summary PDF. Extraction and the sentence check make a draft;
// nothing is stored until Save (the session record and the custom words it needs, in one
// transaction). The ticked words are then introduced at once (`introduce`), 20 a session.
import {
  applyTutorCheck,
  buildTutorDraft,
  draftSentencesToCheck,
  finalizeTutorSession,
  tutorScenario,
  tutorScenarioRequest,
  type Ledger,
  type Level,
  type Lexicon,
  type TutorDraft,
  type TutorExtraction,
  type TutoringLLM,
  type TutorPageImage,
  type TutorScenarioResponse,
} from '@anan/core';
import type { AnanDB, TutorSessionRow } from '../../db/schema.js';
import { markStudyDirty } from '../study-dirty.js';
import type { TaiwanConverters } from './opencc.js';

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
  ) {}

  /** Part A: one extraction call with every page, then the draft. A quota stop throws (nothing kept). */
  async draftFromPages(pages: TutorPageImage[], now: Date = new Date()): Promise<DraftResult> {
    const extraction = await this.llm.extractTutorSummary({ pages });
    return this.draftFromExtraction(extraction, now);
  }

  /** Part B: Taiwan characters and words, the word list, the learner's progress, then one check. */
  async draftFromExtraction(extraction: TutorExtraction, now: Date = new Date()): Promise<DraftResult> {
    const [conv, ledger] = await Promise.all([this.converters(), this.ledger(now)]);
    let draft = buildTutorDraft(extraction, {
      lexicon: this.lexicon,
      ...conv,
      learned: (ref) => ledger.learned(ref),
      comprehensibleIds: ledger.comprehensible().ids,
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
  async save(draft: TutorDraft, level: Level, now: Date = new Date()): Promise<{ record: TutorSessionRow; introduced: number }> {
    let res: TutorScenarioResponse | undefined;
    try {
      res = await this.llm.writeTutorScenario(tutorScenarioRequest(draft, level));
    } catch {
      res = undefined; // the plain scenario built from the topics
    }
    const scenario = tutorScenario(draft, res);
    let saved: TutorSessionRow | undefined;
    await this.db.transaction('rw', this.db.tutorSessions, this.db.customWords, async () => {
      const existing = await this.db.tutorSessions.get(draft.sessionId);
      const { record, customWords } = finalizeTutorSession(draft, { now, scenario, ...(existing ? { existing } : {}) });
      if (customWords.length > 0) await this.db.customWords.bulkPut(customWords);
      await this.db.tutorSessions.put(record);
      saved = record;
    });
    markStudyDirty();
    // Owner, 2026-10-13: the class's words go into study right away (not held by the allowance).
    const introduced = await this.introduce(now);
    return { record: saved!, introduced };
  }

  /** Every saved class, newest first. */
  async list(): Promise<TutorSessionRow[]> {
    return (await this.db.tutorSessions.toArray()).sort((a, b) => b.date.localeCompare(a.date));
  }
}
