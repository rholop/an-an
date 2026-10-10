import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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

/** Phase 22: the Review tab's due-now count (the same `reviewStatus` number as Home and Review). */
function DueBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="nav-due-badge" aria-hidden="true" data-testid="nav-due-badge">
      {n > 99 ? '99+' : n}
    </span>
  );
}

/**
 * Phase 30: the order nav items leave the top bar when it runs out of room (last leaves first):
 * Home, Review, Textbook, Garden, then the rest in menu order.
 */
const NAV_PRIORITY: Route[] = [
  'garden',
  'review',
  'textbook',
  ...PRIMARY.map((p) => p.route).filter((r) => !['garden', 'review', 'textbook'].includes(r)),
];

/**
 * How many of the priority-ordered items fit: `widths` in priority order, `more` the More
 * button's width, `gap` the space between items. Everything that doesn't fit goes into More.
 */
export function navItemsThatFit(widths: number[], more: number, gap: number, available: number): number {
  let used = more;
  let n = 0;
  for (const w of widths) {
    if (used + gap + w > available) break;
    used += gap + w;
    n++;
  }
  return Math.max(n, 1);
}

/**
 * Desktop and tablet: the primary screens, then a "More" menu with the rest. Phase 30: one row,
 * never wrapping; the items that don't fit move into More (measured, lowest priority first).
 */
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
  const [fit, setFit] = useState(PRIMARY.length);
  const wrap = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  /** Last measured width of each item (items in More keep the width they had in the bar). */
  const widths = useRef(new Map<Route, number>());
  const moreWidth = useRef(0);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      if (nav.offsetParent === null) return; // hidden (phones use the tab bar)
      for (const el of nav.querySelectorAll<HTMLElement>('[data-nav-route]'))
        widths.current.set(el.dataset.navRoute as Route, el.getBoundingClientRect().width);
      const moreBtn = wrap.current?.firstElementChild as HTMLElement | null;
      if (moreBtn) moreWidth.current = moreBtn.getBoundingClientRect().width;
      const style = getComputedStyle(nav);
      const gap = parseFloat(style.columnGap) || 0;
      const available = nav.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const next = navItemsThatFit(
        NAV_PRIORITY.map((r) => widths.current.get(r) ?? 0),
        moreWidth.current,
        gap,
        // a pixel of slack: sub-pixel widths must never push the last item onto a second row
        available - 1,
      );
      setFit((f) => (f === next ? f : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [textbookLabel, dueNow, fit]);

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
  const shown = new Set(NAV_PRIORITY.slice(0, fit));
  const inBar = PRIMARY.filter((p) => shown.has(p.route));
  const moved = PRIMARY.filter((p) => !shown.has(p.route));
  const labelOf = (p: { route: Route; label: string }) => (p.route === 'textbook' ? textbookLabel : p.label);
  const moreOn = isSecondaryRoute(route) || moved.some((m) => m.route === route);
  return (
    <nav className="app-nav" aria-label="Sections" ref={navRef} data-testid="app-nav">
      {inBar.map((p) => (
        <button
          key={p.route}
          type="button"
          className={`app-nav-item${route === p.route ? ' app-nav-item--on' : ''}`}
          aria-current={route === p.route ? 'page' : undefined}
          onClick={() => go(p.route)}
          data-nav-route={p.route}
          {...(p.route === 'textbook' ? { 'data-testid': 'nav-textbook' } : {})}
          {...(p.route === 'review' && dueNow > 0 ? { title: `${dueNow} due now` } : {})}
        >
          {labelOf(p)}
          {p.route === 'review' && <DueBadge n={dueNow} />}
        </button>
      ))}
      <div className="app-nav-more" ref={wrap}>
        <button
          type="button"
          className={`app-nav-item${moreOn ? ' app-nav-item--on' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          data-testid="nav-more"
        >
          More <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <div className="app-nav-menu" role="menu" aria-label="More">
            {moved.map((m) => (
              <button
                key={m.route}
                type="button"
                role="menuitem"
                aria-current={route === m.route ? 'page' : undefined}
                onClick={() => go(m.route)}
                data-testid={`nav-more-${m.route}`}
              >
                {labelOf(m)}
                {m.route === 'review' && <DueBadge n={dueNow} />}
              </button>
            ))}
            {moved.length > 0 && <hr className="app-nav-menu-sep" />}
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
        <span>Shortcuts</span>
        <button
          type="button"
          className="header-shortcuts-btn"
          onClick={() => {
            onClose();
            window.dispatchEvent(new CustomEvent('anan:toggle-shortcuts-help'));
          }}
          data-testid="more-shortcuts-btn"
        >
          ⌨️ View keys (?)
        </button>
      </div>
      <div className="more-theme">
        <span>Theme</span>
        <ThemeToggle />
      </div>
    </BottomSheet>
  );
}
