import { useCallback, useEffect, useState } from 'react';

// Separate localStorage key from apps/web's ('fluxio-theme') — these are
// two independent apps with two independent theme preferences, even though
// the toggle behavior itself is identical. See index.html for the matching
// pre-paint script that reads this same key.
const STORAGE_KEY = 'fluxio-admin-theme';

function readInitialTheme() {
  if (typeof window === 'undefined') return 'light';
  return localStorage.getItem(STORAGE_KEY) || document.documentElement.getAttribute('data-theme') || 'light';
}

/** Single source of truth for the admin panel's light/dark toggle. Mirrors apps/web/src/hooks/useTheme.js. */
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
