import { useThemeMode, type ThemeMode } from '../theme';

/** Auto (follow the system), light or dark; kept per browser. */
export function ThemeToggle() {
  const [mode, setMode] = useThemeMode();
  return (
    <select
      aria-label="Theme"
      value={mode}
      onChange={(e) => setMode(e.target.value as ThemeMode)}
      data-testid="theme"
    >
      <option value="auto">Auto theme</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}
