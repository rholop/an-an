import { lazy, Suspense, useEffect, useState } from 'react';
import { useLookupGateRegistration } from './lib/lookup-gate.js';
import {
  classLevelHint,
  type Level,
} from '@anan/core';
import { LevelPicker } from './components/LevelPicker.js';
import { MoreSheet, TabBar, TopNav } from './components/TabBar.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { SaveStatus, unsavedTooLong } from './components/SaveStatus.js';
import { useProfile } from './components/ProfileGate.js';
import { PROFILES } from './profiles.js';
import { initCurrentLevelIfUnset, useCurrentLevel } from './lib/current-level.js';
import { useLexicon } from './lib/useLexicon.js';
import { useMediaQuery } from './lib/useMediaQuery.js';
import { installViewportTracking } from './lib/viewport.js';
import { useMyClass } from './lib/my-class.js';
import { useStudyContextRegistration } from './lib/study.js';
import { ToastHost } from './components/ToastHost.js';
import { useLedger } from './lib/ledger.js';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal.js';
import { initKeyboardShortcuts } from './lib/keyboard-shortcuts.js';
import { currentSession } from './db/instance.js';
import { LEVEL, levelLabel, levelShort, navTextbookLabel, pct, UNSAVED_WARNING } from './lib/labels.js';
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
const PinyinPage = lazy(() =>
  import('./pages/PinyinPage.js').then((m) => ({ default: m.PinyinPage })),
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
  | 'pinyin'
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
function LevelHeader({ route, onOpenShortcuts }: { route: Route; onOpenShortcuts: () => void }) {
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

  // Phase 29: the level-up prompt is the ledger's (the same Learned share as Progress).
  const ledger = useLedger();
  const levelView = ledger?.level(level);
  const learnedShare = levelView?.learnedShare ?? 0;
  const suggestion: Level | null = levelView?.next ?? null;

  return (
    <header className="app-header">
      <ProfileChip />
      <LevelPicker value={level} onChange={(l) => void setLevel(l)} shownLabel={LEVEL} />
      {classOn && <ClassLevelHint text={classLevelHint(classBook, classLesson) ?? ""} />}
      <div className="header-actions">
        <button
          type="button"
          className="header-shortcuts-btn"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          onClick={onOpenShortcuts}
          data-testid="header-shortcuts-btn"
        >
          ⌨️
        </button>
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

/** Phase 22: which level the class book matches, behind a small info tap (saves header space). */
function ClassLevelHint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`level-class-hint${open ? ' level-class-hint--open' : ''}`} data-testid="level-class-hint">
      <button
        type="button"
        className="level-class-hint-btn"
        aria-label={`Your class level: ${text}`}
        aria-expanded={open}
        title={text}
        onClick={() => setOpen((o) => !o)}
      >
        ⓘ
      </button>
      <span className="level-class-hint-text" role="note">
        {text}
      </span>
    </span>
  );
}

/** The current name in the header; tap to switch (phase 8 §5). Phase 28: a cloud beside it says
 * whether progress is saved to the server (never a dot only), and the menu warns before switching
 * away from changes that aren't saved yet. */
function ProfileChip() {
  const { profile, switchProfile, sync } = useProfile();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="profile-chip-wrap">
      {sync && <SaveStatus sync={sync} />}
      <button
        className="profile-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        data-testid="profile-chip"
      >
        <span lang="zh-Hant">{profile.name}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          {unsavedTooLong(sync) && (
            <p className="profile-menu-warn" role="alert" data-testid="unsaved-warning">
              {UNSAVED_WARNING}
            </p>
          )}
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    const unbind = initKeyboardShortcuts();
    const handleToggle = () => setShortcutsOpen((o) => !o);
    window.addEventListener('anan:toggle-shortcuts-help', handleToggle);
    return () => {
      unbind();
      window.removeEventListener('anan:toggle-shortcuts-help', handleToggle);
    };
  }, []);

  // Phase 22: the nav's due badge is the same number as Home and Review.
  const ledger = useLedger();
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
      <LevelHeader route={route} onOpenShortcuts={() => setShortcutsOpen(true)} />
      <TopNav
        route={route}
        onGo={go}
        textbookLabel={myClass.enabled ? navTextbookLabel(myClass.currentLesson) : 'Textbook'}
        dueNow={ledger?.status.dueNow ?? 0}
      />
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
          {route === 'pinyin' && <PinyinPage />}
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
      <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {isPhoneWidth && (
        <TabBar
          route={route}
          onGo={go}
          moreOpen={moreOpen}
          onMore={() => setMoreOpen((o) => !o)}
          dueNow={ledger?.status.dueNow ?? 0}
        />
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
