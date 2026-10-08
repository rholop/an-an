// Phase 24 Part C: the Stories section at the top of the Reader: Next story, Easier / Harder,
// the topic picker and the library (newest first, lesson badge, read / unread).
import { useEffect, useState } from 'react';
import { storyMinutes, type Level, type Lexicon, type StoryDifficulty, type StoryRecord } from '@anan/core';
import { lessonLabel, EASIER_NOW, NEXT_STORY, STORIES, STORY_DIFFICULTY, STORY_UNAVAILABLE, STORY_WRITING, storyPitch } from '../lib/labels.js';
import { onStudyDirty } from '../lib/study-dirty.js';
import { FAKE_STORY_KEY, canWriteStories, prepareStories, storyFakeOn, storyLesson, useStoryDifficulty } from '../lib/stories.js';
import { STORY_TOPIC_CHIPS, StoryUnavailableError, type StoryAsk, type StoryService } from '../lib/story-service.js';
import './StoryView.css';

interface Props {
  service: StoryService;
  lexicon: Lexicon;
  level: Level;
  onOpen: (story: StoryRecord) => void;
  /** Dev: the fake writer switch changed. */
  onFakeChange?: (on: boolean) => void;
}

type TopicPick = { kind: 'lesson' } | { kind: 'chip'; text: string } | { kind: 'journal' } | { kind: 'continue' } | { kind: 'typed' };

