import React from 'react';
import { motion } from 'framer-motion';
import logoMark from '../assets/images/logo-fluxio-mono.png';

// How long the splash holds before App.jsx unmounts it.
const HOLD_MS = 5000;

// Drifting ambient glow blobs — pure CSS/framer-motion, no video. Positions
// are hand-placed rather than random so they read as composed, not noisy.
const ORBS = [
  { size: 460, style: { top: '-14%', left: '-10%' }, hue: 'teal', dur: 10 },
  { size: 380, style: { bottom: '-16%', right: '-8%' }, hue: 'gold', dur: 12.5 },
  { size: 300, style: { top: '32%', right: '10%' }, hue: 'teal', dur: 8.5 }
];

// A scattered field of tiny rising sparks for "lots of moving motion
// graphics" without turning into visual noise — deterministic positions
// (no Math.random(), which the workflow/runtime environment disallows at
// module scope anyway) via a simple spread formula.
const PARTICLES = Array.from({ length: 22 }, (_, i) => ({
  id: i,
  x: (i * 43) % 100,
  y: (i * 67) % 100,
  size: 2 + (i % 4),
  dur: 4 + (i % 5),
  delay: (i % 7) * 0.35
}));

export default function Preloader() {
  return (
    <motion.div
      className="preloader-overlay"
      role="status"
      aria-label="Loading Fluxio"
      exit={{ opacity: 0, scale: 1.06, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } }}
    >
      <div className="preloader-bg" aria-hidden="true">
        {ORBS.map((o, i) => (
          <motion.span
            key={i}
            className={`preloader-orb preloader-orb--${o.hue}`}
            style={{ width: o.size, height: o.size, ...o.style }}
            animate={{ x: [0, 26, -18, 0], y: [0, -22, 16, 0] }}
            transition={{ duration: o.dur, repeat: Infinity, ease: 'easeInOut' }}
          />
        ))}
        {PARTICLES.map((p) => (
          <motion.span
            key={p.id}
            className="preloader-particle"
            style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.size, height: p.size }}
            animate={{ opacity: [0, 1, 0], y: [0, -34, -64] }}
            transition={{ duration: p.dur, repeat: Infinity, delay: p.delay, ease: 'easeInOut' }}
          />
        ))}
      </div>

      <div className="preloader-box">
        <div className="preloader-reveal">
          <motion.img
            src={logoMark}
            alt=""
            className="preloader-reveal__icon"
            initial={{ opacity: 0, scale: 0.4, rotate: -20 }}
            animate={{
              opacity: 1,
              scale: [0.4, 1.08, 1, 1.06, 1],
              rotate: 0
            }}
            transition={{
              opacity: { duration: 0.5 },
              scale: { duration: 2.6, times: [0, 0.28, 0.4, 0.7, 1], repeat: Infinity, repeatDelay: 0.4, ease: 'easeInOut' },
              rotate: { type: 'spring', stiffness: 170, damping: 14 }
            }}
          />
          <motion.span
            className="preloader-reveal__word"
            initial={{ opacity: 0, x: -16, clipPath: 'inset(0 100% 0 0)' }}
            animate={{ opacity: 1, x: 0, clipPath: 'inset(0 0% 0 0)' }}
            transition={{ duration: 0.6, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            Fluxio
          </motion.span>
        </div>

        <div className="preloader-bar">
          <motion.div
            className="preloader-bar__fill"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: HOLD_MS / 1000, ease: [0.4, 0, 0.2, 1] }}
          />
        </div>
        <div className="preloader-caption">non custodial wallet</div>
      </div>
    </motion.div>
  );
}

export { HOLD_MS };
