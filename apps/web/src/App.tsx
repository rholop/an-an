import { useState } from 'react';
import { ReaderPage } from './pages/ReaderPage.js';
import { ZhuyinTestPage } from './pages/ZhuyinTestPage.js';
import './App.css';

type Route = 'reader' | 'zhuyin-test';

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
        <button onClick={() => setRoute('zhuyin-test')} disabled={route === 'zhuyin-test'}>
          Zhuyin rendering test
        </button>
      </nav>
      {route === 'reader' ? <ReaderPage /> : <ZhuyinTestPage />}
    </div>
  );
}
