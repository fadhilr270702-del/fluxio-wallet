import { useEffect, useRef, useState } from 'react';
import { isRectNearViewport } from './isRectNearViewport.js';

/**
 * Prompt 0152 — the lazy-load primitive behind PremiumEmojiStatic/
 * PremiumEmojiAnimated's "only the tiles actually on screen ever fetch
 * anything" requirement. Returns `[ref, isVisible]`; attach `ref` to the
 * element to observe. `options` is passed straight through to
 * `IntersectionObserver` (e.g. a `rootMargin` to start loading slightly
 * before a tile scrolls fully into view).
 *
 * Fails OPEN (reports visible immediately) when `IntersectionObserver`
 * itself isn't available — extremely unlikely in any browser this admin
 * panel targets, but "just show it" is a strictly safer failure mode here
 * than "never show it".
 *
 * Prompt 0157 — investigated a report (from 0156's own live verification)
 * that a button row's premium-icon preview could get stuck on its loading
 * placeholder forever after picking an icon. Reproducing it live (rather
 * than trusting 0156's own stated race-condition theory) found the ACTUAL
 * cause was the verification script itself: it called `element.click()`
 * programmatically on a control positioned below the current scroll fold
 * — something no real mouse or keyboard interaction could ever do (a
 * human can't click, or keyboard-focus into, an element they can't see;
 * focusing an element off-screen also auto-scrolls it into view as a
 * browser default). Once the exact same steps were repeated with the
 * control actually scrolled into view first — the only way a real user
 * could ever have reached it — the preview resolved correctly every time,
 * with no code change at all. Confirmed further: even in the artificial
 * off-screen case, a single subsequent `scrollIntoView()` (i.e. the user
 * eventually scrolling to look at their own work) immediately resolves
 * it — proving the `IntersectionObserver` itself was never actually stuck,
 * just correctly reporting "not visible yet" for an element that
 * genuinely wasn't. There is no real per-user-facing bug here.
 *
 * Still, a synchronous on-mount check was added as honest defense in
 * depth: `IntersectionObserver`'s own first callback is always
 * asynchronous by spec (fires on a later frame, never synchronously
 * during `observe()`), so ANYTHING mounting already on-screen — which,
 * per the above, is the only way a human interaction could have caused
 * this to mount in the first place — previously had to wait for at least
 * one extra async round trip before its own fetch could even start. This
 * closes that gap outright rather than leaving it to chance: a `getBoundingClientRect()`
 * check against the current viewport (expanded by the same `rootMargin`
 * the observer itself uses, so the two agree) runs once, synchronously,
 * right when the element mounts. An element that's already near/in the
 * viewport is marked visible immediately, with zero dependency on the
 * observer's own async timing; one that genuinely isn't (the whole point
 * of a large lazy-loaded grid, per 0152's own requirement) correctly stays
 * `false` here too, exactly as before — the `IntersectionObserver` remains
 * the single ongoing source of truth for every visibility change AFTER
 * mount (scrolling something into view later), this is purely a fast path
 * for the "already visible right now" case.
 */
export default function useIsVisible(options) {
  const ref = useRef(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return undefined;
    }
    if (typeof window !== 'undefined') {
      const rect = el.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      if (isRectNearViewport(rect, viewportWidth, viewportHeight, options?.rootMargin)) {
        setIsVisible(true);
      }
    }
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry.isIntersecting), options);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [ref, isVisible];
}
