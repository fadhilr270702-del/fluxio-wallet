import React, { useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';

const ITEMS = [
  {
    q: 'Is Fluxio custodial?',
    a: 'No. Private keys and the mnemonic are derived and encrypted on your device. There are no custodial servers, and nothing sensitive is ever transmitted over the network.'
  },
  {
    q: 'Which networks are supported?',
    a: 'Solana via SLIP-0010, plus Ethereum, BNB and Base via BIP-44. Every EVM chain shares one derived account instead of deriving again separately.'
  },
  {
    q: 'How is my seed phrase protected?',
    a: 'It is sealed into an AES-256-GCM vault before it ever touches disk, key derived with PBKDF2 at 600,000 iterations, with a unique salt and nonce every time. Tampering or a wrong password fails loudly, not silently.'
  },
  {
    q: 'Is the code open source?',
    a: 'Yes. The source is published on GitHub under the MIT license, so anyone can read it, build it and compare it with what ships on the Chrome Web Store. Internal prompts, runbooks and notes are not part of the public repo.'
  },
  {
    q: 'Should I trust it with real funds today?',
    a: 'Fluxio is under active development. The vault, derivation and signing logic are real, tested cryptography, but treat it as early software and only move funds you are comfortable testing with.'
  }
];

// Every claim here is already made elsewhere on the page (Vault/Extension
// sections, this same FAQ list's own answers above) — restated as a
// declarative stance, not a new claim, per the prompt's own "hanya dari
// klaim yang memang sudah ada" instruction. Split on plain spaces for the
// per-word reveal below; punctuation stays attached to its word.
const INTRO_TEXT =
  'No custodial servers. No seed phrase ever leaves your device. Every vault is sealed with AES-256-GCM and PBKDF2 before it touches disk. Every signature waits for your explicit approval. The code is open, auditable, not a black box.';
const WORDS = INTRO_TEXT.split(' ');

// Each word's own dim -> bright window is wider than its 1/N slot
// (FADE_SPAN > 1/WORDS.length), so several neighboring words are always
// mid-transition at once — a soft wave moving through the text as you
// scroll, matching the reference's gradient look, rather than a hard
// per-word on/off cut.
const FADE_SPAN = 0.08;

function RevealWord({ word, index, progress }) {
  const start = index / WORDS.length;
  const end = Math.min(1, start + FADE_SPAN);
  // Framer Motion interpolates color strings directly when given as the
  // output range — no separate opacity motion value needed. #3a3a3a is
  // the prompt's own specified "dim" value for our black background (the
  // reference site runs light-background dim(mid-gray)->bright(black); on
  // #000000 the direction flips to dim(dark gray)->bright(white)).
  // Bright endpoint nudged from pure #ffffff to #faf7f0 (prompt 0127 —
  // this is design.css's own --paper token, the warm-ivory half of the
  // new section-heading gradient system) so this paragraph's fully-lit
  // state reads as the same tone as the rest of the page's display
  // headings, without touching the scroll-scrub mechanism itself at all.
  const color = useTransform(progress, [start, end], ['#3a3a3a', '#faf7f0']);
  return (
    <motion.span style={{ color }}>
      {word}
      {index < WORDS.length - 1 ? ' ' : ''}
    </motion.span>
  );
}

// No pin here — deliberately (see design.css's own .faq-reveal__text
// comment for the full reasoning). The paragraph's own considerable
// height at this font size already provides real scroll runway as it
// passes through the viewport; useScroll's offset fractions
// (['start 0.9','end 0.25']) map that natural pass-through to the 0..1
// reveal range, same technique as Vault's non-pinned mobile choreography
// (prompt/0075) — proven within this session already, reused here
// because it fits this effect natively rather than needing a pin adapted
// to it.
function IntroReveal({ reduceMotion }) {
  const ref = useRef(null);
  const { scrollYProgress: progress } = useScroll({
    target: ref,
    offset: ['start 0.9', 'end 0.25']
  });

  if (reduceMotion) {
    return <p className="faq-reveal__text faq-reveal__text--static">{INTRO_TEXT}</p>;
  }

  return (
    <p ref={ref} className="faq-reveal__text">
      {WORDS.map((word, i) => (
        <RevealWord key={i} word={word} index={i} progress={progress} />
      ))}
    </p>
  );
}

export default function Faq() {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(0);

  return (
    <div className="faq">
      <div className="faq-head">
        <span className="eyebrow">Common questions</span>
        <h2 className="faq__title">Straight answers, not fine print.</h2>
      </div>
      <IntroReveal reduceMotion={reduceMotion} />
      <div className="faq__list">
        {ITEMS.map((item, i) => {
          const isOpen = open === i;
          return (
            <div className={`faq__item ${isOpen ? 'faq__item--open' : ''}`} key={item.q}>
              <button
                type="button"
                className="faq__question"
                onClick={() => setOpen(isOpen ? -1 : i)}
                aria-expanded={isOpen}
              >
                {item.q}
                <span className="faq__toggle" aria-hidden="true">{isOpen ? '−' : '+'}</span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    className="faq__answer-wrap"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <p className="faq__answer">{item.a}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}
