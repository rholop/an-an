// Phase 24 Part C: reading one graded story, then its questions and the summary.
import { useEffect, useMemo, useRef, useState } from 'react';
import { glossFor, storyMinutes, storySentences, STORY_CONFIG, type Level, type Lexicon, type SkillCard, type StoryRecord } from '@anan/core';
import { AnnotatedText, type AnnotatedToken } from '../components/AnnotatedText.js';
import { ReportButton } from '../components/ReportSheet.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import { learnerService } from '../db/instance.js';
import { annotate, withReadingDisplay } from '../lib/annotate.js';
import {
  FEEDBACK_CORRECT,
  NO_QUESTIONS,
  READ_AGAIN,
  SKIP,
  START_READING,
  storyRungLabel,
  WORDS_IN_STORY,
  REPORT_THANKS,
  storyPitch,
  storyReadLine,
  storyScoreLine,
} from '../lib/labels.js';
import { useReadingSettings } from '../lib/reading.js';
import { markStudyDirty } from '../lib/study-dirty.js';
import { storyLesson } from '../lib/stories.js';
import type { StoryService, StorySummary } from '../lib/story-service.js';
import { showToast } from '../lib/toast.js';
import './StoryView.css';

interface Props {
  story: StoryRecord;
  service: StoryService;
  lexicon: Lexicon;
  level: Level;
  onExit: () => void;
  exitLabel?: string;
  /** "Continue this story" (the next episode with the same characters). */
  onContinue?: (story: StoryRecord) => void;
}

type Phase = 'words' | 'reading' | 'questions' | 'done';

