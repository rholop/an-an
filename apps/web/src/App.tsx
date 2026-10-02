import { useEffect, useState } from 'react';
import { levelLabel, levelUpSuggestion, type Level } from '@anan/core';
import { LevelPicker } from './components/LevelPicker.js';
import { db } from './db/instance.js';
import { allTouchedCards } from './db/queries.js';
import { initCurrentLevelIfUnset, useCurrentLevel } from './lib/current-level.js';
import { useLexicon } from './lib/useLexicon.js';
import { AnkiImportPage } from './pages/AnkiImportPage.js';
import { ChatPage } from './pages/ChatPage.js';
import { ClozePage } from './pages/ClozePage.js';
import { CreditsPage } from './pages/CreditsPage.js';
import { GardenPage } from './pages/GardenPage.js';
import { JournalPage } from './pages/JournalPage.js';
import { PlacementPage } from './pages/PlacementPage.js';
import { ReaderPage } from './pages/ReaderPage.js';
import { ProgressPage } from './pages/ProgressPage.js';
import { ReviewPage } from './pages/ReviewPage.js';
import { ZhuyinTestPage } from './pages/ZhuyinTestPage.js';
import './App.css';
import './components/LevelPicker.css';

type Route =
  | 'reader'
  | 'chat'
  | 'cloze'
  | 'journal'
  | 'garden'
  | 'progress'
  | 'review'
  | 'placement'
  | 'anki-import'
  | 'credits'
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
      <LevelPicker value={level} onChange={(l) => void setLevel(l)} />
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

export function App() {
  const [route, setRoute] = useState<Route>(
    (new URLSearchParams(location.search).get('page') as Route) ?? 'reader',
  );

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
        <button onClick={() => setRoute('placement')} disabled={route === 'placement'}>
          Placement
        </button>
        <button onClick={() => setRoute('anki-import')} disabled={route === 'anki-import'}>
          Anki import
        </button>
        <button onClick={() => setRoute('credits')} disabled={route === 'credits'}>
          Credits
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
      {route === 'placement' && <PlacementPage />}
      {route === 'anki-import' && <AnkiImportPage />}
      {route === 'credits' && <CreditsPage />}
      {route === 'zhuyin-test' && <ZhuyinTestPage />}
    </div>
  );
}
