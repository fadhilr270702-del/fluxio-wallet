import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import Icon from './Icon.jsx';
import useHeadingSweep from '../hooks/useHeadingSweep.js';
import { CHROME_WEB_STORE_URL } from '../constants/links.js';

// One merged closing statement, replacing the two competing headline
// blocks this section used to stack (prompt/0086); prompt 0216 Revisi 1
// then reworded the first clause of the old title, which implied open
// source while the repo is private (see that prompt's archive). It still
// reads as a positive closing statement rather than a negative claim,
// fitting as the very last thing said before the footer. All copy below
// is reused verbatim from what the page already said elsewhere (this
// same badge-row/desc previously lived split across the two old blocks)
// — no new claims.
const HEADLINE = 'Built for you, held by you.';
const HEADLINE_WORDS = HEADLINE.split(' ');

const DESC =
  'No custodial servers, no seed phrases in transit, no silent approvals. Fluxio is built to be inspected, not just trusted.';

const BADGES = [
  { icon: 'shield', label: 'Non custodial' },
  { icon: 'lock', label: 'AES-256-GCM' },
  { icon: 'key', label: 'Real BIP-39' },
  { icon: 'puzzle', label: 'Manifest V3' },
  { icon: 'shield', label: 'Built to be audited' }
];

// Same whileInView fade+rise helper this session has used everywhere
// (Vault/Extension's mobile branches) — duplicated locally rather than
// imported, since each section owns its own copy by convention here, not
// because the logic differs.
function reveal(reduceMotion, delay = 0) {
  if (reduceMotion) return {};
  return {
    initial: { opacity: 0, y: 18 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.5 },
    transition: { duration: 0.55, delay, ease: 'easeOut' }
  };
}

/**
 * ClosingCta — the page's last word before the footer, merged from two
 * previously-stacked, competing closing blocks into one message with a
 * clear hierarchy: a quiet row of trust badges leads in, then eyebrow ->
 * headline -> supporting line -> CTA buttons, each staggered in on
 * whileInView as the section scrolls into place (no pin, no scroll-scrub
 * — this is a one-shot entrance, not an ongoing choreography, so a simple
 * staggered reveal is the right amount of motion for a closing moment).
 *
 * The headline reveals word by word (each word its own motion.span,
 * staggered delay) rather than as one block — an echo of the FAQ
 * section's own word-by-word reveal just above it (prompt/0085), but
 * built differently on purpose: that one is a continuous scroll-scrub,
 * this one is a one-time entrance stagger. Related motif, not a repeat
 * of the same mechanism.
 *
 * The gradient-text treatment (.closing-cta__title, shared with
 * .section-head__title's own selector — see design.css) still paints
 * correctly across the per-word child spans: the gradient +
 * background-clip:text lives on the parent <h2>, and the child
 * <motion.span> words simply inherit color:transparent from it (color is
 * an inherited CSS property by default), so the same continuous gradient
 * shows through at every glyph regardless of which nested span it's in.
 *
 * Once its own entrance settles, the primary "Download Now" CTA (a real
 * link to the live Chrome Web Store page since prompt 0187 — motion.a,
 * previously a dead motion.button; the outline "Get Extension" that used
 * to sit beside it was removed in the same prompt, per the owner's own
 * decision, leaving this section a single unambiguous action) gets
 * a slow, quiet ambient glow pulse — the same boxShadow-keyframe pulse
 * technique already used for the Approve button (ExtensionFlow.jsx) and
 * the original shield icon (the now-deleted PanelVisual.jsx) — making it
 * the one thing still moving once everything else has settled, which is
 * exactly what the final CTA on the page should be. Plain keyframes, no
 * spring — the box-shadow-overshoot risk that mattered for Panel.jsx's
 * filter:blur() doesn't apply to a box-shadow spread radius, but this
 * file keeps to tween/keyframes uniformly anyway, matching the rest of
 * this session's discipline around that lesson.
 *
 * Reduced motion: every whileInView reveal and the button's pulse are
 * skipped via reveal()'s {} return and a conditional `animate` — the
 * whole section renders in its settled end-state immediately, no motion
 * anywhere.
 */
export default function ClosingCta() {
  const reduceMotion = useReducedMotion();
  const wordDelay = (i) => 0.26 + i * 0.05;
  const afterWords = wordDelay(HEADLINE_WORDS.length - 1) + 0.15;
  // Continuous color sweep (prompt 0127 Revision 1) — 1150ms covers this
  // heading's own pre-existing per-word entrance in full (last word's
  // delay 0.56s + its own 0.55s transition), left completely unmodified.
  const sweep = useHeadingSweep({ entranceMs: 1150, reduceMotion });

  return (
    <div className="closing-cta">
      <motion.div className="closing-cta__badges badge-row" {...reveal(reduceMotion, 0)}>
        {BADGES.map((b, i) => (
          <motion.span key={b.label} className="badge-pill" {...reveal(reduceMotion, 0.04 * i)}>
            <Icon name={b.icon} /> {b.label}
          </motion.span>
        ))}
      </motion.div>

      <motion.span className="eyebrow" {...reveal(reduceMotion, 0.18)}>
        Built to be audited · Non custodial
      </motion.span>

      <h2
        className="closing-cta__title"
        ref={sweep.ref}
        style={reduceMotion ? undefined : { animationPlayState: sweep.sweeping ? 'running' : 'paused' }}
      >
        {HEADLINE_WORDS.map((word, i) => {
          const isLast = i === HEADLINE_WORDS.length - 1;
          return (
            <motion.span
              key={word + i}
              className="closing-cta__word"
              {...reveal(reduceMotion, wordDelay(i))}
            >
              {word}
              {isLast ? '' : ' '}
            </motion.span>
          );
        })}
      </h2>

      <motion.p className="closing-cta__desc" {...reveal(reduceMotion, afterWords)}>
        {DESC}
      </motion.p>

      <motion.div className="closing-cta__actions" {...reveal(reduceMotion, afterWords + 0.1)}>
        <motion.a
          className="btn btn-primary btn-lg"
          href={CHROME_WEB_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          animate={
            reduceMotion
              ? {}
              : { boxShadow: ['0 0 0 0 rgba(219,176,87,0.35)', '0 0 0 16px rgba(219,176,87,0)', '0 0 0 0 rgba(219,176,87,0)'] }
          }
          transition={{ duration: 2.4, repeat: reduceMotion ? 0 : Infinity, ease: 'easeOut', delay: afterWords + 0.6 }}
        >
          <Icon name="download" /> Download Now
        </motion.a>
      </motion.div>
    </div>
  );
}
