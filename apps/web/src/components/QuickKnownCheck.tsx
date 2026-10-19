import { useMemo, useState } from 'react';
import type { GrammarItem, Lesson, Lexicon, SentenceBankEntry } from '@anan/core';
import {
  buildGrammarCloze,
  confusableIndexFor,
  glossFor,
  newSessionSeed,
  orderSession,
  seededRng,
  sessionMeta,
  type Evidence,
  type OrderedSession,
} from '@anan/core';
import { learnerService } from '../db/instance.js';
import { logSessionOrder } from '../lib/session-recent.js';
import { peekStudySettings, updateStudySettings } from '../lib/study.js';

/** Phase 14 settings: "Mark lesson as already known". Each core word is asked once for recognition
 * (headword → meaning) and once for production (meaning → headword); each grammar point once as a
 * cloze. Only items that pass everything asked are marked. */
interface Q {
  item: { kind: 'word' | 'grammar'; id: string };
  skill: 'recognition' | 'production';
  prompt: string;
  options: string[];
  answer: string;
}

function shuffle<T>(a: T[], rng: () => number): T[] {
  const c = [...a];
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [c[i], c[j]] = [c[j]!, c[i]!];
  }
  return c;
}

export function buildQuickCheck(
  lesson: Lesson,
  lexicon: Lexicon,
  grammar: readonly GrammarItem[],
  sentences: readonly SentenceBankEntry[],
  seed: string = newSessionSeed('quick-check'),
): OrderedSession<Q> {
  // Phase 21: every random choice comes from the seed; glosses are the book's own sense.
  const rng = seededRng(`${seed}:options`);
  const proper = new Set(lesson.properNouns);
  const words = [...new Set(lesson.vocab)].filter((id) => !proper.has(id)).flatMap((id) => lexicon.byId(id) ?? []);
  const qs: Q[] = [];
  // Phase 48: options from core/confusables (close to the word, never the odd one out, never
  // filler), the lesson's words first; a word with fewer than 2 close options isn't asked (and so
  // isn't marked: it is studied as usual).
  const index = confusableIndexFor(lexicon);
  const lessonIds = new Set(words.map((x) => x.id));
  const gloss = (x: Parameters<typeof glossFor>[0]) => glossFor(x, { textbook: true }).split(/[;,(]/)[0]!.trim();
  for (const w of words) {
    const picks = index
      .pick(w, { seed: `${seed}|${w.id}`, preferred: lessonIds })
      .filter((x, i, all) => gloss(x) !== gloss(w) && all.findIndex((y) => gloss(y) === gloss(x)) === i);
    if (picks.length < 2) continue;
    qs.push({
      item: { kind: 'word', id: w.id },
      skill: 'recognition',
      prompt: w.headword,
      answer: gloss(w),
      options: shuffle([gloss(w), ...picks.map(gloss)], rng),
    });
    qs.push({
      item: { kind: 'word', id: w.id },
      skill: 'production',
      prompt: gloss(w),
      answer: w.headword,
      options: shuffle([w.headword, ...picks.map((x) => x.headword)], rng),
    });
  }
  const pool = grammar.flatMap((g) => g.focus ?? []);
  for (const gid of lesson.grammar) {
    const g = grammar.find((x) => x.id === gid);
    if (!g) continue;
    for (const s of sentences.filter((x) => x.lesson === lesson.n && x.grammarIds?.includes(gid))) {
      const c = buildGrammarCloze(s, g, pool);
      if (c) {
        qs.push({ item: { kind: 'grammar', id: gid }, skill: 'recognition', prompt: `${c.before}＿＿${c.after}`, answer: c.answer, options: c.options });
        break;
      }
    }
  }
  // Phase 19: built word by word (recognition then production), so without this each word's
  // second question followed its first and gave the answer away, in book order.
  return orderSession(
    qs,
    (q) =>
      q.item.kind === 'grammar'
        ? { keys: [`grammar:${q.item.id}`, `zh:${q.answer}`] }
        : {
            keys: [`word:${q.item.id}`, `zh:${q.skill === 'recognition' ? q.prompt : q.answer}`],
            direction: q.skill === 'recognition' ? 'zh-en' : 'en-zh',
          },
    { seed },
  );
}

export function QuickKnownCheck({
  lesson,
  lexicon,
  grammar,
  sentences,
  onClose,
}: {
  lesson: Lesson;
  lexicon: Lexicon;
  grammar: readonly GrammarItem[];
  sentences: readonly SentenceBankEntry[];
  onClose: () => void;
}) {
  const qs = useMemo(() => {
    const ordered = buildQuickCheck(lesson, lexicon, grammar, sentences);
    const meta = sessionMeta(ordered);
    logSessionOrder('quick-check', meta?.seed, ordered.length, meta?.deferred.length ?? 0);
    return ordered;
  }, [lesson, lexicon, grammar, sentences]);
  const [i, setI] = useState(0);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [marked, setMarked] = useState<number | null>(null);
  const key = (q: Q) => `${q.item.kind}:${q.item.id}`;

  async function finish(fails: Set<string>) {
    const passed = [...new Set(qs.map(key))].filter((k) => !fails.has(k));
    // Phase 21: a pass is evidence too (Learned / Mastered everywhere), not only a settings list.
    const now = new Date();
    const events: Evidence[] = qs
      .filter((q) => passed.includes(key(q)))
      .map((q) => ({ item: q.item, skill: q.skill, kind: 'known_check_passed', at: now, context: { source: 'placement' } }));
    await learnerService.recordBulk(events, now);
    await updateStudySettings({ knownItems: [...new Set([...peekStudySettings().knownItems, ...passed])] });
    setMarked(passed.length);
  }
  if (marked !== null)
    return (
      <p role="status" data-testid="quick-check-done">
        Marked {marked} of {new Set(qs.map(key)).size} items as known. <button onClick={onClose}>Close</button>
      </p>
    );
  const q = qs[i];
  if (!q) return <p>Nothing to check. <button onClick={onClose}>Close</button></p>;
  return (
    <div className="textbook-exercise" data-testid="quick-check">
      <p className="textbook-muted">
        Quick check {i + 1} / {qs.length} · {q.skill}
      </p>
      <p className="textbook-cloze" lang="zh-Hant">{q.prompt}</p>
      <div className="textbook-options">
        {q.options.map((o) => (
          <button
            key={o}
            lang="zh-Hant"
            onClick={() => {
              const f = o === q.answer ? failed : new Set(failed).add(key(q));
              setFailed(f);
              if (i + 1 >= qs.length) void finish(f);
              else setI(i + 1);
            }}
          >
            {o}
          </button>
        ))}
      </div>
      <button onClick={onClose}>Cancel</button>
    </div>
  );
}
