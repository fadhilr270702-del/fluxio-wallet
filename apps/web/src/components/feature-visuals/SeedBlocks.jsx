import React from 'react';
import { motion } from 'framer-motion';

const BLOCK_COUNT = 8;

/**
 * BIP-39 generation, visualized as word-chips filling in one at a time,
 * ending with a small checksum pulse — deliberately abstract (dashes, not
 * real words) so this never reads as an actual displayed recovery phrase.
 */
export default function SeedBlocks({ accent = 'gold', reduceMotion = false }) {
  const color = `var(--${accent})`;

  return (
    <div className="feature-visual feature-visual--seed-blocks" aria-hidden="true">
      <div className="seed-blocks">
        {Array.from({ length: BLOCK_COUNT }).map((_, i) => (
          <motion.div
            key={i}
            className="seed-blocks__chip"
            style={{ borderColor: color }}
            initial={{ opacity: 0.25, scale: 0.85 }}
            animate={{ opacity: [0.25, 1, 0.7], scale: [0.85, 1.05, 1] }}
            transition={{ duration: 0.5, delay: i * 0.18, ease: 'easeOut' }}
          >
            <motion.span
              className="seed-blocks__dash"
              style={{ background: color }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.3, delay: i * 0.18 + 0.15 }}
            />
          </motion.div>
        ))}
      </div>
      <motion.div
        className="seed-blocks__checksum"
        style={{ borderColor: color, color }}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: BLOCK_COUNT * 0.18 + 0.2, duration: 0.4 }}
      >
        <motion.span
          className="seed-blocks__checksum-dot"
          style={{ background: color }}
          animate={reduceMotion ? { scale: 1, opacity: 1 } : { scale: [1, 1.4, 1], opacity: [1, 0.5, 1] }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 1.6, repeat: Infinity, ease: 'easeInOut', delay: BLOCK_COUNT * 0.18 + 0.4 }
          }
        />
        checksum verified
      </motion.div>
    </div>
  );
}
