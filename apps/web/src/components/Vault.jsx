import React, { useRef, useState } from 'react';
import { motion, useReducedMotion, useScroll, useTransform, useMotionValueEvent } from 'framer-motion';
import Icon from './Icon.jsx';
import useIsMobile from '../hooks/useIsMobile.js';
import useHeadingSweep from '../hooks/useHeadingSweep.js';

const DESC =
  'Your mnemonic is sealed behind a password derived key before it ever touches disk, with a unique salt and nonce every time, authenticated so tampering fails loudly instead of silently. Lock the wallet and every secret is scrubbed from memory.';

// Heading text — shared across this file's 3 render branches
// (static/mobile/desktop-pin), defined once rather than duplicated 3
// times. History of the one word this heading used to single out
// ("vault," — this section's own namesake), all the way to its removal:
// Revisions 1/2 gave it its own confined "breathing" pulse (a radial
// glow animating a gradient stop percentage) since a whole-heading pulse
// read as too faint at this aspect ratio; Revision 5 recolored its peak
// to the page's teal; Revision 6's real-Chrome bug report showed that
// stop-percentage-interpolation technique frozen solid, but Revision 6
// itself only fixed the five OTHER sweep sections and left this pulse
// alone; Revision 7 rebuilt it as a two-span opacity-driven glow instead
// (a supposedly safer property) — which the user then reported STILL
// frozen on real Chrome, plus a fresh piece of feedback: the expected
// design was never "one word breathes", it was "the whole heading sweeps
// like every other section." Revision 8 (prompt/0127) acts on both:
// removed the per-word pulse entirely — no more special-cased word, no
// more __base/__glow spans — and moved the whole title onto the exact
// same background-position sweep mechanism as Features/How-it-
// works/Extension/Closing-CTA (see #vault .vault-split__title in
// design.css), driven by this same `sweep.sweeping` state that was
// already wired onto the surrounding <motion.h2>'s own
// animationPlayState all along (previously inert on that element, since
// it had no CSS `animation` of its own to pause/run until now). See that
// CSS rule's own comment for the chosen direction and an investigation
// note on why the opacity approach likely still froze.
function VaultTitleText() {
  return 'A vault, not a spreadsheet.';
}

// Generic BIP-39 wordlist entries only (the actual standard list's own
// early alphabetical words), shuffled — never the canonical "abandon x11 +
// about" all-zero test vector, and never presented as a readable phrase in
// sequence, so nothing here could be mistaken for an actual recovery
// phrase (see prompt/0072).
const WORDS = ['absorb', 'access', 'acoustic', 'abandon', 'accident', 'achieve', 'absurd', 'acquire', 'above', 'acid', 'ability', 'across'];

// Scroll-scrubbed stage budget across the pin's raw scrollYProgress (see
// .vault-pin in design.css — same tall-spacer + sticky-child mechanism as
// HowItWorks.jsx/Networks.jsx's own pins). No scroll-lock here (unlike
// Networks) — the pin just naturally releases once scrolled through, so
// the stage-4 "sealed" state only needs to be fully settled well before
// raw progress reaches 1 (position:sticky's native release point is
// earlier than progress=1 for the same reason documented in Networks.jsx
// — irrelevant here since nothing is gated on hitting it exactly, but the
// choreography still finishes with real margin to spare either way).
//
// Stage 1 now has two beats (prompt/0073): the chips first settle into a
// neat numbered 3x4 grid — reading like a real seed-phrase backup screen —
// and hold there, then break apart into the scattered floating formation
// stage 2's suck-in already expects. GRID_END is new; STAGE1_END keeps its
// original meaning of "fully scattered, ready to be sucked in" so none of
// stage 2/3/4's own constants below needed to change shape, only value.
const GRID_END = 0.12; // grid formed + held (all 12 chips visible, settled)
const STAGE1_END = 0.32; // grid broken apart: chips scattered, floating
const STAGE2_END = 0.55; // sucked in + locked (= stage 3's start)
const STAGE3_END = 0.8; // encryption rings + labels drawn (= sealed/stage 4's start)

const CHIP_COUNT = WORDS.length;
const CHIP_RADII = [42, 47, 39];
const GRID_COLS = [18, 50, 82]; // 3 column centers, % of stage width
const GRID_ROWS = [12, 38, 64, 90]; // 4 row centers, % of stage height — row-major i -> (row,col) below

