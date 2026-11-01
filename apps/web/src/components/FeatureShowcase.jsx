import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import Icon from './Icon.jsx';
import NodeDiagram from './NodeDiagram.jsx';
import SeedBlocks from './feature-visuals/SeedBlocks.jsx';
import GatedRequest from './feature-visuals/GatedRequest.jsx';
import ApprovalPipeline from './feature-visuals/ApprovalPipeline.jsx';
import ContainedData from './feature-visuals/ContainedData.jsx';

const AUTOPLAY_MS = 4200;

// Maps each FEATURES entry's `variant` field (Landing.jsx) to the component
// that renders its distinct visual. `node-diagram` is shared by two features
// (derivation, vault) — the rest each get a one-off, purpose-built diagram.
const VARIANTS = {
  'seed-blocks': SeedBlocks,
  'node-diagram': NodeDiagram,
  'gated-request': GatedRequest,
  'approval-pipeline': ApprovalPipeline,
  'contained-data': ContainedData
};

/**
 * Tabbed picker driving a two-column detail: bracketed label + headline +
 * paragraph on the left (the feature's own real copy, unchanged), an
 * animated visual + one static caption line on the right. Same
 * `active`/`paused`/auto-advance state machine this component already had
 * (see git history). Each feature now renders its own distinct visual
 * (looked up by `variant`) instead of a single shared diagram with swapped
 * labels — see VARIANTS above.
 *
 * The diagram's caption is deliberately a single static line per feature,
 * not an independently auto-cycling sub-stage — the diagram itself
 * (pulsing core, staggered node entrance, replayed on every tab switch)
 * is what carries the "dynamic" feel, without a second animation timeline
 * to keep in sync with the tab auto-advance.
 */
export default function FeatureShowcase({ features }) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (paused) return undefined;
    const id = setTimeout(() => setActive((i) => (i + 1) % features.length), AUTOPLAY_MS);
    return () => clearTimeout(id);
  }, [active, paused, features.length]);

  const current = features[active];
  const Visual = VARIANTS[current.variant] || NodeDiagram;

  return (
    <div className="showcase" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="showcase__tabs">
        {features.map((f, i) => {
          const isActive = i === active;
          return (
            <button
              type="button"
              key={f.title}
              className={`showcase__tab showcase__tab--${f.accent} ${isActive ? 'showcase__tab--active' : ''}`}
              onClick={() => setActive(i)}
            >
              <span className="showcase__tab-num">{String(i + 1).padStart(2, '0')}</span>
              {f.title}
            </button>
          );
        })}
      </div>

      <div className="showcase__stage" style={{ '--stage-glow': `var(--${current.accent === 'gold' ? 'gold' : 'teal'})` }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={active}
            className={`showcase__panel showcase__panel--${current.accent}`}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -18 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="showcase__panel-copy">
              <span className="showcase__panel-label">( {current.label} )</span>
              <span className="showcase__panel-icon">
                <Icon name={current.icon} />
              </span>
              <h3 className="showcase__panel-title">{current.title}</h3>
              <p className="showcase__panel-desc">{current.desc}</p>
            </div>

            <div className="showcase__panel-diagram">
              <Visual key={active} nodes={current.nodes} accent={current.accent} reduceMotion={reduceMotion} />
              <p className="showcase__panel-caption">{current.label} · live in the wallet core</p>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
