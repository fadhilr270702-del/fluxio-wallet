import { useCallback, useEffect, useState } from 'react';

// Prompt 0197 — the Background on/off switch's own state, a deliberate
// copy of useTheme.js's exact pattern (separate localStorage key, a
// data-* attribute on <html>, and a matching pre-paint script in
// index.html so a returning visitor's saved choice doesn't flash
// glass-then-solid while React boots). 'glass' = the photo + glass-card
// look every prompt up to 0196 verified; 'solid' = no photo, no
// backdrop-filter, flat per-theme surfaces. Default for a new visitor is
// 'glass' (Background ON), per the owner's decision in prompt 0197.
const STORAGE_KEY = 'fluxio-admin-surface';

function readInitialSurface() {
  if (typeof window === 'undefined') return 'glass';
  return localStorage.getItem(STORAGE_KEY) || document.documentElement.getAttribute('data-surface') || 'glass';
}

/** Single source of truth for the admin panel's glass/solid background switch. Mirrors useTheme.js. */
export default function useSurface() {
  const [surface, setSurface] = useState(readInitialSurface);

  useEffect(() => {
    document.documentElement.setAttribute('data-surface', surface);
    localStorage.setItem(STORAGE_KEY, surface);
  }, [surface]);

  const toggle = useCallback(() => {
    setSurface((current) => (current === 'solid' ? 'glass' : 'solid'));
  }, []);

  return { surface, setSurface, toggle };
}
