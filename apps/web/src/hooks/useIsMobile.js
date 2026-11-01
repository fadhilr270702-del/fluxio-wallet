import { useEffect, useState } from 'react';

// Mirrors the sitewide ~900px section-collapse breakpoint already used
// throughout design.css (Features/Networks/HowItWorks/Vault's own existing
// @media (max-width:900px) blocks) rather than introducing a new one, so
// JS-side layout branching and CSS-side layout collapse always agree on
// the same width (see Vault.jsx's mobile-simplification branch,
// prompt/0074) — a mismatch would leave a dead zone where CSS has already
// gone 1-column but JS is still rendering a layout designed for 2-column
// width.
const QUERY = '(max-width: 900px)';

export default function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(QUERY).matches));

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
