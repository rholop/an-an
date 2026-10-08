import type { AnnotationMode, AnnotationScript } from '../components/AnnotatedText.js';
import { useSetting } from './useSetting.js';

/**
 * Phase 21 Part I: ONE reading setting (script + fading mode), set in Settings and respected in
 * every tab (Reader, Chat, Open chat, Review backs, Cloze feedback, Listen, leech panel, popover
 * header). Textbook, Journal and Garden show the reading always, in the chosen script.
 * The storage keys predate the setting's move out of the Reader, so they keep their names.
 */
export const READING_SCRIPT_KEY = 'readerScript';
export const READING_MODE_KEY = 'readerMode';
export const ANSWER_INPUT_KEY = 'answerInputMode';

export type AnswerInputMode = 'characters' | 'pinyin' | 'zhuyin';

export function useReadingSettings(): {
  script: AnnotationScript;
  mode: AnnotationMode;
  setScript: (s: AnnotationScript) => void;
  setMode: (m: AnnotationMode) => void;
} {
  const [script, setScript] = useSetting<AnnotationScript>(READING_SCRIPT_KEY, 'pinyin');
  const [mode, setMode] = useSetting<AnnotationMode>(READING_MODE_KEY, 'always');
  return { script, mode, setScript, setMode };
}

/** A word's reading as text, the chosen script first ("kā fēi", "ㄎㄚ ㄈㄟ", "kā fēi · ㄎㄚ ㄈㄟ"). */
export function readingText(r: { pinyin: string; zhuyin: string }, script: AnnotationScript): string {
  if (script === 'zhuyin') return r.zhuyin || r.pinyin;
  if (script === 'both') return [r.pinyin, r.zhuyin].filter(Boolean).join(' · ');
  return r.pinyin || r.zhuyin;
}

/** The input mode for typed answers (Cloze, journal error items, Listen dictation): remembered
 * across them; until chosen it follows the reading setting. */
export function useAnswerInputMode(): [AnswerInputMode, (m: AnswerInputMode) => void] {
  const { script } = useReadingSettings();
  const [stored, set] = useSetting<AnswerInputMode | null>(ANSWER_INPUT_KEY, null);
  return [stored ?? (script === 'zhuyin' ? 'zhuyin' : 'pinyin'), set];
}
