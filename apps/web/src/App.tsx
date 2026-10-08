import { lazy, Suspense, useEffect, useState } from 'react';
import { useLookupGateRegistration } from './lib/lookup-gate.js';
import {
  classLevelHint,
  DEFAULT_CURRICULUM_CONFIG,
  LEVEL_ORDER,
  levelItems,
  type Level,
} from '@anan/core';
import { LevelPicker } from './components/LevelPicker.js';
import { MoreSheet, TabBar } from './components/TabBar.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { useProfile } from './components/ProfileGate.js';
import { PROFILES } from './profiles.js';
import { initCurrentLevelIfUnset, useCurrentLevel } from './lib/current-level.js';
import { useLexicon } from './lib/useLexicon.js';
import { useMediaQuery } from './lib/useMediaQuery.js';
import { installViewportTracking } from './lib/viewport.js';
import { useMyClass } from './lib/my-class.js';
import { useProgressData, useStudyContextRegistration } from './lib/study.js';
import { ToastHost } from './components/ToastHost.js';
import { currentSession } from './db/instance.js';
import { HOME, YOUR_LEVEL, levelLabel, levelShort, navTextbookLabel, pct } from './lib/labels.js';
// Phase 21: the stored target retention is applied at start, on profile switch and after a sync.
import './lib/retention.js';
import './lib/audio-slow.js';
import './App.css';
import './components/LevelPicker.css';
import './components/ProfileGate.css';
import './mobile.css';

// Each screen is its own chunk: the first load only pays for the screen being opened.
const AudioReviewPage = lazy(() =>
  import('./pages/AudioReviewPage.js').then((m) => ({ default: m.AudioReviewPage })),
);
const AnkiImportPage = lazy(() =>
  import('./pages/AnkiImportPage.js').then((m) => ({ default: m.AnkiImportPage })),
);
const ChatPage = lazy(() => import('./pages/ChatPage.js').then((m) => ({ default: m.ChatPage })));
const ClozePage = lazy(() =>
  import('./pages/ClozePage.js').then((m) => ({ default: m.ClozePage })),
);
const CreditsPage = lazy(() =>
  import('./pages/CreditsPage.js').then((m) => ({ default: m.CreditsPage })),
);
const GardenPage = lazy(() =>
  import('./pages/GardenPage.js').then((m) => ({ default: m.GardenPage })),
);
const JournalPage = lazy(() =>
  import('./pages/JournalPage.js').then((m) => ({ default: m.JournalPage })),
);
const PlacementPage = lazy(() =>
  import('./pages/PlacementPage.js').then((m) => ({ default: m.PlacementPage })),
);
const TextbookPage = lazy(() =>
  import('./pages/TextbookPage.js').then((m) => ({ default: m.TextbookPage })),
);
const ReaderPage = lazy(() =>
  import('./pages/ReaderPage.js').then((m) => ({ default: m.ReaderPage })),
);
const ProgressPage = lazy(() =>
  import('./pages/ProgressPage.js').then((m) => ({ default: m.ProgressPage })),
);
const ReviewPage = lazy(() =>
  import('./pages/ReviewPage.js').then((m) => ({ default: m.ReviewPage })),
);
const ReportedPage = lazy(() =>
  import('./pages/ReportedPage.js').then((m) => ({ default: m.ReportedPage })),
);
const ReviewSettingsPage = lazy(() =>
  import('./pages/ReviewSettingsPage.js').then((m) => ({ default: m.ReviewSettingsPage })),
);
const ZhuyinTestPage = lazy(() =>
  import('./pages/ZhuyinTestPage.js').then((m) => ({ default: m.ZhuyinTestPage })),
);

export type Route =
  | 'reader'
  | 'chat'
  | 'cloze'
  | 'journal'
  | 'garden'
  | 'progress'
  | 'review'
  | 'textbook'
  | 'placement'
  | 'anki-import'
  | 'credits'
  | 'reported'
  | 'audio-review'
  | 'zhuyin-test'
  | 'review-settings';

