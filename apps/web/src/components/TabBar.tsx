import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Route } from '../App.js';
import { HOME, PINYIN_TAB } from '../lib/labels.js';
import { BottomSheet } from './BottomSheet.js';
import { SproutIcon } from './PlantIcons.js';
import { ThemeToggle } from './ThemeToggle.js';
import './TabBar.css';

/**
 * Phase 22: one navigation list for every size. Desktop: the primary screens in the top bar plus a
 * "More" menu; phone: the first four in the bottom tab bar, everything else in the More sheet, in
 * the same order. "Home" is the garden, the screen that shows what needs doing today. The Zhuyin
 * rendering test is a developer page: listed only in dev builds (its address still works).
 */
export const PRIMARY: { route: Route; label: string }[] = [
  { route: 'garden', label: HOME },
  { route: 'review', label: 'Review' },
  // Phase 23: pronunciation practice, next to Review on desktop, in More on phones
  { route: 'pinyin', label: PINYIN_TAB },
  { route: 'cloze', label: 'Cloze' },
  { route: 'chat', label: 'Chat' },
  { route: 'journal', label: 'Journal' },
  { route: 'reader', label: 'Reader' },
  { route: 'textbook', label: 'Textbook' },
  { route: 'progress', label: 'Progress' },
];

export const SECONDARY: { route: Route; label: string }[] = [
  { route: 'review-settings', label: 'Settings' },
  { route: 'placement', label: 'Placement' },
  { route: 'anki-import', label: 'Anki import' },
  { route: 'reported', label: 'Reported' },
  { route: 'credits', label: 'Credits' },
  { route: 'audio-review', label: 'Audio review' },
  ...(import.meta.env.DEV ? [{ route: 'zhuyin-test' as Route, label: 'Zhuyin rendering test' }] : []),
];

const TAB_ROUTES: Route[] = ['garden', 'review', 'chat', 'journal'];
const TAB_ICON: Partial<Record<Route, ReactNode>> = {
  garden: <SproutIcon />,
  review: '🔁',
  chat: '💬',
  journal: '✏️',
};
const TABS = PRIMARY.filter((p) => TAB_ROUTES.includes(p.route));
const MORE = [...PRIMARY.filter((p) => !TAB_ROUTES.includes(p.route)), ...SECONDARY];

export const isMoreRoute = (route: Route): boolean => MORE.some((m) => m.route === route);
const isSecondaryRoute = (route: Route): boolean => SECONDARY.some((m) => m.route === route) || route === 'zhuyin-test';

/** Desktop and tablet: the primary screens, then a "More" menu with the rest. */
/** Phase 22: the Review tab's due-now count (the same `reviewStatus` number as Home and Review). */
function DueBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="nav-due-badge" aria-hidden="true" data-testid="nav-due-badge">
      {n > 99 ? '99+' : n}
    </span>
  );
}

export function TopNav({
  route,
  onGo,
  textbookLabel,
  dueNow = 0,
}: {
  route: Route;
  onGo: (r: Route) => void;
  textbookLabel: string;
  dueNow?: number;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const go = (r: Route) => {
    setOpen(false);
    onGo(r);
  };
  return (
    <nav className="app-nav" aria-label="Sections">
      {PRIMARY.map((p) => (
        <button
          key={p.route}
          type="button"
          className={`app-nav-item${route === p.route ? ' app-nav-item--on' : ''}`}
          aria-current={route === p.route ? 'page' : undefined}
          onClick={() => go(p.route)}
          {...(p.route === 'textbook' ? { 'data-testid': 'nav-textbook' } : {})}
          {...(p.route === 'review' && dueNow > 0 ? { title: `${dueNow} due now` } : {})}
        >
          {p.route === 'textbook' ? textbookLabel : p.label}
          {p.route === 'review' && <DueBadge n={dueNow} />}
        </button>
      ))}
      <div className="app-nav-more" ref={wrap}>
        <button
          type="button"
          className={`app-nav-item${isSecondaryRoute(route) ? ' app-nav-item--on' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          data-testid="nav-more"
        >
          More <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <div className="app-nav-menu" role="menu" aria-label="More">
            {SECONDARY.map((m) => (
              <button
                key={m.route}
                type="button"
                role="menuitem"
                aria-current={route === m.route ? 'page' : undefined}
                onClick={() => go(m.route)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}

export function TabBar({
  route,
  onGo,
  moreOpen,
  onMore,
  dueNow = 0,
}: {
  route: Route;
  onGo: (r: Route) => void;
  moreOpen: boolean;
  onMore: () => void;
  dueNow?: number;
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
            {TAB_ICON[t.route]}
            {t.route === 'review' && <DueBadge n={dueNow} />}
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
  textbookLabel,
}: {
  route: Route;
  onGo: (r: Route) => void;
  onClose: () => void;
  textbookLabel: string;
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
              {m.route === 'textbook' ? textbookLabel : m.label}
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
