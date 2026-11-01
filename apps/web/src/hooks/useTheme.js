import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'fluxio-theme';

function readInitialTheme() {
  if (typeof window === 'undefined') return 'light';
  // Read localStorage directly (not the <html data-theme> attribute): on
  // first mount no effect has run yet, so any component that initialized
  // from the attribute instead of the persisted value would read the
  // pre-effect default and then write it straight back, clobbering
  // whatever was actually saved.
  return localStorage.getItem(STORAGE_KEY) || document.documentElement.getAttribute('data-theme') || 'light';
}

/**
 * Single source of truth for the light/dark toggle, shared by every
 * component that needs to read or flip it (marketing nav, dashboard
 * floating toggle, ...). Persists to localStorage and reflects the
 * current value onto <html data-theme="...">.
 */
export default function useTheme() {
  const [theme, setTheme] = useState(readInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, setTheme, toggle };
}
