// Phase 14: a tiny change signal so the study focus is recomputed after learning evidence,
// without the database layer importing the study service (which imports the database).
const listeners = new Set<() => void>();
let version = 0;
export const studyVersion = () => version;
export function markStudyDirty(): void {
  version++;
  listeners.forEach((l) => l());
}
export function onStudyDirty(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
