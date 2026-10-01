// Dexie needs a real(ish) IndexedDB; fake-indexeddb polyfills it for the
// Node-based vitest environment so the Dexie-backed LearnerRepo can be unit
// tested without spinning up a browser.
import 'fake-indexeddb/auto';
