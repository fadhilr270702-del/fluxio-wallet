import React, { useRef } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import Icon from './Icon.jsx';
import useHeadingSweep from '../hooks/useHeadingSweep.js';

// Real copy only — the longer descriptions are the actual step copy this
// section already had; `back` is a short, faithful compression of that
// same sentence for the flipped card face, not a new claim (per
// prompt/0059: "silakan rumuskan dari copy yang sudah ada, jangan buat
// klaim baru").
const STEPS = [
  {
    num: '01',
    icon: 'sprout',
    title: 'Generate',
    accent: 'gold',
    desc: 'A CSPRNG backed BIP-39 mnemonic, 12 or 24 words, checksum validated on the spot.',
    back: 'A real mnemonic, generated on your device.'
  },
  {
    num: '02',
    icon: 'layers',
    title: 'Derive',
    accent: 'teal',
    desc: 'SLIP-0010 for Solana, BIP-44 for EVM. One seed becomes every account you need.',
    back: 'One seed becomes every account, instantly.'
  },
  {
    num: '03',
    icon: 'lock',
    title: 'Encrypt',
    accent: 'gold',
    desc: 'Your mnemonic is sealed into an AES-256-GCM vault before it ever touches disk.',
    back: 'Locked away before it ever touches disk.'
  },
  {
    num: '04',
    icon: 'check-shield',
    title: 'Approve & sign',
    accent: 'teal',
    desc: 'Every signature waits on your explicit approval. Real cryptography, real consent.',
    back: 'Nothing signs without your explicit approval.'
  }
];

// Scroll-scrubbed stage budget across the pin wrapper's 0..1 progress (see
// .how-it-works-pin in design.css for the tall-spacer + sticky-child
// mechanism itself — the same technique as the hero -> stats pin, just
// carrying several sequential named stages instead of one continuous
// transform). useTransform clamps outside its own input range by default,
// so a card's appear/flip transform just holds at its start/end value
// before/after its own slice — no extra "hold" logic needed anywhere.
const TITLE = [0.06, 0.16];
const CARD_APPEAR = [
  [0.16, 0.25],
  [0.19, 0.28],
  [0.22, 0.31],
  [0.25, 0.34]
];
const CARD_FLIP = [
  [0.34, 0.46],
  [0.46, 0.58],
  [0.58, 0.7],
  [0.7, 0.82]
];

function StepCard({ step, index, progress, reduceMotion }) {
  const [appearStart, appearEnd] = CARD_APPEAR[index];
  const [flipStart, flipEnd] = CARD_FLIP[index];

  const opacity = useTransform(progress, [appearStart, appearEnd], [0, 1]);
  const y = useTransform(progress, [appearStart, appearEnd], [40, 0]);
  const scale = useTransform(progress, [appearStart, appearEnd], [0.92, 1]);
  const rotateY = useTransform(progress, [flipStart, flipEnd], [0, 180]);

  const accentVar = `var(--${step.accent === 'gold' ? 'gold' : 'teal'})`;

  return (
    <motion.div
      className="step-card"
      style={reduceMotion ? undefined : { opacity, y, scale }}
    >
      <motion.div className="step-card__inner" style={reduceMotion ? undefined : { rotateY }}>
        <div className="step-card__face step-card__face--front">
          <div className="step-card__icon-wrap">
            <span className="step-card__icon-ring" style={{ borderColor: accentVar, color: accentVar }}>
              <motion.span
                className="step-card__icon-pulse"
                style={{ borderColor: accentVar }}
                animate={reduceMotion ? { scale: 1.1, opacity: 0.35 } : { scale: [1, 1.35, 1], opacity: [0.5, 0, 0.5] }}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { duration: 2.6, repeat: Infinity, ease: 'easeInOut', delay: index * 0.3 }
                }
              />
              <Icon name={step.icon} />
            </span>
          </div>
          <span className="step-card__num">{step.num} · {step.title}</span>
        </div>
        <div className="step-card__face step-card__face--back">
          <span className="step-card__num step-card__num--back">{step.num} · {step.title}</span>
          <p className="step-card__back-text">{step.back}</p>
        </div>
      </motion.div>
    </motion.div>
  );
}

