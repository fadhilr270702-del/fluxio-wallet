import React from 'react';
import { motion } from 'framer-motion';

const WIDTH = 280;
const HEIGHT = 140;
const WEBPAGE_X = 34;
const GATE_X = WIDTH / 2;
const CORE_X = WIDTH - 34;
const Y = HEIGHT / 2;

/**
 * A request traveling from an untrusted webpage, through a validation
 * gate, to the wallet core — the extension's actual origin-check model as
 * a left-to-right pipeline, not a radial diagram, so it doesn't just look
 * like the vault/derivation diagrams with different labels.
 */
export default function GatedRequest({ accent = 'teal', reduceMotion = false }) {
  const color = `var(--${accent})`;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="feature-visual" aria-hidden="true">
      <line x1={WEBPAGE_X} y1={Y} x2={CORE_X} y2={Y} className="node-diagram__line" style={{ stroke: color }} />

      {/* Webpage */}
      <circle cx={WEBPAGE_X} cy={Y} r={16} className="gated-request__node" style={{ stroke: color }} />
      <text x={WEBPAGE_X} y={Y - 26} textAnchor="middle" className="node-diagram__label">webpage</text>

      {/* Gate */}
      <motion.rect
        x={GATE_X - 20}
        y={Y - 30}
        width={40}
        height={60}
        rx={10}
        className="gated-request__gate"
        style={{ stroke: color }}
        animate={reduceMotion ? { opacity: 0.85 } : { opacity: [0.5, 1, 0.5] }}
        transition={reduceMotion ? { duration: 0 } : { duration: 2, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.line
        x1={GATE_X - 16}
        x2={GATE_X + 16}
        y1={Y - 24}
        y2={Y - 24}
        className="gated-request__scan"
        style={{ stroke: color }}
        animate={
          reduceMotion
            ? { y1: Y, y2: Y, opacity: 0.7 }
            : { y1: [Y - 24, Y + 24, Y - 24], y2: [Y - 24, Y + 24, Y - 24] }
        }
        transition={reduceMotion ? { duration: 0 } : { duration: 2, repeat: Infinity, ease: 'easeInOut' }}
      />
      <text x={GATE_X} y={Y - 42} textAnchor="middle" className="node-diagram__label">origin check</text>

      {/* Wallet core */}
      <circle cx={CORE_X} cy={Y} r={18} className="gated-request__core" style={{ fill: color }} />
      <text x={CORE_X} y={Y - 28} textAnchor="middle" className="node-diagram__label">wallet core</text>

      {/* Traveling request dot — pauses visually at the gate via the
          keyframe spacing (spends two of six segments near GATE_X). */}
      <motion.circle
        r={5}
        style={{ fill: color }}
        animate={
          reduceMotion
            ? { cx: CORE_X, cy: Y }
            : { cx: [WEBPAGE_X, GATE_X - 14, GATE_X, GATE_X, GATE_X + 14, CORE_X], cy: Y }
        }
        transition={
          reduceMotion
            ? { duration: 0 }
            : { duration: 2.6, repeat: Infinity, repeatDelay: 0.6, ease: 'easeInOut', times: [0, 0.32, 0.42, 0.58, 0.68, 1] }
        }
      />
    </svg>
  );
}
