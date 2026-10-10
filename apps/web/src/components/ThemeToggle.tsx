import { THEME_CHOICES, useTheme, type ThemeChoice } from '../lib/theme.js';
import './ThemeToggle.css';

const LABEL: Record<ThemeChoice, string> = { light: 'Light', system: 'Auto', dark: 'Dark' };
/** Phase 30: the laptop top bar shows only these (the word stays the button's name). */
const ICON: Record<ThemeChoice, string> = { light: '☀', system: 'A', dark: '☾' };
const TITLE: Record<ThemeChoice, string> = {
  light: 'Always light',
  system: 'Follow your device setting',
  dark: 'Always dark',
};

/** Light / Auto / Dark. "Auto" follows the device, as the app always did. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Colour theme">
      {THEME_CHOICES.map((choice) => (
        <button
          key={choice}
          type="button"
          role="radio"
          aria-checked={theme === choice}
          className={`theme-toggle-btn ${theme === choice ? 'theme-toggle-btn--on' : ''}`}
          title={TITLE[choice]}
          onClick={() => setTheme(choice)}
        >
          <span className="theme-toggle-icon" aria-hidden="true">
            {ICON[choice]}
          </span>
          <span className="theme-toggle-text">{LABEL[choice]}</span>
        </button>
      ))}
    </div>
  );
}
