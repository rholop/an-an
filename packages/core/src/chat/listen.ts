// Phase 36: chats that listen. The pure half of the one chat turn pipeline shared by scenario
// chat and open chat: the learner's facts list, the meaning check of a reply against it, the
// "keep the meaning" feedback, and the turn loop itself (budget retries, the Taiwan retry, one
// regeneration when a reply contradicts the learner). The web app supplies the model calls and
// each mode's word-budget validation; nothing here touches storage or the network.
import type { ChatMeaningCheckRequest, ChatMeaningCheckResponse, TurnResponse } from './types.js';

export const CHAT_LISTEN_CONFIG = {
  /** Facts kept per conversation: subjects, and facts per subject. */
  maxFactSubjects: 12,
  maxFactsPerSubject: 6,
  /** Words outside the budget a reply may keep (glossed) instead of changing its meaning. */
  maxKeptWords: 2,
  /** Regenerations after a reply contradicted a fact (then it is shown with a warning). */
  maxMeaningRegenerations: 1,
} as const;

/** Added to every word-budget redo, in both chat modes. */
export const KEEP_MEANING_FEEDBACK =
  `Keep the same meaning; swap only words. If keeping the meaning needs a word outside the lists, keep that word ` +
  `(at most ${CHAT_LISTEN_CONFIG.maxKeptWords} per reply) and list it in \`kept_words\`: the app shows its meaning. ` +
  `Never change what you say, or what you say about the learner, just to fit the word lists.`;

/** The redo after a reply went against something the learner said. */
export function contradictionFeedback(fact: string, reason: string): string {
  return (
    `Your reply contradicts what the learner told you (${fact})${reason ? `: ${reason}` : ''}. ` +
    `Read the learner's last message again and answer what they actually said. Never change their facts, and ` +
    `don't present their facts as your own. ${KEEP_MEANING_FEEDBACK}`
  );
}

// ---- facts ------------------------------------------------------------------------------------

const SUBJECT_ALIASES: Record<string, readonly string[]> = {
  me: ['i', 'me', 'myself', 'learner', 'the learner', 'user', 'self'],
  mother: ['mom', 'mum', 'mama', 'mommy', 'mother'],
  father: ['dad', 'papa', 'daddy', 'father'],
  'older brother': ['big brother', 'elder brother', 'older brother'],
  'older sister': ['big sister', 'elder sister', 'older sister'],
  'younger brother': ['little brother', 'younger brother'],
  'younger sister': ['little sister', 'younger sister'],
  husband: ['husband'],
  wife: ['wife'],
  partner: ['partner', 'boyfriend', 'girlfriend', 'spouse'],
  parents: ['parents', 'mom and dad'],
  friend: ['friend', 'best friend'],
};

/** Chinese words for a subject (for the 你媽媽… statement check). */
const SUBJECT_ZH: Record<string, readonly string[]> = {
  mother: ['媽媽', '母親', '媽'],
  father: ['爸爸', '父親', '爸'],
  'older brother': ['哥哥'],
  'older sister': ['姐姐', '姊姊'],
  'younger brother': ['弟弟'],
  'younger sister': ['妹妹'],
  husband: ['先生', '老公'],
  wife: ['太太', '老婆'],
  parents: ['爸媽', '父母'],
  friend: ['朋友'],
};

/** One subject's canonical name: "My Mom" → "mother", "I" → "me". */
export function normalizeSubject(subject: string): string {
  const s = subject
    .toLowerCase()
    .replace(/^(the learner's|learner's|my|your|his|her|their)\s+/, '')
    .replace(/[^a-z' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [canonical, aliases] of Object.entries(SUBJECT_ALIASES))
    if (s === canonical || aliases.includes(s)) return canonical;
  return s || 'me';
}

export interface FactLine {
  subject: string;
  facts: string[];
}

/** "mother: doesn't work; likes gardening" → { subject: 'mother', facts: [...] }. A line with no
 * subject is about the learner. */
export function parseFactLine(line: string): FactLine | undefined {
  const text = line.trim();
  if (!text) return undefined;
  const colon = text.indexOf(':');
  const subject = colon > 0 && colon < 40 ? normalizeSubject(text.slice(0, colon)) : 'me';
  const rest = colon > 0 && colon < 40 ? text.slice(colon + 1) : text;
  const facts = rest
    .split(/[;；]/)
    .map((f) => f.trim().replace(/[.。]+$/, ''))
    .filter(Boolean);
  return facts.length > 0 ? { subject, facts } : undefined;
}

export function formatFactLines(lines: readonly FactLine[]): string[] {
  return lines.map((l) => `${l.subject}: ${l.facts.join('; ')}`);
}

const NEGATION = /\b(doesn'?t|does not|don'?t|do not|isn'?t|is not|aren'?t|are not|not|never|no longer|didn'?t|did not|can'?t|cannot|won'?t|hasn'?t|has no|have no|no)\b/i;
const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'does', 'do', 'did', 'has', 'have', 'had', 'to', 'of', 'at',
  'in', 'on', 'for', 'and', 'or', 'but', 'very', 'really', 'also', 'too', 'so', 'she', 'he', 'they', 'it', 'her', 'his',
  'their', 'your', 'my', 'you', 'i', 'me', 'we', 'our', 'with', 'every', 'day', 'much', 'quite', 'that', 'this', 'there',
  'doesn', 'don', 'isn', 'aren', 'didn', 'can', 't', 'not', 'never', 'no', 'longer', 'won', 'hasn', 'cannot', 'oh', 'wow',
  'then', 'just', 'still', 'mom', 'mum', 'mother', 'dad', 'father', 'parents',
]);

