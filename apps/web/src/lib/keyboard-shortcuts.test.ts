import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatchShortcut,
  initKeyboardShortcuts,
  isTextInput,
  registerShortcut,
} from './keyboard-shortcuts.js';

describe('keyboard shortcuts', () => {
  let listeners: Record<string, ((e: unknown) => void)[]> = {};

  beforeEach(() => {
    listeners = {};
    // Setup light globals for node environment
    const fakeWindow = {
      addEventListener: vi.fn((event: string, fn: (e: unknown) => void) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(fn);
      }),
      removeEventListener: vi.fn((event: string, fn: (e: unknown) => void) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((f) => f !== fn);
        }
      }),
      dispatchEvent: vi.fn((e: unknown) => {
        const evt = e as { type?: string };
        const list = listeners[evt.type ?? 'keydown'] || [];
        for (const fn of list) fn(e);
        return true;
      }),
    };

    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', {
      querySelector: vi.fn(),
      querySelectorAll: vi.fn(() => []),
      activeElement: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('isTextInput', () => {
    it('identifies inputs and textareas as text input', () => {
      expect(isTextInput({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget)).toBe(true);
      expect(isTextInput({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
      expect(isTextInput({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    });

    it('identifies buttons and non-text elements as not text input', () => {
      expect(isTextInput({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
      expect(isTextInput({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
      expect(isTextInput(null)).toBe(false);
    });
  });

  describe('registry and dispatch', () => {
    it('dispatches to registered handlers and unregisters cleanly', () => {
      const handler1 = vi.fn();
      const unbind1 = registerShortcut('next', handler1);

      dispatchShortcut('next');
      expect(handler1).toHaveBeenCalledTimes(1);

      unbind1();
      dispatchShortcut('next');
      expect(handler1).toHaveBeenCalledTimes(1);
    });

    it('prioritizes most recently registered handler', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn().mockReturnValue(true);

      const unbind1 = registerShortcut('play-audio', handler1);
      const unbind2 = registerShortcut('play-audio', handler2);

      dispatchShortcut('play-audio');
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler1).not.toHaveBeenCalled();

      unbind2();
      unbind1();
    });
  });

  describe('global keyboard listener', () => {
    const bodyTarget = { tagName: 'BODY' } as unknown as EventTarget;
    const inputTarget = { tagName: 'INPUT', type: 'text' } as unknown as EventTarget;

    it('triggers next on Space', () => {
      const cleanup = initKeyboardShortcuts();
      const nextSpy = vi.fn();
      const unbind = registerShortcut('next', nextSpy);

      window.dispatchEvent({
        type: 'keydown',
        key: ' ',
        code: 'Space',
        target: bodyTarget,
      });
      expect(nextSpy).toHaveBeenCalledTimes(1);

      unbind();
      cleanup();
    });

    it('triggers toggle-level on L', () => {
      const cleanup = initKeyboardShortcuts();
      const levelSpy = vi.fn();
      const unbind = registerShortcut('toggle-level', levelSpy);

      window.dispatchEvent({
        type: 'keydown',
        key: 'l',
        preventDefault: vi.fn(),
        target: bodyTarget,
      });
      expect(levelSpy).toHaveBeenCalledTimes(1);

      unbind();
      cleanup();
    });

    it('triggers play-audio on P and R', () => {
      const cleanup = initKeyboardShortcuts();
      const audioSpy = vi.fn();
      const unbind = registerShortcut('play-audio', audioSpy);

      window.dispatchEvent({
        type: 'keydown',
        key: 'p',
        preventDefault: vi.fn(),
        target: bodyTarget,
      });
      expect(audioSpy).toHaveBeenCalledTimes(1);

      window.dispatchEvent({
        type: 'keydown',
        key: 'r',
        preventDefault: vi.fn(),
        target: bodyTarget,
      });
      expect(audioSpy).toHaveBeenCalledTimes(2);

      unbind();
      cleanup();
    });

    it('triggers choice-1 through choice-4 on digits', () => {
      const cleanup = initKeyboardShortcuts();
      const choice1Spy = vi.fn();
      const choice4Spy = vi.fn();

      const unbind1 = registerShortcut('choice-1', choice1Spy);
      const unbind4 = registerShortcut('choice-4', choice4Spy);

      window.dispatchEvent({
        type: 'keydown',
        key: '1',
        preventDefault: vi.fn(),
        target: bodyTarget,
      });
      expect(choice1Spy).toHaveBeenCalledTimes(1);

      window.dispatchEvent({
        type: 'keydown',
        key: '4',
        preventDefault: vi.fn(),
        target: bodyTarget,
      });
      expect(choice4Spy).toHaveBeenCalledTimes(1);

      unbind1();
      unbind4();
      cleanup();
    });

    it('does not trigger single letter shortcuts when user is typing in input', () => {
      const cleanup = initKeyboardShortcuts();
      const audioSpy = vi.fn();
      const unbind = registerShortcut('play-audio', audioSpy);

      window.dispatchEvent({
        type: 'keydown',
        key: 'p',
        preventDefault: vi.fn(),
        target: inputTarget,
      });
      expect(audioSpy).not.toHaveBeenCalled();

      unbind();
      cleanup();
    });

    it('triggers submit on Enter inside text input', () => {
      const cleanup = initKeyboardShortcuts();
      const submitSpy = vi.fn();
      const unbind = registerShortcut('submit', submitSpy);

      window.dispatchEvent({
        type: 'keydown',
        key: 'Enter',
        preventDefault: vi.fn(),
        target: inputTarget,
      });
      expect(submitSpy).toHaveBeenCalledTimes(1);

      unbind();
      cleanup();
    });
  });
});