/** Phase 7 §2: the header level picker (visible on every screen) plus the
 * "Ready to try L3?" prompt — a suggestion only, never an automatic switch. */
function LevelHeader({ route }: { route: Route }) {
  const lexiconState = useLexicon();
  const { level, setLevel } = useCurrentLevel();
  // Phase 13: while "My class" is on, show which level the current book matches (a hint; never changes the choice).
  const myClassHint = useMyClass();
  const classOn = myClassHint.enabled;
  const classBook = myClassHint.textbookId;
  const classLesson = myClassHint.currentLesson;
  const [dismissed, setDismissed] = useState<Level | null>(null);
  void route;

  useEffect(() => {
    if (lexiconState.status === 'ready') void initCurrentLevelIfUnset(lexiconState.lexicon);
  }, [lexiconState]);

  // Phase 21: the level-up prompt uses Learned over the one level item set (the same number as
  // Progress), refreshed after every change.
  const progress = useProgressData();
  const next = LEVEL_ORDER[LEVEL_ORDER.indexOf(level) + 1];
  const learnedShare =
    progress && lexiconState.status === 'ready'
      ? progress.index.summarize(levelItems(level, lexiconState.lexicon.allWords())).learnedShare
      : 0;
  const suggestion: Level | null =
    next && learnedShare >= DEFAULT_CURRICULUM_CONFIG.levelAdvanceThreshold ? next : null;

  return (
    <header className="app-header">
      <ProfileChip />
      <span className="level-picker-label">{YOUR_LEVEL}</span>
      <LevelPicker value={level} onChange={(l) => void setLevel(l)} />
      {classOn && (
        <span className="level-class-hint" data-testid="level-class-hint">
          {classLevelHint(classBook, classLesson)}
        </span>
      )}
      <div className="header-theme">
        <ThemeToggle />
      </div>
      {suggestion && dismissed !== suggestion && (
        <div className="level-up-prompt" role="status" data-testid="level-up-prompt">
          <span>
            You&apos;ve learned {pct(learnedShare)} of {levelShort(level)}. Ready to try {levelLabel(suggestion)}?
          </span>
          <button onClick={() => void setLevel(suggestion)}>Switch to {levelShort(suggestion)}</button>
          <button onClick={() => setDismissed(suggestion)}>Not yet</button>
        </div>
      )}
    </header>
  );
}

/** The current name in the header; tap to switch (phase 8 §5). A small dot
 * shows when the latest changes are not on the server yet (offline). */
