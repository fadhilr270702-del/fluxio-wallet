import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, useScroll, useMotionValueEvent } from 'framer-motion';
import Icon from './Icon.jsx';
import ChainMark from './ChainMark.jsx';
import useHeadingSweep from '../hooks/useHeadingSweep.js';
import useIsMobile from '../hooks/useIsMobile.js';
import fluxioMono from '../assets/images/logo-fluxio-mono.png';

const CHAINS = [
  { key: 'solana', name: 'Solana', derivation: 'SLIP-0010' },
  { key: 'ethereum', name: 'Ethereum', derivation: 'BIP-44' },
  { key: 'bnb', name: 'BNB', derivation: 'BIP-44' },
  { key: 'base', name: 'Base', derivation: 'BIP-44' }
];

// Heading treatment (prompt 0127): unlike Features' per-WORD stagger, this
// title is split per CHAIN NAME (comma-included) — "Solana," "Ethereum,"
// "BNB," "Base." — a segment-level stagger that thematically echoes the
// section's own one-chain-at-a-time reveal instead of an arbitrary
// per-word split. No accent word here (deliberate exception to the
// "one accent word" default): all four names carry equal weight, and
// singling one chain out in teal would misleadingly suggest it matters
// more than the other three. whileInView/once, same as every other new
// heading here — this title never had a pin-scrubbed tie the way How it
// works'/Vault's/Extension's did, so there was no existing mechanism to
// preserve or work around.
//
// Each segment slides in slightly (x) + fades — the originally-planned
// "blur-to-focus" (filter:blur()) accompaniment was DROPPED after a real,
// empirically-reproduced rendering bug, not a theoretical concern: a
// child of a .section-head__title (background-clip:text gradient) parent
// that also animates `filter` renders with genuinely INVISIBLE text in
// Chromium/Edge — confirmed by toggling `filter` on/off directly against
// the live rendered DOM (removing it made the text reappear; every other
// computed style was byte-for-byte identical to its visible siblings).
// Not the 0077 blur-overshoot lesson (a spring value going out of
// bounds) — this is a distinct, more fundamental incompatibility between
// filter and background-clip:text on the same paint chain, independent
// of tween vs spring. Plain x-slide + fade avoids the whole bug class.
const NETWORKS_HEADLINE_SEGMENTS = ['Solana,', 'Ethereum,', 'BNB,', 'Base.'];

const DESC =
  'A single BIP-39 mnemonic derives every account you need, via SLIP-0010 for Solana and BIP-44 for every EVM chain. Ethereum, BNB and Base share one address; nothing is re-derived, nothing is duplicated.';

// Scroll-scrubbed stage budget across the pin's raw scrollYProgress (see
// .networks-pin in design.css — same tall-spacer + sticky-child mechanism
// as HowItWorks.jsx's own pin, offset ['start start','end start']).
//
// Crucial subtlety this budget has to respect (the bug in prompt/0068):
// that offset pairing defines progress=1 as "the wrapper's own bottom
// edge reaches the viewport's top edge" — a purely geometric statement
// about the WRAPPER, unrelated to when the ~100vh-tall STICKY CHILD inside
// it actually runs out of room and stops sticking. Native position:sticky
// releases earlier, once the wrapper has only one viewport-height of
// scroll room left: raw progress = (PIN_HEIGHT_VH - 100) / PIN_HEIGHT_VH.
// Locking anywhere past that point locks onto a scroll position where the
// section has *already* scrolled away — exactly what prompt/0068 reported
// (title pushed toward the top, card missing entirely). PIN_HEIGHT_VH must
// match .networks-pin's own height in design.css.
const PIN_HEIGHT_VH = 380;
const RELEASE_PROGRESS = (PIN_HEIGHT_VH - 100) / PIN_HEIGHT_VH;
// The 4 chain stages (equal quarters) and the lock both stay comfortably
// under RELEASE_PROGRESS (0.62 vs ~0.737), leaving real scroll distance as
// a buffer the lock's own overshoot-correction (see the effect below) has
// room to work within before hitting the point content would actually
// start scrolling away.
const STAGE_COUNT = CHAINS.length;
const STAGES_END = 0.62;
const LOCK_AT = STAGES_END;

