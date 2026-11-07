import { useEffect, useState } from 'react';

/**
 * The colour theme: `auto` follows the system (prefers-color-scheme), `light` and
 * `dark` pin it by setting `data-theme` on <html> (the generated token CSS reads
 * it). Kept per browser.
 */
export type ThemeMode = 'auto' | 'light' | 'dark';
const KEY = 'theirside.theme';
const EVENT = 'theirside-theme';

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyThemeMode(mode: ThemeMode = getThemeMode()): void {
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    if (mode === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    // private mode: the choice lasts for this page only
  }
  applyThemeMode(mode);
  window.dispatchEvent(new Event(EVENT));
}

/** Changes whenever the effective theme may have changed (toggle or system), for canvas redraws. */
export function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((x) => x + 1);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    window.addEventListener(EVENT, bump);
    mq.addEventListener('change', bump);
    return () => {
      window.removeEventListener(EVENT, bump);
      mq.removeEventListener('change', bump);
    };
  }, []);
  return v;
}

export function useThemeMode(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setMode] = useState(getThemeMode);
  return [
    mode,
    (m) => {
      setThemeMode(m);
      setMode(m);
    },
  ];
}
