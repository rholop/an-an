import './theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ProfileProvider } from './components/ProfileGate.js';
import { preloadLexicon } from './lib/useLexicon.js';

// Begin the big lexicon download now, in parallel with rendering the first screen.
void preloadLexicon().catch(() => undefined); // errors surface where the lexicon is used

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProfileProvider>
      <App />
    </ProfileProvider>
  </StrictMode>,
);