/**
 * Networks — a pinned, scroll-scrubbed two-column reveal (see
 * HowItWorks.jsx for the shared pin technique): a fixed title on the left,
 * one big card on the right that crossfades through Solana -> Ethereum ->
 * BNB -> Base as progress advances, in both directions — the card is a
 * pure function of scroll position (activeIndex is only ever derived from
 * `progress`, never nudged forward on its own), so scrolling back up
 * reverses the sequence exactly as scrolling down advanced it, same
 * reasoning as HowItWorks. Once Base has been showing for a while,
 * forward scroll locks (wheel/touch only — see the effect below) until
 * the arrow button is clicked. The arrow is a genuine open/closed toggle
 * (handleToggle), repeatable indefinitely: opening reveals the
 * description under the title, swaps the card to Fluxio's own mark, and
 * releases the lock; closing hides the description again, swaps the card
 * back to the chain it was showing, and re-locks scroll at the same
 * boundary — driven by one `revealed` boolean flipped on each click, so
 * React + AnimatePresence settle to a consistent state regardless of how
 * fast it's clicked, no separate "mid-transition" state needed.
 *
 * Reduced motion, AND mobile (prompt/0129 — this section had no isMobile
 * bypass at all before, unlike Vault/ExtensionFlow's own `simple` split;
 * every mobile visitor was getting the full desktop pin (380vh) plus the
 * wheel/touch scroll-LOCK below, a genuine scroll trap on a touch device
 * with no obvious way out short of noticing the small reveal arrow),
 * drop the pin AND the lock entirely (see .networks-pin--static) — a
 * plain static section with the title, description, and all 4 chains
 * shown at once in a small grid, no interaction required. Reuses the
 * exact same static-grid markup for both conditions rather than giving
 * mobile its own whileInView-staggered entrance (the treatment
 * Vault/ExtensionFlow's mobile branches get) — correctness (no more
 * trap) over polish parity; see prompt/0129's own report for that as an
 * open follow-up rather than a bug.
 */
