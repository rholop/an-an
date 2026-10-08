import { useState } from 'react';
import { LearnedMastered } from './LearnedMastered.js';
import { lessonLabel, lessonOnly, STUDY_THIS_LESSON, stepName } from '../lib/labels.js';
import { updateStudySettings, useStudyFocus, useStudySettings } from '../lib/study.js';
import { StudyLessonView } from '../pages/TextbookPage.js';
import { ReviewPage } from '../pages/ReviewPage.js';
import { PetalBurst } from './Celebrations.js';
import { FlowerIcon } from './PlantIcons.js';
import './NowStudying.css';

/** Phase 14 §5: the "Now studying" card at the top of home — the active step, its mastery,
 * what is left, the next step and any gate; plus the study-order settings. */
export function NowStudying() {
  const { focus, celebrate, dismissCelebration } = useStudyFocus();
  const settings = useStudySettings();
  // The step being studied: the active one, or a catch-up lesson tapped on the card.
  const [studying, setStudying] = useState<{ bookId: string; n: number } | 'active' | null>(null);

  if (studying && typeof studying === 'object') {
    return <StudyLessonView bookId={studying.bookId} n={studying.n} onExit={() => setStudying(null)} />;
  }
  if (studying && focus?.activeStep) {
    const s = focus.activeStep;
    return s.kind === 'lesson' ? (
      <StudyLessonView bookId={s.bookId} n={s.n} onExit={() => setStudying(null)} />
    ) : (
      <ReviewPage onExit={() => setStudying(null)} exitLabel="← Back" title={`${stepName(s)} — review`} />
    );
  }
  if (!focus) return null;
  const m = focus.mastery;
  return (
    <section className="now-studying" aria-label="Now studying" data-testid="now-studying">
      {celebrate.length > 0 && (
        <p className="now-studying-cheer" role="status" data-testid="lesson-mastered">
          <PetalBurst />
          <FlowerIcon /> {celebrate.map((id) => lessonName(id)).join(', ')} mastered!{' '}
          <button onClick={dismissCelebration}>Nice</button>
        </p>
      )}
      <h2>Now studying</h2>
      {!focus.enabled ? (
        <p className="textbook-muted">Study order is off.</p>
      ) : !focus.activeStep || !m ? (
        <p>Everything in the study order is mastered. Nice work!</p>
      ) : (
        <>
          <p className="now-studying-name" data-testid="now-studying-name">
            <strong lang="zh-Hant">{stepName(focus.activeStep)}</strong>
            {focus.activeIsClass && focus.classLesson && (
              <span className="textbook-muted">
                {' '}
                {focus.activeStep.kind === 'lesson' && focus.activeStep.lessonId === focus.classLesson.lessonId
                  ? '(your class)'
                  : `(preview, your class is on ${lessonOnly(focus.classLesson.n)})`}
              </span>
            )}
          </p>
          <LearnedMastered p={m} testId="now-studying-progress" />
          <p data-testid="now-studying-left">
            {m.remainingWords} word{m.remainingWords === 1 ? '' : 's'}
            {focus.activeStep.kind === 'lesson' &&
              ` and ${m.remainingGrammar} grammar point${m.remainingGrammar === 1 ? '' : 's'}`}{' '}
            to master
          </p>
          {focus.reviewLessons.length > 0 && (
            <p className="now-studying-catchup" data-testid="now-studying-catchup">
              Catching up:{' '}
              {focus.reviewLessons.map((l, i) => (
                <span key={l.lessonId}>
                  {i > 0 && ', '}
                  <button className="link-button" onClick={() => setStudying({ bookId: l.bookId, n: l.n })}>
                    {l.bookId === (focus.activeLesson?.bookId ?? focus.classLesson?.bookId) ? lessonOnly(l.n) : stepName(l)}
                  </button>
                </span>
              ))}
            </p>
          )}
          {focus.nextStep && (
            <p className="textbook-muted">Next: {stepName(focus.nextStep)}</p>
          )}
          {focus.gateStatus.message && (
            <p className="textbook-muted" data-testid="study-gate">{focus.gateStatus.message}</p>
          )}
          {focus.gateStatus.cappedByClass && (
            <p className="textbook-muted">Waiting for the class: later lessons are held back.</p>
          )}
          <button onClick={() => setStudying('active')} data-testid="study-this">
            {focus.activeStep.kind === 'lesson' ? STUDY_THIS_LESSON : 'Study these words'}
          </button>
        </>
      )}
      <details className="now-studying-settings">
        <summary>Study order settings</summary>
        <label>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => void updateStudySettings({ enabled: e.target.checked })}
            data-testid="study-order-toggle"
          />{' '}
          Study order (textbook lessons and TOCFL levels, until mastered)
        </label>
        <label>
          Mastery threshold:{' '}
          <input
            type="number"
            min={50}
            max={100}
            step={5}
            value={Math.round(settings.masteryShare * 100)}
            onChange={(e) => void updateStudySettings({ masteryShare: Number(e.target.value) / 100 })}
          />
          %
        </label>
        <label>
          Lessons ahead of class:{' '}
          <input
            type="number"
            min={0}
            max={5}
            value={settings.classAheadLessons}
            onChange={(e) => void updateStudySettings({ classAheadLessons: Number(e.target.value) })}
          />
        </label>
      </details>
    </section>
  );
}

function lessonName(id: string): string {
  const m = /^(laixue-\d+)-L(\d+)$/.exec(id);
  return m ? lessonLabel(Number(m[2]), m[1]!) : id;
}
