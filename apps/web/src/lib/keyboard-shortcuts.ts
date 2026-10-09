import { useEffect } from 'react';

/**
 * Universal Keyboard Shortcut actions for study sessions and app navigation.
 */
export type ShortcutAction =
  | 'next'
  | 'submit'
  | 'play-audio'
  | 'toggle-level'
  | 'choice-1'
  | 'choice-2'
  | 'choice-3'
  | 'choice-4'
  | 'undo'
  | 'help'
  | 'escape';

type Handler = () => boolean | void;

// Active handler registry (LIFO: newest/deepest handler gets priority)
const registry = new Map<ShortcutAction, Set<Handler>>();

export function registerShortcut(action: ShortcutAction, handler: Handler): () => void {
  let handlers = registry.get(action);
  if (!handlers) {
    handlers = new Set();
    registry.set(action, handlers);
  }
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) registry.delete(action);
  };
}

/**
 * React hook to register a keyboard shortcut handler within a component.
 */
export function useKeyboardShortcut(
  action: ShortcutAction,
  handler: Handler,
  active = true,
): void {
  useEffect(() => {
    if (!active) return;
    return registerShortcut(action, handler);
  }, [action, handler, active]);
}

/**
 * Checks if the event target is a text input where typing single characters should not trigger shortcuts.
 */
export function isTextInput(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as unknown as { tagName?: string; isContentEditable?: boolean; type?: string };
  if (!el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || Boolean(el.isContentEditable)) return true;
  if (tag === 'input') {
    const type = (el.type ?? 'text').toLowerCase();
    return ['text', 'search', 'password', 'email', 'tel', 'url'].includes(type);
  }
  return false;
}

/**
 * Smart DOM fallback to trigger the visible "Next" button in any study session.
 */
export function triggerUniversalNext(): boolean {
  if (typeof document === 'undefined') return false;
  // 1. Look for explicit next buttons or show answer button
  const selectors = [
    'button[data-testid="review-pick-next"]',
    'button[data-testid*="-next"]',
    'button[data-testid="next-button"]',
    '.cloze-feedback button',
    '.listen-exercise button.btn-primary',
    'button.review-reveal',
    '.review-buttons button.review-btn--good',
    '.review-buttons button.btn-primary',
  ];

  for (const sel of selectors) {
    const btn = document.querySelector<HTMLButtonElement>(sel);
    if (btn && !btn.disabled && btn.offsetParent !== null) {
      btn.click();
      return true;
    }
  }

  // 2. Search for visible buttons containing text "Next" or "Show answer"
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
  for (const btn of buttons) {
    if (btn.offsetParent === null) continue; // skip hidden
    const text = btn.textContent?.trim().toLowerCase();
    if (text === 'next' || text === 'show answer' || text === 'next question' || text === 'continue') {
      btn.click();
      return true;
    }
  }

  return false;
}

/**
 * Smart DOM fallback to trigger the active submit button or form.
 */
export function triggerUniversalSubmit(): boolean {
  if (typeof document === 'undefined') return false;
  // 1. Active form
  const activeEl = document.activeElement;
  if (activeEl instanceof HTMLElement && activeEl.closest('form')) {
    const form = activeEl.closest('form')!;
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return true;
    }
  }

  // 2. Submit buttons
  const selectors = [
    'button[type="submit"]',
    'button[data-testid*="submit"]',
    'button.cloze-submit',
  ];
  for (const sel of selectors) {
    const btn = document.querySelector<HTMLButtonElement>(sel);
    if (btn && !btn.disabled && btn.offsetParent !== null) {
      btn.click();
      return true;
    }
  }

  return false;
}

/**
 * Smart DOM fallback to play audio for the current word, sentence, or listening exercise.
 */
export function triggerUniversalAudio(): boolean {
  if (typeof document === 'undefined') return false;
  const selectors = [
    'button.listen-play',
    'button.speaker-btn',
    '[data-testid="speaker"] button.speaker-btn',
    'button[aria-label^="Play"]',
  ];
  for (const sel of selectors) {
    const btn = document.querySelector<HTMLButtonElement>(sel);
    if (btn && !btn.disabled && btn.offsetParent !== null) {
      btn.click();
      return true;
    }
  }
  return false;
}

/**
 * Smart DOM fallback to toggle or focus the level picker dropdown.
 */
