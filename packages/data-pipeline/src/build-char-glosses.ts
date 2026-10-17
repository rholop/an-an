// Phase 44: rebuild data/build/char-glosses.brief.v1.json from char-glosses.v1.json without a full
// lexicon build (Unihan_Readings.txt is only needed for the full file). build-lexicon does this too.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBriefCharGlosses } from './lib/char-glosses.js';

const BUILD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/build');
const n = writeBriefCharGlosses(path.join(BUILD_DIR, 'char-glosses.v1.json'), path.join(BUILD_DIR, 'char-glosses.brief.v1.json'));
console.log(`char-glosses: ${n} characters -> data/build/char-glosses.brief.v1.json`);
