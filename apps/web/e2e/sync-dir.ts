import os from 'node:os';
import path from 'node:path';

/** Where the e2e proxy keeps its per-profile copies (shared by the config and global setup). */
export const syncDir = () => process.env.E2E_SYNC_DIR ?? path.join(os.tmpdir(), 'anan-e2e-sync');