/** A rough English stem: enough to match "works" / "working" / "work". */
function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(ch|sh|x|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z' ]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w && !STOP.has(w) && !w.includes("'"))
    .map(stem);
}

const negated = (text: string) => NEGATION.test(text);

/** What a fact says without its negation ("doesn't work" and "works" share "work"). */
function factCore(fact: string): string {
  return contentWords(fact).join(' ');
}

/**
 * Merges the facts the learner just stated into the list. Same subject, same fact: kept once.
 * A fact that negates an earlier one ("works" after "doesn't work") replaces it: the learner
 * corrected themselves. Newest subjects are kept when the list is full.
 */
export function mergeFacts(
  previous: readonly string[],
  incoming: readonly string[],
  cfg: Pick<typeof CHAT_LISTEN_CONFIG, 'maxFactSubjects' | 'maxFactsPerSubject'> = CHAT_LISTEN_CONFIG,
): string[] {
  const bySubject = new Map<string, string[]>();
  const add = (line: string) => {
    const parsed = parseFactLine(line);
    if (!parsed) return;
    const list = bySubject.get(parsed.subject) ?? [];
    for (const fact of parsed.facts) {
      const core = factCore(fact);
      const same = list.findIndex((f) => f.toLowerCase() === fact.toLowerCase());
      if (same >= 0) continue;
      const head = contentWords(fact)[0];
      // same core, or the same verb with the other polarity ("doesn't work" → "works at a bank")
      const flip = core
        ? list.findIndex((f) => factCore(f) === core || (contentWords(f)[0] === head && negated(f) !== negated(fact)))
        : -1;
      if (flip >= 0) list.splice(flip, 1);
      list.push(fact);
    }
    bySubject.delete(parsed.subject); // re-insert: most recently mentioned last
    bySubject.set(parsed.subject, list.slice(-cfg.maxFactsPerSubject));
  };
  previous.forEach(add);
  incoming.forEach(add);
  const lines = [...bySubject].map(([subject, facts]) => ({ subject, facts }));
  return formatFactLines(lines.slice(-cfg.maxFactSubjects));
}

/** The facts a turn's model answer reports about the learner's last message. */
export function turnFacts(response: Pick<TurnResponse, 'learner_facts'>): string[] {
  return (response.learner_facts ?? []).map((f) => f.trim()).filter(Boolean);
}

// ---- meaning check (code first) ---------------------------------------------------------------

export type MeaningVerdict =
  | { verdict: 'ok' }
  | { verdict: 'contradicts' | 'unclear'; fact: string; reason: string };

/** Work and job words: a reply that gives a job to someone who "doesn't work". */
const JOB_WORDS = new Set(
  ['work', 'job', 'teach', 'teacher', 'office', 'company', 'nurse', 'doctor', 'engineer', 'boss', 'employee', 'business', 'profession', 'career'].map(stem),
);
const QUESTION_ZH = /[嗎呢吧？?]|什麼|誰|哪|怎麼|幾|多少|是不是|有沒有/;

function aliasPattern(subject: string, owner: 'your' | 'my'): RegExp {
  const names = [subject, ...(SUBJECT_ALIASES[subject] ?? [])].map((n) => n.replace(/\s+/g, '\\s+'));
  return new RegExp(`\\b${owner}\\s+(${names.join('|')})s?\\b`, 'i');
}

function statements(en: string): string[] {
  return en
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith('?'));
}

