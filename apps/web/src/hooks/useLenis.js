import { useEffect } from 'react';
import Lenis from 'lenis';

/**
 * Sitewide smooth/weighted scroll (the heavy, eased scroll feel on
 * agency-style sites like the sly.clubop.site reference) — not scroll
 * *jacking*: Lenis only intercepts native scroll and re-applies it with
 * easing, it never takes control of scroll position or pins sections. That
 * distinction matters here specifically because this app already had a
 * real scroll-hijack mechanism (position:sticky + translateX "horizontal
 * scroll" on the landing page) deliberately removed in an earlier slice for
 * being worse to use — this hook is not a reintroduction of that.
 *
 * Skipped entirely under prefers-reduced-motion, same standard this
 * codebase already applies to Marquee.jsx's auto-scroll animation — with
 * Lenis never constructed, scroll stays fully native.
 */
export default function useLenis() {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const lenis = new Lenis({
      duration: 1.1,
      easing: (t) => 1 - Math.pow(1 - t, 3)
    });
    // Exposed so utils/scrollToSlide.js's anchor-link handler can route
    // through Lenis's own scrollTo instead of the native scrollIntoView —
    // running both at once fights over the same scroll position every
    // frame. See that file for the fallback when Lenis isn't active.
    window.__lenis = lenis;

    let rafId;
    function raf(time) {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    }
    rafId = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(rafId);
      window.__lenis = null;
      lenis.destroy();
    };
  }, []);
}