export function StoriesSection({ service, level, onOpen, onFakeChange }: Props) {
  const [difficulty, setDifficulty] = useStoryDifficulty();
  const [library, setLibrary] = useState<StoryRecord[]>([]);
  const [ready, setReady] = useState<StoryRecord[]>([]);
  const [easier, setEasier] = useState<StoryRecord[]>([]);
  const [lessonTopic, setLessonTopic] = useState('');
  const [pick, setPick] = useState<TopicPick>({ kind: 'lesson' });
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [fake, setFake] = useState(storyFakeOn());
  useEffect(() => onStudyDirty(() => setTick((t) => t + 1)), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const now = new Date();
      const [lib, rdy, again, { ladder }] = await Promise.all([
        service.library(),
        service.readyFor(level, now),
        service.rereads(now),
        service.ladderFor(level, now),
      ]);
      if (cancelled) return;
      setLibrary(lib);
      setReady(rdy);
      setEasier(again);
      setLessonTopic(service.lessonTopic(ladder));
      prepareStories(service, level, difficulty, ladder.lessons.active?.lessonId ?? '-');
    })();
    return () => {
      cancelled = true;
    };
  }, [service, level, difficulty, tick]);

  const lastRead = library.find((s) => s.readAt);

  async function run(ask: Omit<StoryAsk, 'level' | 'difficulty'> | 'next') {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const story = ask === 'next' ? await service.next(level, difficulty) : await service.write({ ...ask, level, difficulty });
      setTick((t) => t + 1);
      onOpen(story);
    } catch (err) {
      setError(err instanceof StoryUnavailableError ? STORY_UNAVAILABLE : `${STORY_UNAVAILABLE} (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      setBusy(false);
    }
  }

  function writeChosen() {
    if (pick.kind === 'lesson') return void run('next');
    if (pick.kind === 'chip') return void run({ kind: 'chip', text: pick.text });
    if (pick.kind === 'journal') return void run({ kind: 'journal' });
    if (pick.kind === 'continue' && lastRead) return void run({ kind: 'continue', continueFrom: lastRead });
    if (pick.kind === 'typed' && typed.trim()) return void run({ kind: 'typed', text: typed });
  }

  const next = ready.find((s) => s.difficulty === difficulty) ?? ready[0];
  const canWrite = canWriteStories(fake);

  return (
    <section className="stories-section" data-testid="stories-section" aria-labelledby="stories-h">
      <h2 id="stories-h">📖 {STORIES}</h2>
      <p className="stories-pitch" data-testid="stories-pitch">
        {next ? storyPitch(storyMinutes(next.chars), storyLesson(next)) : `Short stories made from words you know. Topic: ${lessonTopic || '…'}`}
      </p>
      <div className="stories-row">
        <button type="button" className="btn-primary" data-testid="next-story" disabled={busy || (!next && !canWrite)} aria-busy={busy} onClick={() => void run('next')}>
          {busy ? STORY_WRITING : `${NEXT_STORY} →`}
        </button>
        <div className="stories-row" role="radiogroup" aria-label="Story difficulty">
          {(Object.keys(STORY_DIFFICULTY) as StoryDifficulty[]).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={difficulty === d} className="stories-chip" data-testid={`story-difficulty-${d}`} onClick={() => setDifficulty(d)}>
              {STORY_DIFFICULTY[d]}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="stories-error" role="status" data-testid="story-error">
          {error}
        </p>
      )}

      <details className="stories-topics">
        <summary>Pick a topic</summary>
        <div className="stories-row" role="radiogroup" aria-label="Story topic" data-testid="story-topics">
          <button type="button" role="radio" className="stories-chip" aria-checked={pick.kind === 'lesson'} onClick={() => setPick({ kind: 'lesson' })}>
            This lesson
          </button>
          {STORY_TOPIC_CHIPS.map((c) => (
            <button
              key={c.topic}
              type="button"
              role="radio"
              className="stories-chip"
              aria-checked={pick.kind === 'chip' && pick.text === c.topic}
              onClick={() => setPick({ kind: 'chip', text: c.topic })}
            >
              {c.label}
            </button>
          ))}
          <button type="button" role="radio" className="stories-chip" aria-checked={pick.kind === 'journal'} onClick={() => setPick({ kind: 'journal' })}>
            ✏️ From my journal
          </button>
          {lastRead && (
            <button type="button" role="radio" className="stories-chip" aria-checked={pick.kind === 'continue'} onClick={() => setPick({ kind: 'continue' })}>
              ➡️ Continue a story
            </button>
          )}
        </div>
        <div className="stories-row">
          <input
            className="stories-topic-input"
            data-testid="story-topic-input"
            placeholder="Or type a topic…"
            value={typed}
            maxLength={200}
            onChange={(e) => {
              setTyped(e.target.value);
              setPick({ kind: 'typed' });
            }}
          />
          <button type="button" data-testid="story-write" disabled={busy || !canWrite} onClick={writeChosen}>
            Write it
          </button>
        </div>
      </details>

      {easier.map((s) => (
        <p className="stories-easier" key={`e-${s.id}`}>
          {EASIER_NOW}:{' '}
          <button type="button" className="stories-item" onClick={() => onOpen(s)}>
            <span lang="zh-Hant" className="stories-item-title">{s.titleZh}</span>
          </button>
        </p>
      ))}

      {library.length > 0 && (
        <ul className="stories-library" data-testid="story-library">
          {library.map((s) => {
            const l = storyLesson(s);
            return (
              <li key={s.id}>
                <button type="button" className="stories-item" data-testid="story-item" data-read={s.readAt ? '1' : '0'} onClick={() => onOpen(s)}>
                  <span lang="zh-Hant" className="stories-item-title">{s.titleZh}</span>
                  {l && <span className="stories-badge">{lessonLabel(l.n, l.bookId)}</span>}
                  {s.readAt ? <span className="stories-badge">✓ read</span> : <span className="stories-unread">Unread</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {import.meta.env.DEV && (
        <label className="reader-dev">
          <input
            type="checkbox"
            checked={fake}
            onChange={(e) => {
              try {
                localStorage.setItem(FAKE_STORY_KEY, e.target.checked ? '1' : '0');
              } catch {
                /* private window */
              }
              setFake(e.target.checked);
              onFakeChange?.(e.target.checked);
            }}
          />{' '}
          Use fake story writer (dev)
        </label>
      )}
    </section>
  );
}

/** Phase 24 Part D: Home's "Today's story" line, under the Home buttons; hidden when none is ready. */
export function HomeStoryLine({ service, level, onOpen }: { service: StoryService; level: Level; onOpen: (story: StoryRecord) => void }) {
  const [difficulty] = useStoryDifficulty();
  const [story, setStory] = useState<StoryRecord | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const now = new Date();
      const [ready, { ladder }] = await Promise.all([service.readyFor(level, now), service.ladderFor(level, now)]);
      if (cancelled) return;
      setStory(ready.find((s) => s.difficulty === difficulty) ?? ready[0] ?? null);
      prepareStories(service, level, difficulty, ladder.lessons.active?.lessonId ?? '-');
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [service, level, difficulty]);
  if (!story) return null;
  return (
    <p className="home-story" data-testid="home-story">
      <button type="button" onClick={() => onOpen(story)}>
        📖 Today&apos;s story: {storyPitch(storyMinutes(story.chars), storyLesson(story))}
      </button>
    </p>
  );
}