/** Does one English statement about a subject agree with that subject's facts? */
function compareStatement(sentence: string, subject: string, facts: readonly string[]): MeaningVerdict {
  const words = new Set(contentWords(sentence));
  const neg = negated(sentence);
  let supported = false;
  let unclear: MeaningVerdict | undefined;
  for (const fact of facts) {
    const core = contentWords(fact);
    const head = core[0];
    const fneg = negated(fact);
    // "doesn't work" against a job, a workplace or teaching
    if (fneg && head && JOB_WORDS.has(head) && !neg && [...words].some((w) => JOB_WORDS.has(w)))
      return { verdict: 'contradicts', fact: `${subject}: ${fact}`, reason: `the learner said ${subject === 'me' ? 'they' : `their ${subject}`} ${fact}` };
    if (!head || !words.has(head)) continue;
    if (neg !== fneg)
      return { verdict: 'contradicts', fact: `${subject}: ${fact}`, reason: `the reply says the opposite of "${fact}"` };
    if (core.every((w) => words.has(w))) supported = true;
    else unclear ??= { verdict: 'unclear', fact: `${subject}: ${fact}`, reason: `"${sentence}" may not match "${fact}"` };
  }
  if (supported) return { verdict: 'ok' };
  if (unclear) return unclear;
  return subject === 'me'
    ? { verdict: 'ok' }
    : { verdict: 'unclear', fact: `${subject}: ${facts.join('; ')}`, reason: `the reply says something new about the learner's ${subject}` };
}

/**
 * The cheap code check of a reply against the learner's facts: contradiction keywords (a negated
 * fact against a positive statement, a "doesn't work" against a job), then an English comparison
 * of `reply_en`. Questions never contradict anything. "unclear" means: ask the checker model.
 */
export function checkReplyMeaning(reply: { zh: string; en: string }, factLines: readonly string[]): MeaningVerdict {
  const facts = factLines.map(parseFactLine).filter((f): f is FactLine => Boolean(f));
  if (facts.length === 0) return { verdict: 'ok' };
  let worst = { verdict: 'ok' } as MeaningVerdict;
  const consider = (v: MeaningVerdict) => {
    if (v.verdict === 'contradicts') worst = v;
    else if (v.verdict === 'unclear' && worst.verdict === 'ok') worst = v;
  };
  const sentences = statements(reply.en);
  for (const { subject, facts: list } of facts) {
    const yours = subject === 'me' ? /^\s*you\b(?!r)|[,;]\s*you\b(?!r)/i : aliasPattern(subject, 'your');
    let mentioned = false;
    for (const sentence of sentences) {
      if (yours.test(sentence)) {
        mentioned = true;
        consider(compareStatement(sentence, subject, list));
      } else if (subject !== 'me' && aliasPattern(subject, 'my').test(sentence)) {
        // the NPC's own family may only echo the learner's facts if it says "too" (也)
        const words = new Set(contentWords(sentence));
        const echo = list.find((f) => {
          const core = contentWords(f);
          return core.length > 0 && core.every((w) => words.has(w));
        });
        if (echo && !/\b(too|also)\b/i.test(sentence))
          consider({ verdict: 'unclear', fact: `${subject}: ${echo}`, reason: 'the reply may present the learner’s fact as its own' });
      }
      if (worst.verdict === 'contradicts') return worst;
    }
    // Chinese: a statement about 你媽媽… that the English never mentioned (a translation gap)
    const zhNames = SUBJECT_ZH[subject] ?? [];
    if (!mentioned && zhNames.length > 0) {
      const clauses = reply.zh.split(/[，。！？,.!?；;]/);
      const about = clauses.find((c) => zhNames.some((n) => c.includes(`你${n}`) || c.includes(`你的${n}`)) && !QUESTION_ZH.test(c));
      if (about) consider({ verdict: 'unclear', fact: `${subject}: ${list.join('; ')}`, reason: `"${about}" says something about the learner's ${subject}` });
    }
  }
  return worst;
}

// ---- kept words ------------------------------------------------------------------------------