const CHIP_STAGE2_SPAN = STAGE2_END - STAGE1_END;
const CHIP_TRAVEL = CHIP_STAGE2_SPAN * 0.55;
const CHIP_STAGGER = (CHIP_STAGE2_SPAN - CHIP_TRAVEL) / (CHIP_COUNT - 1);

// Break-apart (grid -> scattered) uses the exact same staggered-travel
// shape as the suck-in below, just over the new GRID_END..STAGE1_END span.
const BREAK_SPAN = STAGE1_END - GRID_END;
const BREAK_TRAVEL = BREAK_SPAN * 0.6;
const BREAK_STAGGER = (BREAK_SPAN - BREAK_TRAVEL) / (CHIP_COUNT - 1);

const CHIPS = WORDS.map((word, i) => {
  const chipStart = STAGE1_END + i * CHIP_STAGGER;
  const breakStart = GRID_END + i * BREAK_STAGGER;
  // Fast, tightly-staggered fade-in so every chip is on screen (and the
  // grid formation reads clearly) well before the first chip's own
  // breakStart — leaving a real, visible "grid held" pause between the two.
  const entranceStart = (i / CHIP_COUNT) * (GRID_END * 0.4);
  return {
    word,
    num: i + 1,
    angle: (i / CHIP_COUNT) * 360 + (i % 2 === 0 ? 9 : -7),
    radius: CHIP_RADII[i % CHIP_RADII.length],
    arcBend: (i % 2 === 0 ? 1 : -1) * (8 + (i % 4) * 3),
    gridX: GRID_COLS[i % 3],
    gridY: GRID_ROWS[Math.floor(i / 3)],
    entranceStart,
    entranceEnd: entranceStart + GRID_END * 0.2,
    breakStart,
    breakEnd: breakStart + BREAK_TRAVEL,
    chipStart,
    chipEnd: chipStart + CHIP_TRAVEL
  };
});

const CLUNK_START = STAGE2_END - 0.03;
const CLUNK_END = STAGE2_END + 0.03;

const RINGS = [
  { radius: 30, accent: 'gold', dash: '2 4', direction: 1, speed: 22, scrollSpan: 140, appearStart: 0.55, appearEnd: 0.6 },
  { radius: 38, accent: 'teal', dash: '1 3', direction: -1, speed: 30, scrollSpan: -100, appearStart: 0.57, appearEnd: 0.62 },
  { radius: 46, accent: 'gold', dash: '3 5', direction: 1, speed: 40, scrollSpan: 70, appearStart: 0.59, appearEnd: 0.64 }
];

const LABELS = [
  { text: 'PBKDF2 · 600,000 iterations', compass: 'top', appearStart: 0.6 },
  { text: 'unique salt', compass: 'right', appearStart: 0.645 },
  { text: 'unique nonce', compass: 'bottom', appearStart: 0.69 },
  { text: 'auth tag', compass: 'left', appearStart: 0.735 }
];
const COMPASS = {
  top: { angle: -90, cls: 'vault-label--top' },
  right: { angle: 0, cls: 'vault-label--right' },
  bottom: { angle: 90, cls: 'vault-label--bottom' },
  left: { angle: 180, cls: 'vault-label--left' }
};
const LABEL_RING_R = 46;
const LABEL_R = 58;

