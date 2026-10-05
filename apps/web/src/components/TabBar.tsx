import type { Route } from '../App.js';
import { BottomSheet } from './BottomSheet.js';
import { ThemeToggle } from './ThemeToggle.js';
import './TabBar.css';

/**
 * Phone navigation (below 640px; the top nav is hidden there and this is hidden
 * above it). Four everyday screens plus "More" for the rest. "Home" is the
 * garden — the screen that shows what needs doing today.
 */
const TABS: { route: Route; label: string; icon: string }[] = [
  { route: 'garden', label: 'Home', icon: '🌱' },
  { route: 'chat', label: 'Chat', icon: '💬' },
  { route: 'review', label: 'Review', icon: '🔁' },
  { route: 'journal', label: 'Journal', icon: '✏️' },
];

const MORE: { route: Route; label: string }[] = [
  { route: 'reader', label: 'Reader' },
  { route: 'cloze', label: 'Cloze' },
  { route: 'progress', label: 'Progress' },
  { route: 'textbook', label: 'Textbook' },
  { route: 'placement', label: 'Placement' },
  { route: 'anki-import', label: 'Anki import' },
  { route: 'audio-review', label: 'Audio review' },
  { route: 'reported', label: 'Reported clozes' },
  { route: 'credits', label: 'Credits' },
  { route: 'zhuyin-test', label: 'Zhuyin rendering test' },
];

export const isMoreRoute = (route: Route): boolean => MORE.some((m) => m.route === route);

export function TabBar({
  route,
  onGo,
  moreOpen,
  onMore,
}: {
  route: Route;
  onGo: (r: Route) => void;
  moreOpen: boolean;
  onMore: () => void;
}) {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <button
          key={t.route}
          type="button"
          className={`tabbar-tab ${route === t.route ? 'tabbar-tab--on' : ''}`}
          aria-current={route === t.route ? 'page' : undefined}
          onClick={() => onGo(t.route)}
        >
          <span className="tabbar-icon" aria-hidden="true">
            {t.icon}
          </span>
          <span>{t.label}</span>
        </button>
      ))}
      <button
        type="button"
        className={`tabbar-tab ${isMoreRoute(route) || moreOpen ? 'tabbar-tab--on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        onClick={onMore}
      >
        <span className="tabbar-icon" aria-hidden="true">
          ⋯
        </span>
        <span>More</span>
      </button>
    </nav>
  );
}

/** The rest of the app, as a bottom sheet (tap outside, swipe down, or Escape to close). */
export function MoreSheet({
  route,
  onGo,
  onClose,
  textbookSuffix,
}: {
  route: Route;
  onGo: (r: Route) => void;
  onClose: () => void;
  textbookSuffix: string;
}) {
  return (
    <BottomSheet label="More" onClose={onClose} testId="more-backdrop">
      <ul className="more-list">
        {MORE.map((m) => (
          <li key={m.route}>
            <button
              type="button"
              className="more-item"
              aria-current={route === m.route ? 'page' : undefined}
              onClick={() => onGo(m.route)}
            >
              {m.label}
              {m.route === 'textbook' ? textbookSuffix : ''}
            </button>
          </li>
        ))}
      </ul>
      <div className="more-theme">
        <span>Theme</span>
        <ThemeToggle />
      </div>
    </BottomSheet>
  );
}
