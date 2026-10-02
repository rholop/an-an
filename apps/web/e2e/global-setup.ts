import { rmSync } from 'node:fs';
import { syncDir } from './sync-dir.js';

/** A fresh server-side store for every e2e run. */
export default function globalSetup() {
  rmSync(syncDir(), { recursive: true, force: true });
}