const PARTICLES = [
  { r: 34, duration: 9, delay: 0 },
  { r: 41, duration: 12, delay: 2 },
  { r: 52, duration: 15, delay: 4 }
];

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Entrance-reveal props for the mobile/reduced-motion "simple" branch (see
// Vault() below, prompt/0074) — a plain whileInView fade+rise, fired once
// as each piece scrolls into a normal (non-pinned) viewport, standing in
// for the desktop scroll-scrubbed choreography that branch skips entirely.
// Returns {} under true reduced motion so those elements render with no
// animation at all, same as this file's existing accessibility contract.
function reveal(reduceMotion, delay = 0) {
  if (reduceMotion) return {};
  return {
    initial: { opacity: 0, y: 16 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.4 },
    transition: { duration: 0.5, delay, ease: 'easeOut' }
  };
}

// Chip motion is two staggered, curved beats — both pure functions of raw
// scroll progress `p` (see the reverse-scroll-correctness principle used
// throughout this file), so scrolling up unwinds either beat exactly:
//   1. break-apart: grid position -> scattered position (chip.gridX/Y ->
//      chip.scatterX/Y), a bend on the Y axis only (same technique as #2).
//   2. suck-in: scattered position -> vault center (50,50), unchanged from
//      the original design — once #1 finishes, its own base position IS
//      the scatter position (breakT saturates at 1), so #2 can build on it
//      uniformly regardless of exactly when that happened.
// Left/top are computed via two separate useTransform(progress, fn) calls
// below rather than sharing one motion value — a little redundant trig,
// but keeps each axis a self-contained pure function, cheap for 12 chips.
function chipBreakT(chip, p) {
  return clamp01((p - chip.breakStart) / (chip.breakEnd - chip.breakStart));
}

function chipSuckT(chip, p) {
  return clamp01((p - chip.chipStart) / (chip.chipEnd - chip.chipStart));
}

function chipLeftPct(chip, p) {
  const breakT = chipBreakT(chip, p);
  const baseX = chip.gridX + (chip.scatterX - chip.gridX) * breakT;
  const t = chipSuckT(chip, p);
  return baseX + (50 - baseX) * t;
}

function chipTopPct(chip, p) {
  const breakT = chipBreakT(chip, p);
  const breakBend = chip.arcBend * Math.sin(breakT * Math.PI);
  const baseY = chip.gridY + (chip.scatterY - chip.gridY) * breakT + breakBend;

  const t = chipSuckT(chip, p);
  const suckBend = chip.arcBend * Math.sin(t * Math.PI);

  // Idle float only while genuinely settled — grid-held (small amplitude,
  // keeps the grid reading as tidy) or scattered-held (original amplitude)
  // — never mid-flight of either beat, so the throw/suck-in itself reads
  // as one clean, deliberate motion instead of fighting a wobble.
  const midBreak = breakT > 0 && breakT < 1;
  const wobbleAmp = midBreak ? 0 : breakT <= 0 ? 0.6 : t < 1 ? 1.4 : 0;
  const wobble = wobbleAmp ? Math.sin(p * 34 + chip.angle) * wobbleAmp : 0;

  return baseY + (50 - baseY) * t + (t < 1 ? suckBend : 0) + wobble;
}

function SeedChip({ chip, progress }) {
  const rad = (chip.angle * Math.PI) / 180;
  const full = { ...chip, scatterX: 50 + chip.radius * Math.cos(rad), scatterY: 50 + chip.radius * Math.sin(rad) };

  const left = useTransform(progress, (p) => `${chipLeftPct(full, p)}%`);
  const top = useTransform(progress, (p) => `${chipTopPct(full, p)}%`);
  const opacity = useTransform(
    progress,
    [chip.entranceStart, chip.entranceEnd, chip.chipEnd - 0.02, chip.chipEnd],
    [0, 1, 1, 0]
  );
  const scale = useTransform(progress, [chip.entranceStart, chip.entranceEnd], [0.6, 1]);
  // Number fades out as its own chip breaks apart — once scattered, a
  // random-order loose word chip reads more cleanly than a numbered list
  // item (see prompt/0073); each chip's number fade is keyed to its own
  // breakStart/breakEnd, so the numbers peel off in the same stagger as
  // the break itself rather than all at once.
  const numberOpacity = useTransform(progress, [chip.breakStart, chip.breakEnd], [1, 0]);

  return (
    <motion.span className="vault-chip" style={{ left, top, x: '-50%', y: '-50%', opacity, scale }}>
      <motion.span className="vault-chip__num" style={{ opacity: numberOpacity }}>
        {chip.num}.
      </motion.span>
      {' '}
      {chip.word}
    </motion.span>
  );
}

function EncryptionRing({ ring, sealed, progress }) {
  const opacity = useTransform(progress, [ring.appearStart, ring.appearEnd], [0, 1]);
  const scale = useTransform(progress, [ring.appearStart, ring.appearEnd], [0.85, 1]);
  // Capped at STAGE3_END, not 1 — this outer layer is only meant to be
  // scroll-reactive through stage 3; once sealed it should freeze here and
  // let the inner idle loop take over completely, not keep half-responding
  // to further scroll on top of its own idle spin.
  const scrollRotate = useTransform(progress, [ring.appearStart, STAGE3_END], [0, ring.scrollSpan]);
  const stroke = `var(--${ring.accent})`;

  return (
    <motion.div className="vault-ring-wrap" style={{ opacity, scale, rotate: scrollRotate }}>
      <motion.div
        className="vault-ring-spin"
        animate={sealed ? { rotate: ring.direction * 360 } : { rotate: 0 }}
        transition={sealed ? { duration: ring.speed, repeat: Infinity, ease: 'linear' } : { duration: 0 }}
      >
        <svg viewBox="0 0 100 100" className="vault-ring-svg" aria-hidden="true">
          <circle cx="50" cy="50" r={ring.radius} className="vault-ring-circle" style={{ stroke, strokeDasharray: ring.dash }} />
        </svg>
      </motion.div>
    </motion.div>
  );
}

// Vault core/pulse/badge/glow motion, factored out so the desktop pinned
// choreography and the mobile non-pinned one (see Vault(), prompt/0075)
// can share the exact same math against two different progress sources
// instead of two hand-maintained copies drifting apart. Calling this twice
// unconditionally (once per progress source) is fine under Rules of Hooks
// — each call always runs the same fixed sequence of useTransform hooks.
function useVaultStageMotion(progress) {
  const coreScale = useTransform(progress, [STAGE1_END, CLUNK_START, STAGE2_END, CLUNK_END], [0, 0, 1.18, 1]);
  const coreRotate = useTransform(progress, [CLUNK_START, STAGE2_END, CLUNK_END], [0, -6, 0]);
  const coreOpacity = useTransform(progress, [STAGE1_END, CLUNK_START], [0, 1]);
  const pulseScale = useTransform(progress, [STAGE2_END - 0.005, STAGE2_END, STAGE2_END + 0.05], [1, 1, 2.4]);
  const pulseOpacity = useTransform(progress, [STAGE2_END - 0.005, STAGE2_END, STAGE2_END + 0.05], [0, 0.7, 0]);
  const badgeOpacity = useTransform(progress, [STAGE3_END, STAGE3_END + 0.05], [0, 1]);
  const badgeY = useTransform(progress, [STAGE3_END, STAGE3_END + 0.05], [10, 0]);
  const glowOpacity = useTransform(progress, [STAGE3_END, STAGE3_END + 0.08], [0, 0.35]);
  return { coreScale, coreRotate, coreOpacity, pulseScale, pulseOpacity, badgeOpacity, badgeY, glowOpacity };
}

// Mobile's flat label chips (see .vault-labels-row) fade/rise in as their
// own appearStart is crossed, same timing data as the desktop TechLabel's
// circular version below — just no connector line/compass positioning,
// since that pattern only has room to work in the 2-column desktop layout.
function MobileLabelChip({ label, progress }) {
  const appearEnd = label.appearStart + 0.045;
  const opacity = useTransform(progress, [label.appearStart, appearEnd], [0, 1]);
  const y = useTransform(progress, [label.appearStart, appearEnd], [8, 0]);
  return (
    <motion.span className="vault-label-chip" style={{ opacity, y }}>
      {label.text}
    </motion.span>
  );
}

function TechLabel({ label, progress }) {
  const { angle, cls } = COMPASS[label.compass];
  const rad = (angle * Math.PI) / 180;
  const x1 = 50 + LABEL_RING_R * Math.cos(rad);
  const y1 = 50 + LABEL_RING_R * Math.sin(rad);
  const x2 = 50 + LABEL_R * Math.cos(rad);
  const y2 = 50 + LABEL_R * Math.sin(rad);
  const appearEnd = label.appearStart + 0.045;

  const opacity = useTransform(progress, [label.appearStart, appearEnd], [0, 1]);
  const pathLength = useTransform(progress, [label.appearStart, appearEnd], [0, 1]);

  return (
    <>
      <motion.svg className="vault-label-line-svg" viewBox="0 0 100 100" style={{ opacity }} aria-hidden="true">
        <motion.line x1={x1} y1={y1} x2={x2} y2={y2} className="vault-label-line" style={{ pathLength }} />
      </motion.svg>
      <motion.span className={`vault-label ${cls}`} style={{ left: `${x2}%`, top: `${y2}%`, opacity }}>
        {label.text}
      </motion.span>
    </>
  );
}

/**
 * Vault — a pinned, scroll-scrubbed 4-stage choreography (see
 * HowItWorks.jsx/Networks.jsx for the shared pin technique): fixed text on
 * the left, a big animated stage on the right. No scroll-lock here (unlike
 * Networks) — this is pure scroll-scrubbing, forward and backward, that
 * simply releases into the next section once fully scrolled through.
 *
 * Stage 1 has two beats (prompt/0073), both driven by the same 12 generic
 * BIP-39 word chips (see WORDS):
 *   1a [0, 0.12] — chips fade in already arranged into a neat, numbered
 *      3x4 grid ("1. abandon", "2. ability", ...) — reads like a real
 *      seed-phrase backup screen — and hold there with only a very small
 *      idle wobble, formation staying clearly legible.
 *   1b [0.12, 0.32] — the grid breaks apart: each chip flies outward
 *      (staggered, curved path — same bend technique as stage 2's
 *      suck-in) to the scattered floating positions stage 2 expects; its
 *      number fades out as it flies, since a random-order loose word chip
 *      reads more cleanly once scattered than a numbered list item does.
 * Stage 2 [0.32, 0.55] — chips get pulled inward one at a time along a
 * curved (not straight) path toward center — SeedChip's `bend` term — and
 * fade out as they "arrive"; the vault core scales/rotates in with a
 * small overshoot ("clunk") right at 0.55, with a one-time expanding glow
 * pulse at the same instant.
 * Stage 3 [0.55, 0.8] — 3 dashed rings (different radii/colors/rotation
 * directions) draw themselves in, 4 technical labels reveal in sequence
 * with thin connector lines back to the rings, fine particles start
 * orbiting, and the left column's description fades in.
 * Stage 4 [0.8, 1] — a soft ambient glow and a small "Sealed ·
 * AES-256-GCM" badge fade in. The 3 rings switch from scroll-driven
 * rotation to a true, independent idle spin once here (`sealed` state) —
 * each ring's idle rotation is applied on a *nested* inner element on top
 * of the outer scroll-driven one, so rotations compose additively and the
 * handoff has no visible jump (the idle loop starts at a relative 0, not
 * an absolute angle).
 *
 * Every chip position (grid, break-apart, and suck-in alike) is a pure
 * function of raw scroll progress — no independent timers anywhere in
 * stage 1/1b — so scrolling back up reassembles the grid exactly, same
 * reverse-scroll-correctness principle used everywhere else in this file.
 *
 * Three render modes, not two (prompt/0075 revised prompt/0074's first
 * pass, which had collapsed reduced-motion and mobile into one fully
 * static mode — mobile lost its whole story, not just its pin):
 *
 *   - Desktop (`!reduceMotion && !isMobile`): the full pinned choreography
 *     above, untouched.
 *   - True reduced motion (any width): fully static, zero animation —
 *     stage 4's own settled end-state rendered directly (vault sealed,
 *     rings, badge), no chips (already "absorbed"), no rotation. This is
 *     the one mode `reveal()` returns {} for.
 *   - Mobile with motion allowed (`isMobile && !reduceMotion`): the SAME
 *     staged story as desktop — grid -> break-apart -> suck-in -> lock ->
 *     rings+labels -> sealed — just not pinned, and compressed into a
 *     much shorter, natural scroll distance. It reuses SeedChip and
 *     EncryptionRing verbatim (same CHIPS/RINGS data, same 0..1 stage
 *     boundaries) fed by a *second*, independent scroll-progress source —
 *     `mobileProgress`, from its own useScroll on a ref around just the
 *     visual stage (not the whole section) with viewport-fraction offsets
 *     (['start 0.85','end 0.15']) instead of a tall spacer + sticky
 *     child. That maps the section's entire on-screen dwell time (however
 *     long that naturally is, no artificial height) to progress 0..1, so
 *     the story plays out once as the stage scrolls through view — no
 *     scroll-jacking, the user keeps normal scroll control throughout,
 *     matching "tanpa pin ... animasi reveal saat scroll melewati
 *     section" from the prompt. Particles are dropped (the one deliberate
 *     simplification — "detail boleh dikurangi") and the circular labels
 *     become MobileLabelChip's flat row, but every other beat survives.
 *     useVaultStageMotion() factors the core/pulse/badge/glow math so
 *     desktop and mobile share one implementation against their two
 *     different progress sources instead of two hand-copies drifting
 *     apart. Headline/eyebrow/description keep the plain reveal()
 *     whileInView treatment (prompt/0074) — they're not part of the vault
 *     "story" and don't need scroll-scrubbing.
 *
 * The technical labels also swap from the desktop circular ring pattern
 * (.vault-labels-circular, absolute-positioned, unchanged geometry) to a
 * plain wrapped chip row (.vault-labels-row) via a pure CSS media query
 * at the shared 900px breakpoint — both markups always render in the
 * non-desktop modes, so true-reduced-motion on a wide desktop window
 * still sees the nicer circular layout exactly as before, and only an
 * actually-narrow viewport gets the row. The "Sealed" badge likewise
 * moves from absolute-inside-the-stage (desktop) to a normal-flow sibling
 * below the stage (.vault-badge--static, inside .vault-simple-stack) for
 * both non-desktop modes — bottom:8% inside a circle small enough to sit
 * in a single mobile column has nowhere safe to be. .vault-simple-stack
 * is its own wrapper (not a flex-direction change on the shared
 * .vault-split__right) specifically so the desktop branch's CSS stays
 * byte-identical to before prompt/0074 — an earlier version of this fix
 * changed .vault-split__right itself, which regressed desktop's top label
 * clipping against the pinned viewport (prompt/0075).
 */
export default function Vault() {
  const pinRef = useRef(null);
  const stageRef = useRef(null);
  const reduceMotion = useReducedMotion();
  const isMobile = useIsMobile();
  const simple = reduceMotion || isMobile;
  const [sealed, setSealed] = useState(false);
  const [mobileSealed, setMobileSealed] = useState(false);
  // Continuous color sweep (prompt 0127 Revision 1) — 750ms covers the
  // mobile branch's own title entrance (duration 0.7s + its own 0.05s
  // delay); the desktop-pin branch ignores this (see its own comment
  // below, same reasoning as HowItWorks/ExtensionFlow).
  const sweep = useHeadingSweep({ entranceMs: 750, reduceMotion });

  const { scrollYProgress: progress } = useScroll({
    target: pinRef,
    offset: ['start start', 'end start']
  });

  // Mobile's own progress source (prompt/0075) — no pin/tall spacer, just
  // this ref's natural on-screen dwell time mapped to 0..1 via
  // viewport-fraction offsets. stageRef only ever attaches to a DOM node
  // in the mobile branch below; in the other two modes useScroll simply
  // never receives a target and its motion values sit inert, which is
  // harmless since nothing reads them outside the mobile branch.
  //
  // ['start 1','end 0'] (prompt/0077, widened from the original
  // ['start 0.85','end 0.15']) is the maximum possible range — progress 0
  // at the instant the stage's top edge is anywhere below the viewport
  // bottom (first pixel entering), progress 1 only once its bottom edge
  // has fully left the top. This adds roughly 0.3 * viewport-height of
  // extra physical scroll distance (~250px on a typical phone) to the
  // story's total window vs. the tighter original range. Widened because
  // Vault sits behind Lenis's global smooth-scroll (see useLenis.js) —
  // Lenis turns a single wheel/trackpad gesture into a longer eased
  // animation that can cover more distance than raw native scroll would
  // for the same input, making a short window easy to blow straight
  // through without perceiving the early grid/break-apart beats at all.
  const { scrollYProgress: mobileProgress } = useScroll({
    target: stageRef,
    offset: ['start 1', 'end 0']
  });

  useMotionValueEvent(progress, 'change', (v) => {
    setSealed(v >= STAGE3_END);
  });
  useMotionValueEvent(mobileProgress, 'change', (v) => {
    setMobileSealed(v >= STAGE3_END);
  });

  const headlineOpacity = useTransform(progress, [0, 0.05], [0, 1]);
  // Same rotateX tilt-settle as the mobile branch above, just driven by
  // the pin's own scroll-scrubbed progress instead of whileInView — kept
  // over the same [0, 0.05] slice headlineOpacity already uses rather
  // than introducing a second, separate stage range.
  const titleRotateX = useTransform(progress, [0, 0.05], [-55, 0]);
  const descOpacity = useTransform(progress, [STAGE2_END, STAGE2_END + 0.06], [0, 1]);
  const descY = useTransform(progress, [STAGE2_END, STAGE2_END + 0.06], [12, 0]);

  const particlesOpacity = useTransform(progress, [0.46, 0.55], [0, 1]);

  const desktopMotion = useVaultStageMotion(progress);
  const mobileMotion = useVaultStageMotion(mobileProgress);

  return (
    <div ref={pinRef} className={`vault-pin ${simple ? 'vault-pin--static' : ''}`} id="vault">
      <section className="vault-inner">
        {reduceMotion ? (
          <div className="vault-split">
            <div className="vault-split__left">
              <span className="eyebrow">AES-256-GCM · PBKDF2</span>
              <h2 className="vault-split__title"><VaultTitleText /></h2>
              <p className="vault-split__desc">{DESC}</p>
            </div>
            <div className="vault-split__right">
              <div className="vault-simple-stack">
                <div className="vault-stage vault-stage--static">
                  <span className="vault-glow" style={{ opacity: 0.3 }} />
                  {RINGS.map((ring, i) => (
                    <div className="vault-ring-wrap" key={i}>
                      <svg viewBox="0 0 100 100" className="vault-ring-svg" aria-hidden="true">
                        <circle
                          cx="50"
                          cy="50"
                          r={ring.radius}
                          className="vault-ring-circle"
                          style={{ stroke: `var(--${ring.accent})`, strokeDasharray: ring.dash }}
                        />
                      </svg>
                    </div>
                  ))}
                  {/* Desktop/tablet only (>900px, see .vault-labels-circular
                      in design.css) — unchanged geometry from before
                      prompt/0074. */}
                  <div className="vault-labels-circular">
                    {LABELS.map((label, i) => {
                      const { angle, cls } = COMPASS[label.compass];
                      const rad = (angle * Math.PI) / 180;
                      const x1 = 50 + LABEL_RING_R * Math.cos(rad);
                      const y1 = 50 + LABEL_RING_R * Math.sin(rad);
                      const x2 = 50 + LABEL_R * Math.cos(rad);
                      const y2 = 50 + LABEL_R * Math.sin(rad);
                      return (
                        <React.Fragment key={i}>
                          <svg className="vault-label-line-svg" viewBox="0 0 100 100" aria-hidden="true">
                            <line x1={x1} y1={y1} x2={x2} y2={y2} className="vault-label-line" />
                          </svg>
                          <span className={`vault-label ${cls}`} style={{ left: `${x2}%`, top: `${y2}%` }}>
                            {label.text}
                          </span>
                        </React.Fragment>
                      );
                    })}
                  </div>
                  <div className="vault-core">
                    <Icon name="lock" className="icon" />
                  </div>
                </div>

                {/* Mobile only (<=900px, see .vault-labels-row in
                    design.css) — flat wrapped chips instead of the
                    circular pattern, which only has room to work in the
                    2-column desktop layout (prompt/0074). */}
                <div className="vault-labels-row">
                  {LABELS.map((label) => (
                    <span key={label.text} className="vault-label-chip">
                      {label.text}
                    </span>
                  ))}
                </div>

                <span className="vault-badge vault-badge--static">Sealed · AES-256-GCM</span>
              </div>
            </div>
          </div>
        ) : isMobile ? (
          <div className="vault-split">
            <div className="vault-split__left">
              <motion.span className="eyebrow" {...reveal(false, 0)}>
                AES-256-GCM · PBKDF2
              </motion.span>
              {/* Distinct entrance from the plain reveal() fade+rise every
                  other piece here uses (prompt 0127) — a slight 3D tilt
                  settling flat, echoing a vault door swinging into
                  alignment. perspective on the wrapper, not the h2 itself,
                  so rotateX has real depth to rotate through; tween only
                  (initial/whileInView interpolation is tween by default —
                  never a spring), per the 0077 overshoot lesson noted
                  throughout this file already. */}
              <div style={{ perspective: 600 }}>
                <motion.h2
                  className="vault-split__title"
                  ref={sweep.ref}
                  initial={{ opacity: 0, rotateX: -55, y: 10 }}
                  whileInView={{ opacity: 1, rotateX: 0, y: 0 }}
                  viewport={{ once: true, amount: 0.5 }}
                  transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
                  style={{ transformOrigin: '50% 100%', animationPlayState: sweep.sweeping ? 'running' : 'paused' }}
                >
                  <VaultTitleText />
                </motion.h2>
              </div>
              <motion.p className="vault-split__desc" {...reveal(false, 0.1)}>
                {DESC}
              </motion.p>
            </div>
            <div className="vault-split__right">
              <div className="vault-simple-stack">
                {/* Real staged choreography (prompt/0075), just not pinned
                    — see mobileProgress/useVaultStageMotion above and the
                    Vault() JSDoc's "Mobile with motion allowed" section.
                    Reuses SeedChip/EncryptionRing verbatim; only particles
                    are dropped and labels become flat chips. */}
                <div ref={stageRef} className="vault-stage">
                  <motion.span className="vault-glow" style={{ opacity: mobileMotion.glowOpacity }} />

                  {CHIPS.map((chip) => (
                    <SeedChip key={chip.word} chip={chip} progress={mobileProgress} />
                  ))}

                  {RINGS.map((ring, i) => (
                    <EncryptionRing key={i} ring={ring} sealed={mobileSealed} progress={mobileProgress} />
                  ))}

                  <motion.span
                    className="vault-pulse"
                    style={{ scale: mobileMotion.pulseScale, opacity: mobileMotion.pulseOpacity }}
                  />

                  <motion.div
                    className="vault-core"
                    style={{ scale: mobileMotion.coreScale, rotate: mobileMotion.coreRotate, opacity: mobileMotion.coreOpacity }}
                  >
                    <Icon name="lock" className="icon" />
                  </motion.div>
                </div>

                <div className="vault-labels-row">
                  {LABELS.map((label, i) => (
                    <MobileLabelChip key={label.text} label={label} progress={mobileProgress} />
                  ))}
                </div>

                <motion.span
                  className="vault-badge vault-badge--static"
                  style={{ opacity: mobileMotion.badgeOpacity, y: mobileMotion.badgeY }}
                >
                  Sealed · AES-256-GCM
                </motion.span>
              </div>
            </div>
          </div>
        ) : (
          <div className="vault-split">
            <div className="vault-split__left">
              <motion.span className="eyebrow" style={{ opacity: headlineOpacity }}>
                AES-256-GCM · PBKDF2
              </motion.span>
              <div style={{ perspective: 600 }}>
                <motion.h2
                  className="vault-split__title"
                  ref={sweep.ref}
                  style={{
                    opacity: headlineOpacity,
                    rotateX: titleRotateX,
                    transformOrigin: '50% 100%',
                    animationPlayState: sweep.sweeping ? 'running' : 'paused'
                  }}
                >
                  <VaultTitleText />
                </motion.h2>
              </div>
              <motion.p className="vault-split__desc" style={{ opacity: descOpacity, y: descY }}>
                {DESC}
              </motion.p>
            </div>

            <div className="vault-split__right">
              <div className="vault-stage">
                <motion.span className="vault-glow" style={{ opacity: desktopMotion.glowOpacity }} />

                {CHIPS.map((chip) => (
                  <SeedChip key={chip.word} chip={chip} progress={progress} />
                ))}

                {RINGS.map((ring, i) => (
                  <EncryptionRing key={i} ring={ring} sealed={sealed} progress={progress} />
                ))}

                {LABELS.map((label, i) => (
                  <TechLabel key={i} label={label} progress={progress} />
                ))}

                <motion.div className="vault-particles" style={{ opacity: particlesOpacity }}>
                  {PARTICLES.map((p, i) => (
                    <motion.span
                      key={i}
                      className="vault-particle-orbit"
                      style={{ '--orbit-r': `${p.r}%` }}
                      animate={{ rotate: 360 }}
                      transition={{ duration: p.duration, repeat: Infinity, ease: 'linear', delay: p.delay }}
                    >
                      <span className="vault-particle" />
                    </motion.span>
                  ))}
                </motion.div>

                <motion.span
                  className="vault-pulse"
                  style={{ scale: desktopMotion.pulseScale, opacity: desktopMotion.pulseOpacity }}
                />

                <motion.div
                  className="vault-core"
                  style={{ scale: desktopMotion.coreScale, rotate: desktopMotion.coreRotate, opacity: desktopMotion.coreOpacity }}
                >
                  <Icon name="lock" className="icon" />
                </motion.div>

                <motion.span className="vault-badge" style={{ opacity: desktopMotion.badgeOpacity, y: desktopMotion.badgeY }}>
                  Sealed · AES-256-GCM
                </motion.span>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