/**
 * "How it works" — a pinned, scroll-scrubbed sequence: empty -> title fades
 * in -> the 4 step cards stagger in front-first -> each card flips in turn
 * to its concluding-sentence back face -> the pin releases into normal
 * flow. Same mechanism as Landing.jsx's hero -> stats pin (a tall spacer +
 * sticky child + Framer Motion useScroll/useTransform reading progress
 * across it), just with several named stages instead of one continuous
 * transform (see the CARD_APPEAR/CARD_FLIP budget above) — and because
 * every stage is a pure function of scroll position, scrolling back up
 * reverses the whole sequence automatically, no separate logic needed.
 * Reduced motion drops the pin (see .how-it-works-pin--static) and shows
 * the end state's layout with every card on its front face, statically.
 */
export default function HowItWorks() {
  const pinRef = useRef(null);
  const reduceMotion = useReducedMotion();

  const { scrollYProgress: progress } = useScroll({
    target: pinRef,
    offset: ['start start', 'end start']
  });

  const eyebrowOpacity = useTransform(progress, TITLE, [0, 1]);
  const eyebrowY = useTransform(progress, TITLE, [24, 0]);
  // Heading gets its own distinct treatment (prompt 0127) — a mask/
  // clip-path reveal rather than the plain fade+rise the eyebrow above
  // still uses: the h2's own box unmasks bottom-to-top (clipPath) while
  // sliding up slightly (y), reading as "text rising from behind an
  // invisible line" in one continuous gesture. Driven by the SAME
  // pin-scrubbed TITLE progress range as the eyebrow above, not a
  // separate whileInView-once trigger — this section's whole entrance is
  // already wired to the pin's scroll progress (see this file's own JSDoc
  // below), and re-deriving that as a one-shot trigger would mean
  // unwinding the pin architecture itself, out of scope for a heading
  // restyle. clip-path interpolates cleanly here (a tween between two
  // `inset()` strings with the same shape, never a spring — the 0077
  // overshoot lesson applies to any interpolated visual property, not
  // just filter:blur()).
  const titleClipPath = useTransform(progress, TITLE, ['inset(0% 0% 100% 0%)', 'inset(0% 0% 0% 0%)']);
  const titleY = useTransform(progress, TITLE, [28, 0]);
  // Continuous color sweep (prompt 0127 Revision 1) — entranceMs:0 here,
  // unlike the whileInView-once sections: this heading's own "entrance"
  // is a pin-scrubbed scroll fraction, not a fixed timer, so there's no
  // equivalent fixed delay to wait out — the sweep just starts as soon as
  // the heading is in view, which in practice still trails slightly
  // behind the scroll-driven reveal simply because reaching TITLE's own
  // progress range takes some real scroll distance first.
  const sweep = useHeadingSweep({ entranceMs: 0, reduceMotion });

  return (
    <div
      ref={pinRef}
      className={`how-it-works-pin ${reduceMotion ? 'how-it-works-pin--static' : ''}`}
      id="how-it-works"
    >
      <section className="how-it-works">
        <div className="h-scroll__stack">
          <div className="section-head">
            <motion.span
              className="eyebrow"
              style={reduceMotion ? undefined : { opacity: eyebrowOpacity, y: eyebrowY }}
            >
              How it works
            </motion.span>
            <motion.h2
              className="section-head__title"
              ref={sweep.ref}
              style={
                reduceMotion
                  ? undefined
                  : { clipPath: titleClipPath, y: titleY, animationPlayState: sweep.sweeping ? 'running' : 'paused' }
              }
            >
              From seed to signature.
            </motion.h2>
          </div>

          <div className="how-it-works__cards">
            {STEPS.map((step, i) => (
              <StepCard key={step.num} step={step} index={i} progress={progress} reduceMotion={reduceMotion} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
