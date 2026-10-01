# Phase 1 brief: Data layer

> Paste this into Claude Code with `CLAUDE.md` (00-CLAUDE.md) already at the repo root.

## Goal

Build the preprocessed Taiwan Mandarin lexicon everything else runs on, plus the `core` functions that segment Chinese text, look words up, resolve readings in context, and render pinyin/zhuyin with a hover mode. At the end, the web app has one "reader" page where you paste traditional Chinese and see it segmented, levelled, and annotated.

## Scope

1. **Monorepo scaffold** per `CLAUDE.md` (pnpm workspaces, TS strict, Vitest, ESLint/Prettier, `apps/web` Vite React shell).
2. **Import pipeline** (`packages/data-pipeline`):
   - Read the official SC-TOP 8,000-word list from `data/raw/` (xlsx/ods/csv; support whichever the downloaded file is). Do not scrape third-party sites.
   - **Normalize** messy rows: alternate forms in one cell (`/`, `、`, parentheses), optional characters (e.g. `(一)點`), multiple POS on one line, homographs, stray whitespace and full-width punctuation.
   - Split one row into multiple `Word` entries when it holds unrelated senses or readings.
   - Generate **stable IDs**: hash of `headword + normalized reading + sense key`, prefixed `tocfl-`. Store a mapping file so a re-import with the same entry keeps the same ID.
   - Emit `data/build/review-report.md` listing every row the normalizer changed, split, or couldn't parse, with the raw text. This is for a human to read.
3. **Reading verification**:
   - Load MOE dictionary data (e.g. the g0v moedict JSON export or the official download) from `data/raw/`.
   - For each word, compare the list's pinyin with MOE's. Use MOE's where they disagree, and record the mismatch in the review report.
   - Derive zhuyin from MOE (not from a pinyin→zhuyin converter) wherever MOE has the word; fall back to a tested pinyin→zhuyin converter and flag it.
   - Glosses: use the list's English; fall back to CC-CEDICT only if empty, and tag `gloss:cedict`.
4. **Supplement layer**: `data/supplement/*.yaml` for hand-curated entries (particles 喔 啦 欸 蛤 耶 吧, fillers, chunks like 不好意思, 沒關係, Taiwan-specific terms, NPC names). Same `Word` shape, `source: 'supplement'`, `level: null` or an assigned level.
5. **Mainland-term blocklist**: `data/supplement/mainland-terms.yaml` mapping mainland → Taiwan forms (地铁/地鐵→捷運, 摩托车→機車, 出租车→計程車, 软件→軟體, 视频→影片, 信息→資訊, 质量→品質 …). Plus a simplified-character detector (any char that is simplified-only).
6. **Build output**: `data/build/lexicon.v{N}.json` (words + grammar items + char index + metadata: version, source hashes, build date). Also a compact form the web app can lazy-load (gzip/brotli JSON is fine; don't over-engineer). A `CHANGELOG` entry and an ID-migration map when entries are removed or merged.
7. **Core functions** (`packages/core`):
   - `Lexicon` class: `lookup(text)`, `byId(id)`, `prefixesOf(text, pos)` (for segmentation), `charInfo(ch)`.
   - `segment(text, lexicon): Token[]`: bidirectional maximum matching over the lexicon, preferring fewer tokens and fewer single-char tokens; numbers, Latin, punctuation and names pass through as typed tokens. Accept optional **hint tokens** (from an LLM) and reconcile: keep a hint if it's in the lexicon or whitelist, else re-segment that span.
   - `resolveReading(token, context): { pinyin, zhuyin, confidence }`: phrase-level lookup first; for heteronym single characters (了 得 行 長 重 還 著 為 地 的 調 樂 覺 …) use small context rules and mark `confidence: 'low'` when unsure. Never char-by-char for multi-char words.
   - `levelOf(token)`, `coverage(tokens, knownSet)` stubs for Phase 3 (just compute per-level counts now).
   - `checkTaiwanness(text)`: returns simplified chars and mainland terms found.
8. **Renderer** (`apps/web`): `<AnnotatedText tokens mode>` where mode ∈ `always | hover | off | tone-only`, and script ∈ `pinyin | zhuyin | both`.
   - Zhuyin: right-side vertical ruby for horizontal text. Build a test page first comparing (a) CSS `ruby-position: inter-character`, (b) a custom flex/grid layout per character, (c) a zhuyin OpenType font with built-in annotations. Pick the one that works in Chrome, Safari (iOS) and Firefox and document why.
   - Hover/tap on a token shows reading + gloss + level in a popover. The component emits `onLookup(tokenId, kind: 'gloss' | 'reading')` events; Phase 2 turns these into evidence. For now just log them.
   - Tone-only mode: tone marks above characters without letters (use tone contour glyphs or diacritics on a placeholder).
9. **Reader page**: paste text → segmented, annotated, per-token level colour, Taiwan-ness warnings.

## Non-goals

- No learner model, scheduling or persistence of progress (Phase 2).
- No LLM calls (Phase 3). The example-sentence bank is Phase 4.
- No TBCL list import. Keep the importer pluggable so it can be added.
- No audio (the game is text-only).

## Acceptance criteria

- `pnpm pipeline:build` produces `lexicon.v1.json` from the raw files with zero crashes, and a review report. Entry count is within a few percent of the source's row count (splits and merges explained in the report).
- Re-running the build on unchanged input produces byte-identical output and identical IDs.
- Readings: every word has pinyin + zhuyin; every MOE mismatch and every non-MOE zhuyin is listed in the report.
- Segmenter tests pass on at least 40 hand-written Taiwan sentences, including: 我們搭捷運去便利商店, 他還沒還我錢, 這條路很長 / 他是我們的班長, 我覺得睡覺很重要, 你吃飯了嗎？, NPC names, numbers like 150塊.
- `resolveReading` returns the correct reading for each heteronym in those tests, or `confidence: 'low'`, never a confident wrong answer.
- `checkTaiwanness` flags every entry in the blocklist and any simplified character.
- Reader page renders all four modes and both scripts; zhuyin displays correctly in Chrome, Safari and Firefox (screenshots committed in `docs/zhuyin-rendering.md`).
- `packages/core` has no imports from DOM, Dexie or Node built-ins (enforce with an ESLint rule).

## Dependencies

None. This is the foundation.

## Hand-off to Phase 2

`Lexicon`, `segment`, `resolveReading`, `AnnotatedText` with lookup events, and the stable-ID lexicon file.
