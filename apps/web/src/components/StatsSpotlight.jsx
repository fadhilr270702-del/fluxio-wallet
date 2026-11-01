import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import Counter from './Counter.jsx';

/** The same four verifiable facts StatsBand.jsx used to show as dark cards —
 *  data unchanged, only the presentation moved (light section, animated
 *  right-side list instead of a dark card grid). See CLAUDE.md's crypto-core
 *  section for why these numbers are real and not fabricated. */
const STATS = [
  { to: 4, label: 'Chains from one seed' },
  { to: 256, suffix: ' bit', label: 'AES-GCM encryption' },
  { to: 600000, label: 'PBKDF2 iterations' },
  { to: 100, suffix: '%', label: 'Keys on your device' }
];

export default function StatsSpotlight() {
  const reduceMotion = useReducedMotion();

  return (
    <div className="spotlight-section">
      <div className="spotlight-section__copy">
        <span className="spotlight-section__label">( Verified )</span>
        {/* Found during prompt 0127's own audit — this headline had NO
            entrance treatment at all before this (only the stat rows to
            its right animated). Deliberately excluded from the new
            ivory/silver gradient system: this section forces itself
            LIGHT regardless of the rest of the page's black theme (see
            .h-scroll__slide--spotlight's own comment) — a gradient tuned
            for text on black would be close to invisible on white. Kept
            to the plainest member of the new animation family (a simple
            whileInView fade+rise, once) rather than inventing a
            from-scratch look for a section that's already visually the
            odd one out on this page. */}
        <motion.h2
          className="spotlight-section__headline"
          initial={reduceMotion ? undefined : { opacity: 0, y: 20 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        >
          Security is engineered,
          <br />
          not promised.
        </motion.h2>
        <p className="spotlight-section__desc">
          Four chains from one seed. AES-256-GCM encryption. 600,000 PBKDF2 iterations. All of
          it real, tested cryptography, measured in the numbers below, not in promises.
        </p>
      </div>

      <div className="spotlight-section__stats">
        {STATS.map((s, i) => (
          <motion.div
            className="spotlight-stat"
            key={s.label}
            initial={{ opacity: 0, x: 24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.6 }}
            transition={{ type: 'spring', stiffness: 120, damping: 20, delay: i * 0.12 }}
          >
            <strong className="spotlight-stat__value">
              <Counter to={s.to} suffix={s.suffix || ''} />
            </strong>
            <span className="spotlight-stat__label">{s.label}</span>
            <motion.span
              className="spotlight-stat__bar"
              initial={{ scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: i * 0.12 + 0.2 }}
            />
          </motion.div>
        ))}
      </div>
    </div>
  );
}
