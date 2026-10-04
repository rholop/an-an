# Class textbook: 來學華語 (books 1–4, Phases 12–13)

The four volumes are **one continuous course**. `packages/core/src/textbook/course.ts` holds the
structure (books, lesson counts, level per book); every lesson has a global order, book 1 L1 … book 4 L10.

| Book | PDF | Level (owner) | App level |
|---|---|---|---|
| `laixue-1` 第一冊 | `laixue-1.pdf` | pre-A1 | N1 |
| `laixue-2` 第二冊 | `laixue-2.pdf` | A1 | L1 入門級 · A1 |
| `laixue-3` 第三冊 | `laixue-3.pdf` | A2 | L2 基礎級 · A2 |
| `laixue-4` 第四冊 | `laixue-4.pdf` | A2–B1 | L2 for lessons 1–5, L3 for 6–10 |

A word's level comes from the lexicon (TOCFL) where it exists; the book's level is only used for words that aren't in TOCFL.

## Rebuild
1. PDFs in `data/raw/textbook/laixue-N.pdf` (gitignored; needs `pip install pymupdf`).
2. Each book has `data/curriculum/laixue-N/config.json`: lesson start pages, section heading regexes, appendix index pages, stated word/grammar counts, extra names/words, explanations of any difference from the stated numbers. The importer reads it; nothing is hard-coded for book 1.
3. `pnpm curriculum:import <bookId|all>` → `book.json`, `data/supplement/textbook-<bookId>.yaml`, private dialogues/examples, `import-report.md`. With `all` the lexicon is rebuilt between books so a repeated word links to the earlier book's item.
4. `pnpm curriculum:plan <bookId>` writes `lesson-plan.md` (topic, objectives, scenario idea + NPC, three journal prompts per lesson) **for the owner to skim and edit**. It never overwrites an existing file.
5. `pnpm curriculum:content <bookId|all>` validates `content/LNN.yaml` (sentences, scenarios, prompts) against the course-scoped vocabulary, **refuses to run for books 2–4 without `lesson-plan.md`**, and requires scenarios/NPCs/prompt counts to match the (edited) plan.
6. `pnpm curriculum:build` does all of it in order; `pnpm --filter @anan/web sync:textbook` copies the public files (also part of dev/build).

## Book 3's PDF
Its body fonts carry no Unicode map, so the text comes out as garbage. `python/extract_pages.py --glyph-decode` decodes by glyph id (Big5 order for the zhuyin font, a table for polyphone forms and pinyin vowels), and every headword is cross-checked against the appendix index. Decode errors show up as locator mismatches in `import-report.md` (all 296 index entries are confirmed).

## Import reports
Each report lists counts per lesson, the difference from the book's stated numbers (explained from `config.json`), words an earlier book already taught, sentence-pattern entries kept out of the lexicon, and a cross-check of every appendix-index `lesson-n` locator against the parsed lesson entries.

| Book | stated words / parsed | stated grammar / listed |
|---|---|---|
| 1 | 223 / 225 entries, 223 word+sense | 34 / 34 |
| 2 | 274 / 274 | 34 / 34 |
| 3 | 290 / 296 (index and lessons agree; see the report) | 40 / 40 (以前 and 以後 listed separately) |
| 4 | 328 / 328 | 38 / 38 |

## One item, many lessons
Tags are `textbook:laixue-3` and `textbook:laixue-3:L05`. A word or grammar point taught in several books is **one** item that carries a tag for every book/lesson that teaches it; its home lesson is the first in course order (`homeLessonOfTags`). Grammar tables are `grammar.yaml` per book; a point taught again is listed with `reteaches: true` and only adds its tag to the earlier item (以後, 從…到…).

## "My class" = book + lesson
Everything before that point in the course counts as covered (`introduced`), the current lesson is top priority and only the next lesson trickles in, across book boundaries. A Phase 12 setting `(laixue-1, n)` is already a valid value; its stored `coveredThrough` is a course position that equals `n` for book 1, so profiles migrate with identical queues (tests in `my-class.test.ts` and `textbook.test.ts`). Validator scope for a scenario = learner's known set ∪ all course words up to and including its lesson ∪ its proper nouns.

## Level picker
Textbook scenarios, sentences and prompts carry the level of their book/lesson. The header picker shows your level first, easier ones below, harder hidden (`filterByLevel`); due reviews are never hidden. The picker shows the CEFR band (`L1 入門級 · A1`); with My class on, a hint names the book's level and never changes your choice.

## Copyright
The books are OCAC's. `data/raw/textbook/` and `data/curriculum/*/private/` are gitignored. Dialogues and worked examples are served only by the proxy at `/v1/textbook/<bookId>/{dialogues,examples}` behind the household code (401 without it). On the server, copy each book's `private/` by hand and point `TEXTBOOK_DIR` at the folder holding `laixue-N/private/`.
`book.json`, our sentences, scenarios and prompts contain no book text (tests enforce that for every book, including exact sentence matches).

## Notes
- Lesson content (sentences, scenarios, prompts) for all four books was written by hand (no LLM key is configured for the pipeline) and checked by the same validator LLM output must pass. Books 3–4 get longer scenarios (5 / 6+ goal steps) and prompts that ask for a paragraph using two grammar points. Spot-check it.
- Grammar explanations are original; patterns follow the books. Mainland terms the books teach (e.g. 地鐵) are not used in generated content.
- The badge now reads `來學華語 2 · L5` for every book (book 1 included).
