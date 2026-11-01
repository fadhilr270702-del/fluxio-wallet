import React from 'react';
import { motion } from 'framer-motion';

const SIZE = 300;
const CENTER = SIZE / 2;
const RADIUS = 108;

/**
 * A small radial "live data" diagram — a pulsing central node with lines
 * radiating out to labeled peripheral nodes, evenly spaced by angle.
 * Deliberately abstract (not a literal chart of anything measured) since
 * the labels themselves are the real content: each Features tab passes its
 * own set of accurate terms from its own real implementation (see the
 * `nodes` field on FEATURES in Landing.jsx — e.g. PBKDF2/salt/nonce for
 * the vault, the four real chain names for derivation), not fabricated
 * metrics. Re-mounts (via the `key` prop the caller passes, tied to the
 * active tab) to replay the stagger-in entrance on every tab switch,
 * which is what makes this read as "dynamic" rather than a static graphic.
 */
export default function NodeDiagram({ nodes, accent = 'gold', reduceMotion = false }) {
  const points = nodes.map((label, i) => {
    const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    return {
      label,
      x: CENTER + RADIUS * Math.cos(angle),
      y: CENTER + RADIUS * Math.sin(angle)
    };
  });

  const stroke = `var(--${accent})`;

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="node-diagram" aria-hidden="true">
      {points.map((p, i) => (
        <motion.line
          key={p.label}
          x1={CENTER}
          y1={CENTER}
          x2={p.x}
          y2={p.y}
          className="node-diagram__line"
          style={{ stroke }}
          initial={{ opacity: 0, pathLength: 0 }}
          animate={{ opacity: 1, pathLength: 1 }}
          transition={{ duration: 0.5, delay: i * 0.07, ease: 'easeOut' }}
        />
      ))}

      <motion.circle
        cx={CENTER}
        cy={CENTER}
        r={16}
        className="node-diagram__core"
        style={{ fill: stroke }}
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: [0, 1.15, 1], opacity: 1 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      />
      <motion.circle
        cx={CENTER}
        cy={CENTER}
        r={16}
        className="node-diagram__core-pulse"
        style={{ stroke }}
        animate={reduceMotion ? { r: 24, opacity: 0.35 } : { r: [16, 34, 16], opacity: [0.6, 0, 0.6] }}
        transition={reduceMotion ? { duration: 0 } : { duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
      />

      {points.map((p, i) => (
        <motion.g
          key={p.label}
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 16, delay: 0.15 + i * 0.08 }}
        >
          <circle cx={p.x} cy={p.y} r={5} className="node-diagram__node" style={{ fill: stroke }} />
          <text
            x={p.x}
            y={p.y + (p.y > CENTER ? 20 : -14)}
            textAnchor="middle"
            className="node-diagram__label"
          >
            {p.label}
          </text>
        </motion.g>
      ))}
    </svg>
  );
}
