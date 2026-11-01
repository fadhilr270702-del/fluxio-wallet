import { useEffect, useRef, useState } from 'react';
import { useInView } from 'framer-motion';

/**
 * Drives the continuous "color sweep" loop on a display heading (prompt
 * 0127 Revision 1) — the one piece of state EVERY animated heading needs,
 * unlike the small per-section decision helpers this codebase usually
 * duplicates locally (Vault.jsx/ExtensionFlow.jsx's own reveal()). This is
 * generic viewport+timer boilerplate, identical in every consumer, so it's
 * a real shared hook instead — same reasoning as useIsMobile.js already
 * being one.
 *
 * Two conditions both have to be true before the CSS loop is allowed to
 * run, per the prompt's own requirements:
 *   1. `entranceMs` has elapsed since mount — the one-shot entrance
 *      (round 1's per-word/clip-path/tilt/slide motion) gets to finish
 *      completely undisturbed before the infinite sweep takes over, so
 *      the two never visually fight.
 *   2. The heading is actually in the viewport (framer-motion's own
 *      useInView, `once:false` so it keeps reporting both directions) —
 *      an infinite CSS animation left running the whole page-scroll would
 *      burn CPU on definitely-invisible elements for no visual benefit;
 *      pausing/resuming via `animation-play-state` is free otherwise
 *      (only ever recomputed on the two edges of entering/leaving view,
 *      not per frame).
 *
 * Reduced motion short-circuits to permanently `false` — no timer, no
 * observer wiring, no animation ever runs. Consumers spread the returned
 * `ref` onto whichever element's visibility should gate the loop (usually
 * the heading itself), and apply `sweeping` as each animated element's
 * `animationPlayState` (`running`/`paused`).
 * @param {{entranceMs: number, reduceMotion: boolean}} opts
 */
export default function useHeadingSweep({ entranceMs, reduceMotion }) {
  const ref = useRef(null);
  const inView = useInView(ref, { amount: 0.2, once: false });
  const [entranceDone, setEntranceDone] = useState(false);

  useEffect(() => {
    if (reduceMotion) return undefined;
    const t = setTimeout(() => setEntranceDone(true), entranceMs);
    return () => clearTimeout(t);
  }, [reduceMotion, entranceMs]);

  return { ref, sweeping: !reduceMotion && entranceDone && inView };
}
