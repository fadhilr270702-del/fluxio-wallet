import React from 'react';
import { motion } from 'framer-motion';

const WIDTH = 280;
const HEIGHT = 160;
const DEVICE_CX = 105;
const DEVICE_CY = 80;
const DEVICE_R = 62;
const SERVER_X = 235;
const SERVER_Y = 80;

const PARTICLES = [
  { angle: 20, r: 30 },
  { angle: 140, r: 38 },
  { angle: 250, r: 24 }
];

const DEVICE_ORIGIN = `${DEVICE_CX}px ${DEVICE_CY}px`;
// Circumference-based dash pattern for the boundary "crawl" — a 6-on/6-off
// rhythm around the full circle, offset-animated rather than transform-
// rotated so it reads as the boundary itself cycling, independent of the
// particle orbit's own rotation speed.
const BOUNDARY_CIRCUMFERENCE = 2 * Math.PI * DEVICE_R;

/**
 * The inverse composition of every other tab: contained, not radiating.
 * Data particles orbit inside a bounded "device" boundary (via a single
 * rotating <motion.g> around the device center — rotating the group, not
 * animating each particle's cx/cy between two unrelated points, is what
 * actually traces a circle instead of a fixed point); the dashed boundary
 * itself slowly "crawls"; a separate small particle periodically tries to
 * reach the server and fades out before it gets there; and the blocked
 * connection's X pulses gently — the one visual on this page that
 * deliberately shows something NOT connecting out, matching "nothing
 * leaves your device" literally.
 */
export default function ContainedData({ accent = 'teal', reduceMotion = false }) {
  const color = `var(--${accent})`;
  const escapeStart = DEVICE_CX + DEVICE_R * 0.15;
  const escapeEnd = DEVICE_CX + DEVICE_R - 8;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="feature-visual" aria-hidden="true">
      <motion.circle
        cx={DEVICE_CX}
        cy={DEVICE_CY}
        r={DEVICE_R}
        className="contained-data__boundary"
        style={{ stroke: color, strokeDasharray: BOUNDARY_CIRCUMFERENCE / 20 }}
        animate={reduceMotion ? { strokeDashoffset: 0 } : { strokeDashoffset: [0, -BOUNDARY_CIRCUMFERENCE] }}
        transition={reduceMotion ? { duration: 0 } : { duration: 16, repeat: Infinity, ease: 'linear' }}
      />
      <text x={DEVICE_CX} y={DEVICE_CY + DEVICE_R + 20} textAnchor="middle" className="node-diagram__label">
        device
      </text>

      {/* Orbit: rotating the whole group around the device center actually
          traces a circle per particle (each at its own fixed radius) —
          animating a single particle's cx/cy between two points that both
          resolve to the same coordinate (as a naive angle+360 approach
          would) never moves at all. */}
      <motion.g
        style={{ transformOrigin: DEVICE_ORIGIN }}
        animate={reduceMotion ? { rotate: 0 } : { rotate: 360 }}
        transition={reduceMotion ? { duration: 0 } : { duration: 22, repeat: Infinity, ease: 'linear' }}
      >
        {PARTICLES.map((p, i) => {
          const x = DEVICE_CX + p.r * Math.cos((p.angle * Math.PI) / 180);
          const y = DEVICE_CY + p.r * Math.sin((p.angle * Math.PI) / 180);
          return (
            <motion.circle
              key={i}
              cx={x}
              cy={y}
              r={4}
              style={{ fill: color }}
              animate={reduceMotion ? { opacity: 0.85 } : { opacity: [0.6, 1, 0.6] }}
              transition={
                reduceMotion ? { duration: 0 } : { duration: 2.4, repeat: Infinity, ease: 'easeInOut', delay: i * 0.4 }
              }
            />
          );
        })}
      </motion.g>

      {/* A particle that tries to leave toward the server and fades out
          before it crosses the boundary — "blocked", not just idle. */}
      <motion.circle
        r={3.5}
        cy={DEVICE_CY}
        style={{ fill: color }}
        animate={
          reduceMotion
            ? { cx: escapeStart, opacity: 0 }
            : { cx: [escapeStart, escapeEnd, escapeStart], opacity: [0, 0.9, 0] }
        }
        transition={
          reduceMotion
            ? { duration: 0 }
            : { duration: 2.6, repeat: Infinity, repeatDelay: 1.4, ease: 'easeOut', times: [0, 0.7, 1] }
        }
      />

      {/* Blocked line out to a server — the one thing that explicitly
          does NOT connect. */}
      <line
        x1={DEVICE_CX + DEVICE_R}
        y1={DEVICE_CY}
        x2={SERVER_X - 16}
        y2={SERVER_Y}
        className="contained-data__blocked-line"
      />
      <motion.g
        animate={reduceMotion ? { opacity: 0.6 } : { opacity: [0.4, 0.85, 0.4] }}
        transition={reduceMotion ? { duration: 0 } : { duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
      >
        <line x1={SERVER_X - 10} y1={SERVER_Y - 10} x2={SERVER_X + 10} y2={SERVER_Y + 10} className="contained-data__x" />
        <line x1={SERVER_X - 10} y1={SERVER_Y + 10} x2={SERVER_X + 10} y2={SERVER_Y - 10} className="contained-data__x" />
      </motion.g>

      <rect x={SERVER_X - 16} y={SERVER_Y + 22} width={32} height={20} rx={4} className="contained-data__server" />
      <text x={SERVER_X} y={SERVER_Y + 58} textAnchor="middle" className="node-diagram__label">
        server
      </text>
    </svg>
  );
}