/** The words a reply kept outside the budget (at most 2), only those that are really in it. */
export function keptWords(response: Pick<TurnResponse, 'kept_words' | 'reply_zh'>, max: number = CHAT_LISTEN_CONFIG.maxKeptWords): string[] {
  const out: string[] = [];
  for (const w of response.kept_words ?? []) {
    const t = w.trim();
    if (t && response.reply_zh.includes(t) && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// ---- the turn loop ---------------------------------------------------------------------------

/** What a mode's word-budget validation says about one reply. */
export interface ChatTurnValidation {
  pass: boolean;
  /** Traditional characters and Taiwan wording only. */
  taiwanClean: boolean;
  /** The redo text for this reply (the shared "keep the meaning" line is added here). */
  feedback: string;
}

export interface ChatTurnDeps<V extends ChatTurnValidation> {
  generate(extra: { feedback?: string; alternateModel?: boolean }): Promise<TurnResponse>;
  validate(response: TurnResponse): V;
  /** Of several budget attempts, the one to show (default: the first that passed, else the last). */
  pickBest?(attempts: ReadonlyArray<{ response: TurnResponse; report: V }>): { response: TurnResponse; report: V };
  /** The checker chain, asked only when the code check is unsure. */
  checkMeaning?(req: ChatMeaningCheckRequest): Promise<ChatMeaningCheckResponse>;
  /** Facts from the turns before this one. */
  facts: readonly string[];
  learnerMessage: string;
  maxRegenerations: number;
  /** Thrown when no reply passes the Taiwan / traditional check. */
  unreliable(): Error;
}

export interface ChatTurnResult<V> {
  response: TurnResponse;
  report: V;
  /** Model calls made. */
  attempts: number;
  /** The conversation's facts after this turn. */
  facts: string[];
  /** This turn's own facts (stored with the learner's message). */
  turnFacts: string[];
  /** The reply still contradicted a fact after the regeneration ("⚠ may have misunderstood you"). */
  misunderstood: boolean;
  meaning: MeaningVerdict;
}

/** The meaning verdict: the code check, and the checker model when the code is unsure. */
export async function judgeReplyMeaning(
  response: TurnResponse,
  facts: readonly string[],
  learnerMessage: string,
  checkMeaning?: ChatTurnDeps<ChatTurnValidation>['checkMeaning'],
): Promise<MeaningVerdict> {
  const code = checkReplyMeaning({ zh: response.reply_zh, en: response.reply_en }, facts);
  if (code.verdict !== 'unclear') return code;
  if (!checkMeaning) return { verdict: 'ok' };
  try {
    const res = await checkMeaning({
      facts: [...facts].slice(-24),
      learnerMessage: learnerMessage.slice(0, 400),
      replyZh: response.reply_zh.slice(0, 400),
      replyEn: response.reply_en.slice(0, 600),
    });
    return res.contradicts ? { verdict: 'contradicts', fact: res.fact || code.fact, reason: res.reasonEn } : { verdict: 'ok' };
  } catch {
    return { verdict: 'ok' }; // the checker is a nicety: a reply is never held back by its absence
  }
}

/**
 * One chat turn, the same in every chat mode: up to `maxRegenerations` budget redos (each asking
 * to keep the meaning), one retry on the other model when the Taiwan check fails, then the meaning
 * check against the learner's facts with one regeneration on a contradiction.
 */
export async function runChatTurn<V extends ChatTurnValidation>(deps: ChatTurnDeps<V>): Promise<ChatTurnResult<V>> {
  const attempts: Array<{ response: TurnResponse; report: V }> = [];
  let feedback: string | undefined;
  let calls = 0;
  while (attempts.length <= deps.maxRegenerations) {
    calls++;
    const response = await deps.generate(feedback ? { feedback } : {});
    const report = deps.validate(response);
    attempts.push({ response, report });
    if (report.pass) break;
    feedback = `${report.feedback} ${KEEP_MEANING_FEEDBACK}`;
  }
  let best = deps.pickBest?.(attempts) ?? attempts.find((a) => a.report.pass) ?? attempts[attempts.length - 1]!;
  if (!best.report.taiwanClean) {
    calls++;
    const response = await deps.generate({ feedback: `${best.report.feedback} ${KEEP_MEANING_FEEDBACK}`, alternateModel: true });
    const report = deps.validate(response);
    if (!report.taiwanClean) throw deps.unreliable();
    best = { response, report };
  }

  let own = turnFacts(best.response);
  let facts = mergeFacts(deps.facts, own);
  let meaning = await judgeReplyMeaning(best.response, facts, deps.learnerMessage, deps.checkMeaning);
  let regenerations = 0;
  while (meaning.verdict === 'contradicts' && regenerations < CHAT_LISTEN_CONFIG.maxMeaningRegenerations) {
    regenerations++;
    calls++;
    const response = await deps.generate({ feedback: contradictionFeedback(meaning.fact, meaning.reason) });
    const report = deps.validate(response);
    if (!report.taiwanClean) break; // keep the earlier reply (it is shown with the warning)
    best = { response, report };
    own = turnFacts(response).length > 0 ? turnFacts(response) : own;
    facts = mergeFacts(deps.facts, own);
    meaning = await judgeReplyMeaning(response, facts, deps.learnerMessage, deps.checkMeaning);
  }
  return {
    response: best.response,
    report: best.report,
    attempts: calls,
    facts,
    turnFacts: own,
    misunderstood: meaning.verdict === 'contradicts',
    meaning,
  };
}