export default function Networks() {
  const pinRef = useRef(null);
  const reduceMotion = useReducedMotion();
  const isMobile = useIsMobile();
  const simple = reduceMotion || isMobile;
  // Continuous color sweep (prompt 0127 Revision 1) — 900ms covers this
  // heading's own entrance in full (4 segments, last delay 3*0.08=0.24s +
  // its own 0.65s transition).
  const sweep = useHeadingSweep({ entranceMs: 900, reduceMotion });

  const [activeIndex, setActiveIndex] = useState(0);
  const [locked, setLocked] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const revealedRef = useRef(false);
  const touchStartYRef = useRef(0);
  // True only while *this component's own* code is programmatically
  // moving scroll (the lock-engage snap-back, or the safety-net
  // correction below) — never while the user is actually scrolling. See
  // the motion-value handler right below for why this exists (prompt/
  // 0069): those corrective scrollTo calls change real scrollY, which
  // useScroll picks up exactly like genuine user scroll, and without this
  // guard that fed straight back into activeIndex/locked. It's reset both
  // by the correction's own onComplete and, defensively, by a fallback
  // timer + the effect's cleanup (prompt/0070) — if it ever got stuck
  // true (an interrupted animation whose onComplete never fires), every
  // future scroll update, forward *and* backward, would silently stop
  // updating the card at all, which is exactly the "scrolling up does
  // nothing" bug that prompt reported.
  const correctingRef = useRef(false);

  useEffect(() => {
    revealedRef.current = revealed;
  }, [revealed]);

  const { scrollYProgress: progress } = useScroll({
    target: pinRef,
    offset: ['start start', 'end start']
  });

  useMotionValueEvent(progress, 'change', (v) => {
    // window.__fluxioSectionJumpInProgress (prompt 0123 Revision 1): set
    // by utils/scrollToSlide.js for the duration of a programmatic
    // cross-section jump (e.g. clicking "Vault" from /privacy, which has
    // to scroll straight past this section to get there). Same idea as
    // this component's own revealedRef/correctingRef guards just above —
    // without it, that jump's own scroll-through reads as the user
    // scrolling down to the last chain without revealing it, engages the
    // lock, and snaps them back into this section instead of letting them
    // land where they actually clicked.
    if (revealedRef.current || correctingRef.current || window.__fluxioSectionJumpInProgress) return;
    setActiveIndex(Math.min(STAGE_COUNT - 1, Math.max(0, Math.floor((v / STAGES_END) * STAGE_COUNT))));
    setLocked(v >= LOCK_AT);
  });

  // The gate.
  //
  // NOT window.__lenis.stop()/`lock:true` any more (prompt/0071) — read
  // Lenis's own source again and found the actual, exact line: its wheel/
  // touch handler does `if (this.isStopped || this.isLocked) {
  // event.preventDefault(); return }` — unconditionally, for *every*
  // gesture regardless of direction. .stop() and the scrollTo `lock`
  // option both set one of those two flags, so both blocked backward
  // scroll exactly as hard as forward — that's the "scroll ke atas ikut
  // terkunci" bug reported. Fixed by using a *scoped, direction-agnostic*
  // opt-out instead: `data-lenis-prevent-vertical` is one of Lenis's own
  // documented escape-hatch attributes, checked earlier in that same
  // handler, *before* the isStopped/isLocked branch — a node carrying it
  // makes Lenis ignore wheel/touch over that subtree entirely (both
  // directions) rather than smoothing them, falling through to plain
  // native scroll. Lenis itself is never stopped/locked any more; only
  // this one subtree opts out of its handling while locked.
  //
  // With Lenis out of the way, *our own* wheel/touchmove listeners below
  // are what actually implement the asymmetry: forward gestures (wheel
  // deltaY>0, a touch drag that moves the finger up) get preventDefault'd
  // against plain native scroll; backward gestures are never touched at
  // all, so scrolling back up to revisit earlier chains works immediately
  // and naturally re-unlocks once progress drops back below LOCK_AT — and
  // continuing to scroll up past the section's own start exits it
  // normally into whatever comes before, exactly like backward scroll
  // anywhere else on the page. Keyboard scrolling (PageDown/Space/arrow
  // keys/End) is deliberately never touched by any of this, at all — the
  // permanently-open escape hatch behind "pastikan tidak ada jebakan
  // scroll", so a bug in the gate's own logic can never turn into a real
  // keyboard trap.
  //
  // boundaryY is computed from the pin element's own live geometry
  // (getBoundingClientRect), not from window.scrollY at the moment this
  // effect happens to run — deriving it from the element's real position
  // is correct regardless of how much overshoot already happened by the
  // time we get here. The corrective scrollTo calls no longer need `force`
  // (Lenis isn't stopped/locked globally any more, so it accepts new
  // targets normally) — they're still routed through Lenis rather than a
  // raw window.scrollTo so Lenis's own internal scroll bookkeeping stays
  // in sync with reality. The `scroll` listener remains a continuous
  // safety net for anything that still slips past regardless (scrollbar
  // drag, which fires native `scroll` with no wheel/touch event to
  // intercept at all) — every correction re-targets the same
  // analytically-correct boundaryY, never "wherever it drifted to", and
  // only ever fires for *forward* overshoot (scrollY past the boundary) —
  // it never touches scrollY below it, so it can't interfere with
  // backward scroll either.
  useEffect(() => {
    if (simple || !locked) return undefined;

    const pin = pinRef.current;
    const rect = pin.getBoundingClientRect();
    const pinTop = window.scrollY + rect.top;
    const boundaryY = pinTop + LOCK_AT * rect.height;

    pin.setAttribute('data-lenis-prevent-vertical', '');

    correctingRef.current = true;
    window.__lenis?.scrollTo(boundaryY, {
      duration: 0.6,
      onComplete: () => {
        correctingRef.current = false;
      }
    });
    // Defensive fallback (prompt/0070): guarantees the flag clears even if
    // onComplete never fires for some reason (an interrupted/replaced
    // animation, or any other edge case) — a little past the animation's
    // own 0.6s duration, so it can never mask real scroll updates for
    // longer than the correction itself should ever take.
    const correctingFallback = setTimeout(() => {
      correctingRef.current = false;
    }, 700);

    const onWheel = (e) => {
      if (e.deltaY > 0) e.preventDefault();
    };
    const onTouchStart = (e) => {
      touchStartYRef.current = e.touches[0].clientY;
    };
    const onTouchMove = (e) => {
      const draggedUp = touchStartYRef.current - e.touches[0].clientY;
      if (draggedUp > 0) e.preventDefault();
    };
    const onScroll = () => {
      if (window.scrollY > boundaryY + 2) {
        correctingRef.current = true;
        window.__lenis?.scrollTo(boundaryY, { immediate: true });
        correctingRef.current = false;
      }
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      // Defensive reset, not just onComplete/the fallback timer above — if
      // `locked` flips back to false (scrolled back up, or the toggle
      // closed) while the initial snap-back animation is still mid-flight,
      // this may never reach onComplete on its own. Guaranteeing the flag
      // clears here too means it can never get stuck true and silently
      // block real activeIndex/locked updates afterward.
      clearTimeout(correctingFallback);
      correctingRef.current = false;
      pin.removeAttribute('data-lenis-prevent-vertical');
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('scroll', onScroll);
    };
  }, [locked, simple]);

  // Toggle. Opening releases the lock; closing re-engages it — setting
  // `locked` back to true here re-triggers the exact same lock effect
  // above (it only cares that the value changed, not what changed it), so
  // the snap-back/wheel-block/etc. all re-attach identically to the
  // scroll-driven path.
  const handleToggle = () => {
    if (revealed) {
      setRevealed(false);
      setLocked(true);
    } else {
      setRevealed(true);
      setLocked(false);
    }
  };

  const current = CHAINS[activeIndex];
  const cardKey = revealed ? 'fluxio' : current.key;

  return (
    <div ref={pinRef} className={`networks-pin ${simple ? 'networks-pin--static' : ''}`} id="networks">
      <section className="networks-inner">
        {simple ? (
          <div className="h-scroll__stack">
            <div className="section-head">
              <span className="eyebrow">One seed · Four networks</span>
              <h2 className="section-head__title">Solana, Ethereum, BNB, Base.</h2>
              <p className="section-head__desc">{DESC}</p>
            </div>
            <div className="networks-static-grid">
              {CHAINS.map((c) => (
                <div className="networks-card networks-card--static" key={c.key}>
                  <div className="networks-card__mark-wrap">
                    <ChainMark chain={c.key} />
                  </div>
                  <div className="networks-card__footer">
                    <span className="networks-card__name">{c.name}</span>
                    <span className="networks-card__meta">{c.derivation}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="networks-split">
            <div className="networks-split__left">
              <span className="eyebrow">One seed · Four networks</span>
              <h2 className="section-head__title" ref={sweep.ref}>
                {NETWORKS_HEADLINE_SEGMENTS.map((seg, i) => (
                  <motion.span
                    key={seg}
                    className="networks-heading-segment"
                    initial={{ opacity: 0, x: -14 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true, amount: 0.6 }}
                    transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1], delay: i * 0.08 }}
                    style={{
                      animationPlayState: sweep.sweeping ? 'running' : 'paused',
                      animationDelay: `${i * 1.2}s`
                    }}
                  >
                    {seg}
                    {i < NETWORKS_HEADLINE_SEGMENTS.length - 1 ? ' ' : ''}
                  </motion.span>
                ))}
              </h2>
              <AnimatePresence>
                {revealed && (
                  <motion.p
                    className="networks-split__desc"
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  >
                    {DESC}
                  </motion.p>
                )}
              </AnimatePresence>
              <div className="networks-icons">
                <button
                  type="button"
                  className={`networks-arrow ${revealed ? 'networks-arrow--up' : 'networks-arrow--down networks-arrow--pulse'}`}
                  onClick={handleToggle}
                  aria-expanded={revealed}
                  aria-label={revealed ? 'Hide description and lock this section again' : 'Reveal more and continue scrolling'}
                >
                  <Icon name="arrow-right" />
                </button>
              </div>
            </div>

            <div className="networks-split__right">
              <AnimatePresence mode="wait">
                <motion.div
                  key={cardKey}
                  className="networks-card"
                  initial={{ opacity: 0, y: 24 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -24 }}
                  transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="networks-card__mark-wrap">
                    {revealed ? (
                      <img src={fluxioMono} alt="" className="networks-card__fluxio" />
                    ) : (
                      <ChainMark chain={current.key} />
                    )}
                  </div>
                  <div className="networks-card__footer">
                    <span className="networks-card__name">{revealed ? 'Fluxio' : current.name}</span>
                    {!revealed && <span className="networks-card__meta">{current.derivation}</span>}
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
