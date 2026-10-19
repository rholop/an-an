# Challenging options (Phase 48)

## The owner rule

> "I need the options to be challenging." (Ezra, 2026-10-19)

The screenshots that set it off were two Review "Pick the Mandarin" cards:

- "usually, normally" → 平常 / 廚師 / 醫師 / 老師
- "ice cream" → 冰淇淋 / 星期五 / 星期四 / 星期日

In both, the three wrong options were a set (all …師, all 星期…), so the answer was the only one that
didn't fit. You could pick it without knowing the word.

The rule (also in `CLAUDE.md` → Conventions) applies to **every choice exercise**: Review Pick the
Mandarin, Cloze multiple choice and word bank, grammar choices, Listening, Pinyin & tones, and the
lesson's "I already know this lesson" check.

1. The right answer is **never the odd one out**.
2. Every wrong option is **close to the answer** on at least one axis (below).
3. The wrong options never share a character, prefix, suffix or meaning category **with each other**
   that the answer lacks.
4. **No random filler.** When fewer options are close, the exercise shows fewer (3 instead of 4), and
   with fewer than 3 it asks another way (Review: Recall; Cloze: typed; Listening: type what you hear;
   Pinyin & tones: another exercise).
5. No option is also a correct answer (a synonym, a variant, another sense of the same characters,
   or the Taiwan / mainland pair of the word).

## The axes

An option is close to the answer when it shares at least one of these (`axesBetween` in
`packages/core/src/confusables/fair.ts`):

| Axis | Meaning | Example |
|---|---|---|
| `char` | a character in common, in the same or the next position | 平常 → 常常, 非常, 平安 |
| `shape` | a look-alike character in the same position (Unihan radical, strokes and phonetic, plus a hand-checked list of classic pairs); in a longer word more than half of it the same or alike | 買 → 賣, 己 → 已 |
| `sound` | the same syllables in any tone, or a near sound (zh/z, ch/c, sh/s, -n/-ng); in a longer word at least half of the syllables the same in the same place | 湯 → 糖 / 躺, 老師 → 老實 |
| `meaning` | the same part of speech and a meaning category in common | 冰淇淋 → 巧克力 / 三明治 / 牛肉麵 |
| `confused` | the learner picked it for this word before (their own mix-ups) | |

**Meaning categories** (`categories.ts`) are hand-made and narrow: food and drink, meals, days of the
week, months, times of day, jobs, family, frequency (平常, 常常, 總是), degree, colours, the body,
transport, places, rooms, things, people, holidays, everyday verbs (say/read/write, go/come/walk,
eat/buy/wear, think/know/like), adjectives (good/expensive/busy, feelings, tastes, size,
temperature) and the closed word classes matched by part of speech (measure words, particles,
prepositions, conjunctions, modal verbs). A word is in a category when its English gloss (the one the
app shows, and the primary one) names it. The dictionary's other senses are not used: they are too
noisy (公車 "coach", 老師 "Taoist clergy leader").

## Picking a set (`ConfusableIndex.pick`)

1. **Candidates**: every same-length word close on an axis, from the offline table (below) and the
   same code axes computed live (so tutoring and custom words, which are in the lexicon the moment
   they are saved, get candidates too, with no AI at Save). Never a name, never a word that is also
   right.
2. **Who may appear**: words the learner knows (or has in review, or at their current level), their
   own mix-ups, and words they haven't met at or below **their level + 1** (or the word's own level).
   Dictionary extras only when they have a level of their own: a level estimated from easy
   characters (每常, 周口店) is not enough.
3. **Mix the axes**: a mix-up first, then one look-alike (`char` / `shape`), one sound-alike and one
   meaning neighbour, so no single shortcut finds the answer; then the closest of the rest.
4. **No odd one out**: an option that would make the wrong options share something the answer lacks
   (`oddOneOut`) is skipped for the next candidate.
5. **Harder as the card gets stronger**: after 2 right picks in a row (`pickIsHard`), the closest
   candidates first (several axes, a shared character and the same category).

Modes per exercise:

| Exercise | Mode | Axes |
|---|---|---|
| Review Pick the Mandarin, the lesson check, Cloze without a sentence | `any` | all |
| Cloze with a sentence | `cloze` | char, shape, sound; never a meaning neighbour (常常 would fit 我平常七點起床 too) |
| Pinyin & tones look-alikes | `visual` | char, shape; never the same reading (the pinyin is shown) |
| Pinyin & tones homophones, Listening hear-and-pick | `sound` | sound; Listening never a word read exactly the same |
| Grammar fill the pattern / grammar cloze | `fairGrammarDistractors` | markers that compete in the same slot first (跟 / 和 / 在 / 給, 還 / 才 / 就 / 都), then a similar length; `oddOneOut` on the text |

## The offline table

`pnpm build:distractors` writes `data/build/distractors.v1.json`: for every studyable word (TOCFL
N1–L3, textbook words with lesson extras, custom words) up to 8 candidates with their axes, near the
word's own level first. The web app ships it hashed as `lexicon/distractors.v1.json`
(`pnpm --filter @anan/web sync:lexicon`, Phase 38) and attaches it to the index.

Rebuild it after the lexicon changes (`pnpm pipeline:build`, a curriculum import), then commit it.

### Optional Gemini suggestions

`pnpm build:distractors --suggest` first asks Gemini (the turn chain, free tier, batch reserve, the
proxy's quota tracker; Phase 33) for up to 6 "plausible but wrong for this gloss" same-length Taiwan
words per word, 50 words per request. Every suggestion is checked in code (`checkSuggestion`: in the
lexicon, same length, traditional characters only, not also correct, not a name) and only the ones
that pass are kept in `data/build/distractor-suggestions.v1.json` (committed). They count as
`meaning` candidates. It resumes where it stopped: `--status` (words asked and left), `--max-calls N`,
`--model M`. Without a key or quota the table still builds from the code axes.

## Checks

- Unit tests: `packages/core/src/confusables/fair.test.ts` (the owner's two sets, fair sets, every
  option close, fewer rather than filler, level cap, hard mode, Cloze without meaning neighbours),
  plus the Cloze, Listening, Pinyin, grammar and lesson-check tests.
- `pnpm audit:distractors` (CI) builds the Pick set for every TOCFL N1–L1 and textbook word with a
  fixed seed and an A1 beginner's known words (TOCFL N1–L1 and book 1; options up to L2). It fails on
  any odd-one-out set, any option not close to the answer, or more than 5% of words with fewer than 3
  options. Report: `docs/distractors-audit.md` (worst 50).
- Playwright: `apps/web/e2e/challenging-options.spec.ts` (平常 and 冰淇淋 with the jobs and days
  known).

## Adding a choice exercise

Take its options from `core/confusables` (`ConfusableIndex.pick` / `confusableIndexFor(lexicon)`, or
`fairGrammarDistractors` for grammar markers), show fewer options when fewer come back, and add the
exercise to the audit or a test with `oddOneOut`.
