// Tests only: the core package's fixture words (not part of core's public API),
// all given a level so the word jobs pick them up.
import { Lexicon } from '@anan/core';
import { FIXTURE_WORDS } from '../../../../core/src/test-fixtures/lexicon-fixture.js';
export { AUDIO_VOICES } from '@anan/core';

export const buildFixtureLexiconForTests = (): Lexicon =>
  new Lexicon(
    FIXTURE_WORDS.map((w) => ({ ...w, level: w.level ?? ('N1' as const) })),
    [],
  );
