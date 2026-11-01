import React, { useEffect, useRef, useState } from 'react';
import { animate, useInView, useMotionValue, useTransform } from 'framer-motion';

/** Counts up from 0 to `to` once it scrolls into view. Verifiable technical
 *  facts only (chain count, encryption params) — no fabricated usage metrics.
 *  Extracted out of StatsBand.jsx so both it and StatsSpotlight.jsx (the
 *  section-2 rebuild that reuses the same count-up mechanic, restyled for a
 *  light background) share one implementation instead of duplicating it. */
export default function Counter({ to, prefix = '', suffix = '', decimals = 0 }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const count = useMotionValue(0);
  const formatted = useTransform(count, (v) =>
    decimals ? v.toFixed(decimals) : Math.round(v).toLocaleString('en-US')
  );
  const [display, setDisplay] = useState(formatted.get());

  useEffect(() => {
    const unsub = formatted.on('change', setDisplay);
    return unsub;
  }, [formatted]);

  useEffect(() => {
    if (!inView) return undefined;
    const controls = animate(count, to, { duration: 1.6, ease: [0.16, 1, 0.3, 1] });
    return controls.stop;
  }, [inView, to, count]);

  return (
    <span ref={ref}>
      {prefix}
      {display}
      {suffix}
    </span>
  );
}