export function StoryView({ story: initial, service, lexicon, level, onExit, exitLabel = '← Stories', onContinue }: Props) {
  const [story, setStory] = useState(initial);
  const { mode, script } = useReadingSettings();
  // Phase 26 Part C: the words outside rung 1, taught before the text (this lesson first).
  const lessonWords = useMemo(() => miniLessonWords(initial, lexicon, mode !== 'off'), [initial, lexicon, mode]);
  const [phase, setPhase] = useState<Phase>(() => (lessonWords.length > 0 && !initial.readAt ? 'words' : 'reading'));
  const [cards, setCards] = useState<Map<string, SkillCard>>(new Map());
  const lookedUp = useRef(new Set<string>());
  const [english, setEnglish] = useState<Set<number>>(new Set());
  const [answers, setAnswers] = useState<(number | undefined)[]>(() => initial.questions.map(() => undefined));
  const [checked, setChecked] = useState(false);
  const [qEnglish, setQEnglish] = useState(false);
  const [summary, setSummary] = useState<StorySummary | null>(null);
  const [toAdd, setToAdd] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState(false);

  useEffect(() => {
    void learnerService.allCards().then((all) =>
      setCards(new Map(all.filter((c) => c.skill === 'recognition' && c.item.kind === 'word').map((c) => [c.item.id, c]))),
    );
  }, []);

  const newWords = useMemo(
    () => new Set(story.newWords.flatMap((w) => (w.wordId ? [w.wordId, w.text] : [w.text]))),
    [story],
  );
  const paragraphs = useMemo(
    () => story.paragraphs.map((p) => withReadingDisplay(annotate(p.zh, lexicon), cards)),
    [story, lexicon, cards],
  );
  // Phase 26 C2: a word outside every list shows a small gloss on its first use in the story.
  const inlineGlosses = useMemo(() => {
    const out = story.paragraphs.map(() => new Map<string, string>());
    const seen = new Set<string>();
    for (const w of story.newWords.filter((x) => x.rung === 6)) {
      const en = lessonWords.find((x) => x.text === w.text)?.en;
      const p = story.paragraphs.findIndex((x) => x.zh.includes(w.text));
      if (!en || p < 0 || seen.has(w.text)) continue;
      seen.add(w.text);
      out[p]!.set(w.text, en.split(/[;,]/)[0]!.trim());
    }
    return out;
  }, [story, lessonWords]);
  const lesson = storyLesson(story);

  function onLookup(at: AnnotatedToken, kind: 'gloss' | 'reading') {
    if (!at.wordId) return;
    if (kind === 'gloss') lookedUp.current.add(at.wordId);
    void service.recordLookup(at.wordId, kind === 'gloss' ? 'chat_lookup_gloss' : 'chat_hover_reading', story.id).catch(() => undefined);
  }

  async function finish() {
    const right = story.questions.filter((q, i) => answers[i] === q.answer).length;
    const { story: read } = await service.finish(story, { lookedUp: lookedUp.current, right, of: story.questions.length });
    setStory(read);
    const sum = await service.summary(read, lookedUp.current);
    setSummary(sum);
    setToAdd(new Set(sum.newWords.flatMap((w) => (w.wordId && !w.inReview ? [w.wordId] : []))));
    setPhase('done');
    markStudyDirty();
  }

  function readAgain() {
    lookedUp.current = new Set();
    setAnswers(story.questions.map(() => undefined));
    setChecked(false);
    setSummary(null);
    setAdded(false);
    setEnglish(new Set());
    setPhase('reading');
    window.scrollTo(0, 0);
  }

  return (
    <div className="story-view" data-testid="story-view">
      <button type="button" className="story-back" onClick={onExit}>
        {exitLabel}
      </button>
      <header className="story-header">
        <h1 lang="zh-Hant" data-testid="story-title">
          {story.titleZh}
        </h1>
        <p className="story-sub">
          {story.titleEn} · {storyPitch(storyMinutes(story.chars), lesson)}
          {story.episode ? ` · Part ${story.episode}` : ''}
        </p>
      </header>

      {phase === 'words' && (
        <section className="story-words" data-testid="story-words">
          <h2>{WORDS_IN_STORY}</h2>
          <ul>
            {lessonWords.map((w) => (
              <li key={w.text} data-testid="story-words-item">
                <span lang="zh-Hant" className="story-words-zh">
                  {w.text}
                </span>
                {w.pinyin && <span className="story-gloss">{w.pinyin}</span>}
                <span>{w.en}</span>
                <span className="story-words-rung">{storyRungLabel(w.rung)}</span>
              </li>
            ))}
          </ul>
          <div className="story-words-actions">
            <button type="button" className="btn-primary story-primary" data-testid="story-start-reading" onClick={() => setPhase('reading')}>
              {START_READING}
            </button>
            <button type="button" className="story-skip" data-testid="story-words-skip" onClick={() => setPhase('reading')}>
              {SKIP}
            </button>
          </div>
        </section>
      )}

      {phase === 'reading' && (
        <>
          {paragraphs.map((tokens, i) => (
            <section className="story-paragraph" key={i} data-testid="story-paragraph">
              <AnnotatedText
                tokens={tokens}
                mode={mode}
                script={script}
                currentLevel={level}
                onLookup={onLookup}
                lookupSource="story"
                newWords={newWords}
                inlineGlosses={inlineGlosses[i]}
                contextText={story.paragraphs[i]!.zh}
              />
              <div className="story-paragraph-tools">
                {storySentences(story.paragraphs[i]!.zh).map((s, k) => (
                  <SpeakerButton key={k} kind="sentence" text={s} />
                ))}
                <button
                  type="button"
                  className="story-english-toggle"
                  data-testid="story-english-toggle"
                  aria-expanded={english.has(i)}
                  onClick={() =>
                    setEnglish((e) => {
                      const next = new Set(e);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                >
                  {english.has(i) ? 'Hide English' : 'English'}
                </button>
              </div>
              {english.has(i) && (
                <p className="story-english" data-testid="story-english">
                  {story.paragraphs[i]!.en}
                </p>
              )}
            </section>
          ))}
          {story.glosses.length > 0 && (
            <p className="story-glosses">
              {story.glosses.map((g) => (
                <span key={g.zh}>
                  <span lang="zh-Hant">{g.zh}</span> = {g.en}
                </span>
              ))}
            </p>
          )}
          {story.questions.length === 0 && <p className="story-gloss" data-testid="story-no-questions">{NO_QUESTIONS}</p>}
          <button
            type="button"
            className="btn-primary story-primary"
            data-testid="story-done-reading"
            onClick={() => {
              if (story.questions.length === 0) return void finish();
              setPhase('questions');
              window.scrollTo(0, 0);
            }}
          >
            {story.questions.length === 0 ? 'Finish' : 'Questions →'}
          </button>
        </>
      )}

      {phase === 'questions' && (
        <section className="story-questions" data-testid="story-questions">
          <label className="story-q-english">
            <input type="checkbox" checked={qEnglish} onChange={(e) => setQEnglish(e.target.checked)} /> Show English
          </label>
          {story.questions.map((q, i) => (
            <fieldset className="story-question" key={i} data-testid="story-question">
              <legend lang="zh-Hant">
                {i + 1}. {q.q_zh}
                {qEnglish && <span className="story-q-en"> {q.q_en}</span>}
              </legend>
              {q.options.map((o, k) => {
                const picked = answers[i] === k;
                const state = checked ? (k === q.answer ? 'right' : picked ? 'wrong' : '') : '';
                return (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={picked}
                    disabled={checked}
                    className={`story-option ${picked ? 'story-option--picked' : ''} ${state ? `story-option--${state}` : ''}`}
                    data-testid="story-option"
                    data-right={k === q.answer ? '1' : '0'}
                    onClick={() => setAnswers((a) => a.map((x, j) => (j === i ? k : x)))}
                  >
                    <span lang="zh-Hant">{o.zh}</span>
                    {qEnglish && <span className="story-q-en"> {o.en}</span>}
                  </button>
                );
              })}
              {checked && answers[i] === q.answer && <p className="story-feedback">{FEEDBACK_CORRECT}</p>}
            </fieldset>
          ))}
          {!checked ? (
            <button
              type="button"
              className="btn-primary story-primary"
              data-testid="story-check"
              disabled={answers.some((a) => a === undefined)}
              onClick={() => setChecked(true)}
            >
              Check
            </button>
          ) : (
            <button type="button" className="btn-primary story-primary" data-testid="story-finish" onClick={() => void finish()}>
              Finish
            </button>
          )}
        </section>
      )}

      {phase === 'done' && summary && (
        <section className="story-summary" data-testid="story-summary">
          <p className="story-summary-line" data-testid="story-summary-line">
            {storyReadLine(summary.chars, summary.knownShare)}
          </p>
          {story.score && <p className="story-score">{storyScoreLine(story.score.right, story.score.of)}</p>}
          {summary.newWords.length > 0 && (
            <>
              <h2>New words</h2>
              <ul className="story-new-words" data-testid="story-new-words">
                {summary.newWords.map((w) => (
                  <li key={w.wordId ?? w.text}>
                    <label>
                      <input
                        type="checkbox"
                        disabled={!w.wordId || w.inReview || added}
                        checked={!!w.wordId && (w.inReview || toAdd.has(w.wordId))}
                        onChange={(e) =>
                          setToAdd((s) => {
                            const next = new Set(s);
                            if (e.target.checked) next.add(w.wordId!);
                            else next.delete(w.wordId!);
                            return next;
                          })
                        }
                      />{' '}
                      <span lang="zh-Hant">{w.text}</span> <span className="story-gloss">{w.glossEn}</span>
                      {w.inReview && <span className="story-gloss"> · in review</span>}
                    </label>
                  </li>
                ))}
              </ul>
              {toAdd.size > 0 && (
                <button
                  type="button"
                  data-testid="story-add-review"
                  disabled={added}
                  onClick={async () => {
                    await service.addToReview([...toAdd]);
                    setAdded(true);
                    markStudyDirty();
                  }}
                >
                  {added ? 'Added to review ✓' : `Add to review (${toAdd.size})`}
                </button>
              )}
            </>
          )}
          {summary.tapped.length > 0 && (
            <p className="story-tapped" data-testid="story-tapped">
              Words you tapped: <span lang="zh-Hant">{summary.tapped.join('、')}</span>
            </p>
          )}
          <div className="story-actions">
            <button type="button" data-testid="story-read-again" onClick={readAgain}>
              {READ_AGAIN}
            </button>
            {onContinue && (
              <button type="button" data-testid="story-continue" onClick={() => onContinue(story)}>
                Continue this story
              </button>
            )}
            <button type="button" className="btn-primary" onClick={onExit}>
              Done
            </button>
          </div>
          <ReportButton
            onReport={(reason, note) =>
              void service.report(story, reason, note).then((undo) => {
                showToast(REPORT_THANKS, undo);
                onExit();
              })
            }
          />
        </section>
      )}
    </div>
  );
}

/**
 * Phase 26 Part C: the mini lesson's words: this lesson's words, then the others (next lesson,
 * coming lesson, new word), each with its meaning from the lexicon (the textbook sense for lesson
 * words) or the story's checked gloss. Rungs 3–6 are capped per difficulty (config).
 */
export function miniLessonWords(
  story: Pick<StoryRecord, 'newWords' | 'glosses' | 'difficulty'>,
  lexicon: Lexicon,
  withPinyin = true,
): Array<{ text: string; pinyin: string; en: string; rung: number }> {
  const max = STORY_CONFIG.miniLesson.maxWords[story.difficulty] ?? 6;
  const rows = story.newWords.map((w) => {
    const word = w.wordId ? lexicon.byId(w.wordId) : undefined;
    const en = word ? glossFor(word, { textbook: w.rung <= 4 }) : (story.glosses.find((g) => g.zh === w.text)?.en ?? '');
    return { text: w.text, pinyin: withPinyin ? (word?.pinyin ?? '') : '', en, rung: w.rung };
  });
  const lesson = rows.filter((r) => r.rung === 2);
  const others = rows.filter((r) => r.rung >= 3).slice(0, max);
  return [...lesson, ...others].filter((r) => r.en);
}