export function triggerUniversalLevelPicker(): boolean {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('anan:toggle-level'));
  }

  if (typeof document === 'undefined') return false;
  const select = document.getElementById('level-picker-select') as HTMLSelectElement | null;
  if (select) {
    select.focus();
    if ('showPicker' in select && typeof (select as unknown as { showPicker?: () => void }).showPicker === 'function') {
      try {
        (select as unknown as { showPicker: () => void }).showPicker();
      } catch {
        // ignore picker errors in unsupported contexts
      }
    }
    return true;
  }

  const picker = document.querySelector<HTMLSelectElement>('.level-picker select');
  if (picker) {
    picker.focus();
    return true;
  }
  return false;
}

/**
 * Dispatches an action to registered handlers, falling back to smart DOM actions.
 */
export function dispatchShortcut(action: ShortcutAction): boolean {
  const handlers = registry.get(action);
  if (handlers && handlers.size > 0) {
    // Execute handlers in reverse insertion order (most recently mounted first)
    const list = Array.from(handlers).reverse();
    for (const fn of list) {
      const res = fn();
      if (res !== false) return true; // Handled
    }
  }

  // Automatic fallbacks
  switch (action) {
    case 'next':
      return triggerUniversalNext();
    case 'submit':
      return triggerUniversalSubmit();
    case 'play-audio':
      return triggerUniversalAudio();
    case 'toggle-level':
      return triggerUniversalLevelPicker();
    case 'help':
      window.dispatchEvent(new CustomEvent('anan:toggle-shortcuts-help'));
      return true;
    case 'undo': {
      const undoBtn = document.querySelector<HTMLButtonElement>('[data-testid$="-undo"], button.review-undo button');
      if (undoBtn && !undoBtn.disabled && undoBtn.offsetParent !== null) {
        undoBtn.click();
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/**
 * Initializes global keyboard shortcut listener.
 * Returns a cleanup function.
 */
export function initKeyboardShortcuts(): () => void {
  function handleKeyDown(e: KeyboardEvent) {
    // Ignore events with modifier keys (except Shift for '?')
    const hasMod = e.ctrlKey || e.metaKey || e.altKey;
    const inInput = isTextInput(e.target);

    // Escape closes modals, menus or blurs active inputs
    if (e.key === 'Escape') {
      if (dispatchShortcut('escape')) {
        e.preventDefault?.();
        return;
      }
      if (inInput && e.target instanceof HTMLElement) {
        e.target.blur();
        e.preventDefault?.();
        return;
      }
    }

    // Enter behavior:
    // In text input:
    // - Cmd/Ctrl+Enter or Enter in single-line input triggers Submit
    if (e.key === 'Enter') {
      if (inInput) {
        const isTextArea = ((e.target as HTMLElement)?.tagName ?? '').toLowerCase() === 'textarea';
        if (hasMod || !isTextArea) {
          if (dispatchShortcut('submit')) {
            e.preventDefault?.();
            return;
          }
        }
      } else {
        // Outside text inputs: Enter triggers Next or Submit
        if (dispatchShortcut('next') || dispatchShortcut('submit')) {
          e.preventDefault?.();
          return;
        }
      }
    }

    // From here on, ignore all other shortcuts if the user is typing in an input
    if (inInput) return;
    if (hasMod) return;

    // Help dialog: '?' (Shift + /)
    if (e.key === '?') {
      e.preventDefault?.();
      dispatchShortcut('help');
      return;
    }

    // Toggle level picker: 'l' or 'L'
    if (e.key.toLowerCase() === 'l') {
      e.preventDefault?.();
      dispatchShortcut('toggle-level');
      return;
    }

    // Play/replay audio: 'p', 'P', 'r', 'R'
    if (e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'r') {
      e.preventDefault?.();
      dispatchShortcut('play-audio');
      return;
    }

    // Space: Show answer or Next card
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault?.();
      dispatchShortcut('next');
      return;
    }

    // Numeric keys 1-4: Choice options or SRS ratings (Again, Hard, Good, Easy)
    if (['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault?.();
      const action = `choice-${e.key}` as ShortcutAction;
      dispatchShortcut(action);
      return;
    }

    // Undo shortcut: 'z' or 'Z'
    if (e.key.toLowerCase() === 'z') {
      e.preventDefault?.();
      dispatchShortcut('undo');
      return;
    }
  }

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}
