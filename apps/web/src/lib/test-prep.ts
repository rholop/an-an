// Phase 49: TOCFL test prep on the app side. The switch lives in the study settings (synced with the
// profile, `lib/study.ts`); results are rows of the synced `testResults` table. Every number shown
// (coverage, reading accuracy, the latest result, reminders) comes from the ledger.
import { DEFAULT_TEST_PREP, sanitizeTestPrep, type TestPrepSettings, type TestResult } from '@anan/core';
import { db } from '../db/instance.js';
import { peekStudySettings, updateStudySettings } from './study.js';

/** The stored test prep settings (defaults when never set). */
export function peekTestPrep(): TestPrepSettings {
  return sanitizeTestPrep(peekStudySettings().testPrep ?? DEFAULT_TEST_PREP);
}

/** Change the test prep settings. Switching it on (again) restarts the week-4 / week-7 reminders;
 * switching it off (End test prep) changes only the study order back: nothing is deleted. */
export async function setTestPrep(patch: Partial<TestPrepSettings>, now: Date = new Date()): Promise<void> {
  const prev = peekTestPrep();
  const next: TestPrepSettings = { ...prev, ...patch };
  if (patch.on && !prev.on) next.startedAt = now.toISOString();
  if ('testDate' in patch && !patch.testDate) delete next.testDate;
  await updateStudySettings({ testPrep: sanitizeTestPrep(next) });
}

/** Log a mock or official result (a score or a level per skill). */
export async function addTestResult(r: Omit<TestResult, 'id' | 'createdAt' | 'updatedAt'>, now: Date = new Date()): Promise<TestResult> {
  const row: TestResult = { ...r, id: globalThis.crypto.randomUUID(), createdAt: now, updatedAt: now };
  await db.testResults.put(row);
  return row;
}

/** Remove a result (kept as removed so the removal syncs). */
export async function removeTestResult(id: string): Promise<void> {
  await db.testResults.update(id, { deleted: true });
}

/** Undo a removal. */
export async function restoreTestResult(id: string): Promise<void> {
  await db.testResults.update(id, { deleted: false });
}
