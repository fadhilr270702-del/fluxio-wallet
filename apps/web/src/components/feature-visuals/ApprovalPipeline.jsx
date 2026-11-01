import React from 'react';
import { motion } from 'framer-motion';

const WIDTH = 280;
const HEIGHT = 140;
const Y = HEIGHT / 2;
const STAGES = [
  { key: 'request', x: 34, label: 'request' },
  { key: 'queue', x: WIDTH / 2, label: 'queue' },
  { key: 'signature', x: WIDTH - 34, label: 'signature' }
];

/**
 * Request → queue → signature as a literal left-to-right pipeline (not
 * the radial diagram other tabs use) — matches the real pending-request
 * queue this feature is actually about, with a pulse traveling stage to
 * stage and a confirming glow once it reaches "signature".
 */
export default function ApprovalPipeline({ accent = 'gold', reduceMotion = false }) {
  const color = `var(--${accent})`;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="feature-visual" aria-hidden="true">
      <line x1={STAGES[0].x} y1={Y} x2={STAGES[2].x} y2={Y} className="node-diagram__line" style={{ stroke: color }} />

      {STAGES.map((s, i) => (
        <motion.g
          key={s.key}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 16, delay: i * 0.15 }}
        >
          <circle cx={s.x} cy={Y} r={i === 2 ? 18 : 13} className="node-diagram__node" style={{ fill: color }} />
          <text x={s.x} y={Y + 34} textAnchor="middle" className="node-diagram__label">{s.label}</text>
        </motion.g>
      ))}

      {/* Confirming pulse ring once the request "arrives" at signature */}
      <motion.circle
        cx={STAGES[2].x}
        cy={Y}
        r={18}
        className="node-diagram__core-pulse"
        style={{ stroke: color }}
        animate={reduceMotion ? { r: 26, opacity: 0.4 } : { r: [18, 32, 18], opacity: [0.7, 0, 0.7] }}
        transition={reduceMotion ? { duration: 0 } : { duration: 2.2, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
      />

      {/* Traveling pulse: request -> queue -> signature, looping (settles at
          "signature" — the completed state — under reduced motion) */}
      <motion.circle
        r={5}
        style={{ fill: color }}
        animate={reduceMotion ? { cx: STAGES[2].x, cy: Y } : { cx: [STAGES[0].x, STAGES[1].x, STAGES[1].x, STAGES[2].x], cy: Y }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : { duration: 2.4, repeat: Infinity, repeatDelay: 0.8, ease: 'easeInOut', times: [0, 0.45, 0.6, 1] }
        }
      />
    </svg>
  );
}
