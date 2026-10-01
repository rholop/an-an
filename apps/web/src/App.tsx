import { useState } from 'react';
import { AnkiImportPage } from './pages/AnkiImportPage.js';
import { PlacementPage } from './pages/PlacementPage.js';
import { ReaderPage } from './pages/ReaderPage.js';
import { ReviewPage } from './pages/ReviewPage.js';
import { ZhuyinTestPage } from './pages/ZhuyinTestPage.js';
import './App.css';

type Route = 'reader' | 'review' | 'placement' | 'anki-import' | 'zhuyin-test';

export function App() {
  const [route, setRoute] = useState<Route>(
    (new URLSearchParams(location.search).get('page') as Route) ?? 'reader',
  );

  return (
    <div className="app">
      <nav className="app-nav">
        <button onClick={() => setRoute('reader')} disabled={route === 'reader'}>
          Reader
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
        <button onClick={() => setRoute('zhuyin-test')} disabled={route === 'zhuyin-test'}>
          Zhuyin rendering test
        </button>
      </nav>
      {route === 'reader' && <ReaderPage />}
      {route === 'review' && <ReviewPage />}
      {route === 'placement' && <PlacementPage />}
      {route === 'anki-import' && <AnkiImportPage />}
      {route === 'zhuyin-test' && <ZhuyinTestPage />}
    </div>
  );
}
