#!/usr/bin/env tsx
/**
 * `pnpm curriculum:plan <bookId>` — write data/curriculum/<bookId>/lesson-plan.md
 * (a draft for the owner to edit) from the imported book. Never overwrites an
 * existing plan: the edited file is the source of truth for content generation.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { courseLessonLevel, LAIXUE_COURSE, type TextbookFile } from '@anan/core';
import { draftPlan } from './lib/curriculum/lesson-plan.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const bookId = process.argv[2];
if (!bookId) {
  console.error('usage: curriculum:plan <bookId>');
  process.exit(2);
}
const dir = path.join(REPO, 'data/curriculum', bookId);
const bookFile = path.join(dir, 'book.json');
if (!existsSync(bookFile)) throw new Error(`Import ${bookId} first (pnpm curriculum:import ${bookId}).`);
const out = path.join(dir, 'lesson-plan.md');
if (existsSync(out)) {
  console.log(`${out} already exists — leaving your edits alone.`);
} else {
  const book = (JSON.parse(readFileSync(bookFile, 'utf8')) as TextbookFile).textbook;
  writeFileSync(out, draftPlan(book, (n) => courseLessonLevel(LAIXUE_COURSE, bookId, n)), 'utf8');
  console.log(`Wrote draft ${out} — skim and edit it, then run curriculum:content ${bookId}.`);
}
