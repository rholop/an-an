import {
  checkTaiwanness,
  type DefineResponse,
  type Sense,
  type TutorLLM,
  type Word,
} from '@anan/core';
import type { AiGlossRow, AnanDB, GlossReportRow } from '../db/schema.js';

/** Phase 7 §B6: store a "Report this definition" locally. */
export async function reportGloss(
  db: AnanDB,
  input: {
    word: Pick<Word, 'id' | 'headword' | 'pinyin'>;
    sense?: Sense;
    shownGloss: string;
    contextSentence: string;
    note?: string;
  },
  at: Date = new Date(),
): Promise<void> {
  await db.glossReports.add({
    wordId: input.word.id,
    headword: input.word.headword,
    pinyin: input.word.pinyin,
    senseId: input.sense?.id,
    shownGloss: input.shownGloss,
    contextSentence: input.contextSentence,
    note: input.note,
    at,
  });
}

const yamlString = (s: string) => JSON.stringify(s); // JSON strings are valid YAML scalars

/**
 * The list the owner can paste into data/supplement/gloss-overrides.yaml:
 * one entry per reported word with the gloss that was shown as a starting
 * point (to be corrected by hand) and the reports' context as comments.
 * AI-generated definitions of unlisted words are appended as `# review:` entries.
 */
export function exportReportsAsOverridesYaml(
  reports: readonly GlossReportRow[],
  aiGlosses: readonly AiGlossRow[] = [],
): string {
  const lines: string[] = [
    '# Reported definitions — fix `glossEn`, then paste into data/supplement/gloss-overrides.yaml',
    '# (overrides always win over generated glosses and survive rebuilds).',
    '',
  ];
  const byWord = new Map<string, GlossReportRow[]>();
  for (const r of reports)
    byWord.set(`${r.wordId}|${r.headword}`, [
      ...(byWord.get(`${r.wordId}|${r.headword}`) ?? []),
      r,
    ]);
  for (const list of byWord.values()) {
    const first = list[0]!;
    lines.push(
      `- id: ${yamlString(first.wordId)}`,
      `  word: ${yamlString(first.headword)}`,
      `  pinyin: ${yamlString(first.pinyin)}`,
      '  senses:',
      `    - glossEn: ${yamlString(first.shownGloss)}   # TODO: correct this`,
    );
    for (const r of list)
      lines.push(
        `  # reported in: ${r.contextSentence.replace(/\n/g, ' ')}${r.note ? ` — ${r.note.replace(/\n/g, ' ')}` : ''}`,
      );
    lines.push('');
  }
  for (const a of aiGlosses) {
    lines.push(
      `# review (AI-generated, not in the lexicon): ${a.word} ${a.pinyin} = ${a.glossEn}${a.contextSentence ? `   (in: ${a.contextSentence})` : ''}`,
    );
  }
  return lines.join('\n') + '\n';
}

export type AiDefinition = DefineResponse & { aiGenerated: true; cached: boolean };

export class DefineError extends Error {}

const key = (word: string, context: string | undefined) => `${word}|${context ?? ''}`;

/**
 * Phase 7 §B5: a live definition ONLY for a word that is not in the lexicon.
 * Cached (so each word costs one call), validated (short, Taiwan-traditional),
 * and labelled "AI-generated" by callers. Also the review queue for the owner.
 */
export async function defineUnlisted(
  db: AnanDB,
  llm: Pick<TutorLLM, 'defineWord'>,
  word: string,
  context?: string,
  at: Date = new Date(),
): Promise<AiDefinition> {
  const k = key(word, context);
  const cached = await db.aiGlosses.get(k);
  if (cached)
    return {
      pinyin: cached.pinyin,
      glossEn: cached.glossEn,
      noteEn: cached.noteEn,
      aiGenerated: true,
      cached: true,
    };

  const res = await llm.defineWord({ word, context });
  const gloss = res.glossEn.trim();
  if (!gloss || gloss.split(/\s+/).length > 8)
    throw new DefineError('The definition that came back was not usable.');
  if (!checkTaiwanness(gloss + (res.noteEn ?? '')).isClean)
    throw new DefineError('The definition used non-Taiwan wording.');
  await db.aiGlosses.put({
    key: k,
    word,
    pinyin: res.pinyin,
    glossEn: gloss,
    noteEn: res.noteEn,
    contextSentence: context,
    at,
  });
  return { ...res, glossEn: gloss, aiGenerated: true, cached: false };
}