function ProfileChip() {
  const { profile, syncStatus, switchProfile } = useProfile();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="profile-chip-wrap">
      <button
        className="profile-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        data-testid="profile-chip"
      >
        <span lang="zh-Hant">{profile.name}</span>
        {syncStatus === 'offline' && (
          <span
            className="sync-dot"
            role="img"
            aria-label="not synced"
            title="not synced"
            data-testid="sync-dot"
          />
        )}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          {PROFILES.map((p) => (
            <button
              key={p.id}
              role="menuitem"
              lang="zh-Hant"
              aria-current={p.id === profile.id}
              onClick={async () => {
                setOpen(false);
                if (p.id === profile.id) return;
                setBusy(true);
                try {
                  await switchProfile(p.id);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The open tab survives the re-mount a sync merge causes (Phase 21: a merge never moves you).
 * Switching to another person still starts on the page the address asks for. */
let lastRoute: { profileId: string | undefined; route: Route } | undefined;

export function App() {
  const [route, setRoute] = useState<Route>(
    // Phase 21: the app opens on Home.
    () =>
      (lastRoute && lastRoute.profileId === currentSession()?.profileId ? lastRoute.route : undefined) ??
      (new URLSearchParams(location.search).get('page') as Route) ??
      'garden',
  );
  useEffect(() => {
    lastRoute = { profileId: currentSession()?.profileId, route };
  }, [route]);
  const myClass = useMyClass();
  useStudyContextRegistration();
  useLookupGateRegistration();
  const [moreOpen, setMoreOpen] = useState(false);
  // The tab bar only exists on a phone-width screen (the CSS hides it above 640px too,
  // but then it would still be in the page and duplicate the top nav's labels).
  const isPhoneWidth = useMediaQuery('(max-width: 639.98px)');
  useEffect(() => installViewportTracking(), []);
  const go = (r: Route) => {
    setMoreOpen(false);
    setRoute(r);
    window.scrollTo(0, 0);
  };

  return (
    <div className="app">
      <LevelHeader route={route} />
      <nav className="app-nav">
        <button onClick={() => setRoute('garden')} disabled={route === 'garden'}>
          {HOME}
        </button>
        <button onClick={() => setRoute('reader')} disabled={route === 'reader'}>
          Reader
        </button>
        <button onClick={() => setRoute('chat')} disabled={route === 'chat'}>
          Chat
        </button>
        <button onClick={() => setRoute('cloze')} disabled={route === 'cloze'}>
          Cloze
        </button>
        <button onClick={() => setRoute('journal')} disabled={route === 'journal'}>
          Journal
        </button>
        <button onClick={() => setRoute('progress')} disabled={route === 'progress'}>
          Progress
        </button>
        <button onClick={() => setRoute('review')} disabled={route === 'review'}>
          Review
        </button>
        <button
          onClick={() => setRoute('textbook')}
          disabled={route === 'textbook'}
          data-testid="nav-textbook"
        >
          {myClass.enabled ? navTextbookLabel(myClass.currentLesson) : 'Textbook'}
        </button>
        <button onClick={() => setRoute('review-settings')} disabled={route === 'review-settings'}>
          Settings
        </button>
        <button onClick={() => setRoute('placement')} disabled={route === 'placement'}>
          Placement
        </button>
        <button onClick={() => setRoute('anki-import')} disabled={route === 'anki-import'}>
          Anki import
        </button>
        <button onClick={() => setRoute('reported')} disabled={route === 'reported'}>
          Reported
        </button>
        <button onClick={() => setRoute('credits')} disabled={route === 'credits'}>
          Credits
        </button>
        <button onClick={() => setRoute('audio-review')} disabled={route === 'audio-review'}>
          Audio review
        </button>
        <button onClick={() => setRoute('zhuyin-test')} disabled={route === 'zhuyin-test'}>
          Zhuyin rendering test
        </button>
      </nav>
      {/* reserved height: the tab bar and footer never jump when a screen finishes loading */}
      <main className="page-slot">
        <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
          {route === 'reader' && <ReaderPage />}
          {route === 'chat' && <ChatPage />}
          {route === 'cloze' && <ClozePage />}
          {route === 'journal' && <JournalPage />}
          {route === 'garden' && <GardenPage />}
          {route === 'progress' && <ProgressPage />}
          {route === 'review' && <ReviewPage />}
          {route === 'textbook' && <TextbookPage />}
          {route === 'placement' && <PlacementPage />}
          {route === 'anki-import' && <AnkiImportPage />}
          {route === 'credits' && <CreditsPage />}
          {route === 'reported' && <ReportedPage />}
          {route === 'audio-review' && <AudioReviewPage />}
          {route === 'zhuyin-test' && <ZhuyinTestPage />}
          {route === 'review-settings' && <ReviewSettingsPage />}
        </Suspense>
      </main>
      <ToastHost />
      {isPhoneWidth && (
        <TabBar route={route} onGo={go} moreOpen={moreOpen} onMore={() => setMoreOpen((o) => !o)} />
      )}
      {isPhoneWidth && moreOpen && (
        <MoreSheet
          route={route}
          onGo={go}
          onClose={() => setMoreOpen(false)}
          textbookLabel={myClass.enabled ? navTextbookLabel(myClass.currentLesson) : 'Textbook'}
        />
      )}
    </div>
  );
}
