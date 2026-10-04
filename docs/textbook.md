# Phase 12: class textbook (來學華語 第一冊)

## Rebuild
1. PDF at `data/raw/textbook/laixue-1.pdf` (gitignored; needs `pip install pymupdf`).
2. `pnpm curriculum:build` = import (pages → `book.json`, `data/supplement/textbook-laixue-1.yaml`, private dialogues/examples, `import-report.md`) → content build (validates `data/curriculum/laixue-1/content/LNN.yaml`: sentences, scenarios, journal prompts) → lexicon → scenarios.
3. `pnpm --filter @anan/web sync:textbook` (also part of dev/build).

## Copyright
The book is OCAC's. `data/raw/textbook/` and `data/curriculum/laixue-1/private/` are gitignored. The book's dialogues and worked examples are served only by the proxy at `/v1/textbook/laixue-1/{dialogues,examples}` behind the household code (401 without it). On the server, copy `private/` by hand and point `TEXTBOOK_DIR` at the folder holding `laixue-1/private/`.
`book.json`, our sentences, scenarios and prompts contain no book text (a test enforces that).

## Notes
- Lesson content (sentences, scenarios, prompts) was written by hand and checked by the same validator LLM output must pass (no LLM key was configured). Spot-check it.
- Grammar points are hand-transcribed (`lib/curriculum/grammar-points.ts`); explanations are original.
- "My class" lives in the synced `settings` table (`myClass`). Turning it off restores previous behaviour.
