import { useEffect, useState } from 'react';
import { levelLabel, levelUpSuggestion, type Level } from '@anan/core';
import { LevelPicker } from './components/LevelPicker.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { useProfile } from './components/ProfileGate.js';
import { PROFILES } from './profiles.js';
import { db } from './db/instance.js';
import { allTouchedCards } from './db/queries.js';
import { initCurrentLevelIfUnset, useCurrentLevel } from './lib/current-level.js';
import { useLexicon } from './lib/useLexicon.js';
import { AudioReviewPage } from './pages/AudioReviewPage.js';
import { AnkiImportPage } from './pages/AnkiImportPage.js';
import { ChatPage } from './pages/ChatPage.js';
import { ClozePage } from './pages/ClozePage.js';
import { CreditsPage } from './pages/CreditsPage.js';
import { GardenPage } from './pages/GardenPage.js';
import { JournalPage } from './pages/JournalPage.js';
import { PlacementPage } from './pages/PlacementPage.js';
import { TextbookPage } from './pages/TextbookPage.js';
import { useMyClass } from './lib/my-class.js';
import { ReaderPage } from './pages/ReaderPage.js';
import { ProgressPage } from './pages/ProgressPage.js';
import { ReviewPage } from './pages/ReviewPage.js';
import { ZhuyinTestPage } from './pages/ZhuyinTestPage.js';
import './App.css';
import './components/LevelPicker.css';
import './components/ProfileGate.css';

type Route =
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
  | 'audio-review'
  | 'zhuyin-test';

/** Phase 7 §2: the header level picker (visible on every screen) plus the
 * "Ready to try L3?" prompt — a suggestion only, never an automatic switch. */
function LevelHeader({ route }: { route: Route }) {
  const lexiconState = useLexicon();
  const { level, setLevel } = useCurrentLevel();
  const [suggestion, setSuggestion] = useState<Level | null>(null);
  const [dismissed, setDismissed] = useState<Level | null>(null);

  useEffect(() => {
    if (lexiconState.status === 'ready') void initCurrentLevelIfUnset(lexiconState.lexicon);
  }, [lexiconState]);

  // Re-evaluated on every level change and screen change (reviews happen on
  // other screens), from local data only.
  useEffect(() => {
    if (lexiconState.status !== 'ready') return;
    let cancelled = false;
    allTouchedCards(db).then((cards) => {
      if (cancelled) return;
      setSuggestion(
        levelUpSuggestion(
          level,
          lexiconState.lexicon.allWords(),
          cards.filter((c) => c.skill === 'recognition'),
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [lexiconState, level, route]);

  return (
    <header className="app-header">
      <ProfileChip />
      <LevelPicker value={level} onChange={(l) => void setLevel(l)} />
      <ThemeToggle />
      {suggestion && dismissed !== suggestion && (
        <div className="level-up-prompt" role="status">
          <span>Ready to try {levelLabel(suggestion)}?</span>
          <button onClick={() => void setLevel(suggestion)}>Switch to {suggestion}</button>
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

export function App() {
  const [route, setRoute] = useState<Route>(
    (new URLSearchParams(location.search).get('page') as Route) ?? 'reader',
  );
  const myClass = useMyClass();

  return (
    <div className="app">
      <LevelHeader route={route} />
      <nav className="app-nav">
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
        <button onClick={() => setRoute('garden')} disabled={route === 'garden'}>
          Garden
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
          Textbook{myClass.enabled ? ` · L${myClass.currentLesson}` : ''}
        </button>
        <button onClick={() => setRoute('placement')} disabled={route === 'placement'}>
          Placement
        </button>
        <button onClick={() => setRoute('anki-import')} disabled={route === 'anki-import'}>
          Anki import
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
      {route === 'audio-review' && <AudioReviewPage />}
      {route === 'zhuyin-test' && <ZhuyinTestPage />}
    </div>
  );
}
