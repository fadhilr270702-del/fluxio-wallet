import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion, useScroll, useTransform, useMotionValueEvent } from 'framer-motion';
import Icon from './Icon.jsx';
import useIsMobile from '../hooks/useIsMobile.js';
import useHeadingSweep from '../hooks/useHeadingSweep.js';

const DESC =
  'The browser extension treats every webpage as untrusted by default. Requests are validated, scoped, and held for your explicit approval before anything is ever signed. Private key material has no code path to the page it came from.';

// Scroll-scrubbed stage budget, same pin technique as Vault.jsx (tall
// spacer + sticky child + useScroll) but only 3 scroll-driven stages —
// the 4th ("signing") is interactive, not scroll-driven at all, see
// SIGN_STEP below. No scroll-lock (like Vault, unlike Networks) — the pin
// just naturally releases once scrolled through.
const STAGE1_END = 0.28; // request chip travels dApp -> gate, connector line draws in
const STAGE2_END = 0.58; // origin-check: scan sweep + "origin verified" badge; blocked dApp->vault path reveals
const STAGE3_END = 0.72; // approval popup + description settle; real dwell margin to 1.0 before the pin's natural release

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Heading text — shared across this file's 3 render branches, same
// reasoning as Vault.jsx's VaultTitleText. Revision 2 removed the "page."
// accent word entirely (previously its own span with an independent
// teal shimmer) — the whole heading now shares one continuous sweep
// painted on the parent <h2>, so there's nothing left for this helper to
// single out; kept only to avoid repeating the sentence 3 times.
const EXT_TITLE_TEXT = 'Your keys never meet the page.';

// Entrance-reveal props for the mobile/reduced-motion text — same helper
// as Vault.jsx's reveal(), duplicated locally rather than imported from
// Vault.jsx since these are two independent sections, not because the
// logic differs.
function reveal(reduceMotion, delay = 0) {
  if (reduceMotion) return {};
  return {
    initial: { opacity: 0, y: 16 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.4 },
    transition: { duration: 0.5, delay, ease: 'easeOut' }
  };
}

// Shared stage-1/2/3 motion, factored out so the desktop pinned
// choreography and the mobile non-pinned one (same pattern as Vault.jsx's
// useVaultStageMotion, prompt/0075) can share one implementation against
// two different progress sources. Every output here is a plain
// useTransform keyframe list — never a spring — so nothing can overshoot
// past its bounds the way Panel.jsx's blur transition once did (see
// prompt/0077); tween/keyframe interpolation is inherently clamped to the
// keyframes given.
function useExtensionStageMotion(progress) {
  // Stage 1 — request chip travel + connector draw-in.
  const chipLeft = useTransform(progress, [0, STAGE1_END], ['0%', '100%']);
  const chipOpacity = useTransform(progress, [0, 0.03, STAGE1_END - 0.03, STAGE1_END], [0, 1, 1, 0]);
  const requestDraw = useTransform(progress, [0, STAGE1_END], [0, 1]);
  const trustDraw = useTransform(progress, [0, 0.1], [0, 1]); // gate<->vault channel: always-there, just fades in

  // Stage 2 — origin-check scan sweep, verified badge, blocked-path reveal.
  const scanOpacity = useTransform(
    progress,
    [STAGE1_END, STAGE1_END + 0.04, STAGE2_END - 0.1, STAGE2_END - 0.04],
    [0, 1, 1, 0]
  );
  const scanLeft = useTransform(progress, [STAGE1_END, STAGE2_END - 0.04], ['20%', '80%']);
  const verifiedOpacity = useTransform(progress, [STAGE2_END - 0.06, STAGE2_END], [0, 1]);
  const verifiedScale = useTransform(progress, [STAGE2_END - 0.06, STAGE2_END], [0.85, 1]);
  const blockedOpacity = useTransform(progress, [STAGE1_END + 0.08, STAGE2_END], [0, 1]);

  // Stage 3 — approval popup + description settle.
  const popupOpacity = useTransform(progress, [STAGE2_END, STAGE3_END], [0, 1]);
  const popupY = useTransform(progress, [STAGE2_END, STAGE3_END], [16, 0]);
  const descOpacity = useTransform(progress, [STAGE2_END + 0.05, STAGE3_END], [0, 1]);
  const descY = useTransform(progress, [STAGE2_END + 0.05, STAGE3_END], [12, 0]);

  return {
    chipLeft,
    chipOpacity,
    requestDraw,
    trustDraw,
    scanOpacity,
    scanLeft,
    verifiedOpacity,
    verifiedScale,
    blockedOpacity,
    popupOpacity,
    popupY,
    descOpacity,
    descY
  };
}

// The 4th stage — clicking Approve — is deliberately NOT scroll-driven
// (see the prompt's own "INTERAKTIF (bukan digerakkan scroll)"). A tiny
// local state machine instead of scroll progress: IDLE -> FORMING (the
// signature indicator appears at the gate) -> FLOWING (it travels back
// along the same dApp<->gate connector, reversed) -> DONE (arrived,
// "signed with your consent" badge + a safe flash on the vault zone that
// stays in place) -> back to IDLE. Shared by all three render modes
// (desktop/mobile/reduced-motion) — the button and its result are
// available regardless of scroll/pin state, since a rendered <button> is
// always clickable independent of any of that.
const SIGN_STEP = { IDLE: 0, FORMING: 1, FLOWING: 2, DONE: 3 };
const SIGN_TIMING = { toFlowing: 500, toDone: 1300, reset: 2200 };
const SIGN_TIMING_REDUCED = { toFlowing: 0, toDone: 0, reset: 900 }; // no travel — see useSigning below

function useSigning(reduceMotion) {
  const [step, setStep] = useState(SIGN_STEP.IDLE);
  const timeouts = useRef([]);

  useEffect(
    () => () => {
      timeouts.current.forEach(clearTimeout);
    },
    []
  );

  function approve() {
    if (step !== SIGN_STEP.IDLE) return; // ignore clicks mid-sequence
    const t = reduceMotion ? SIGN_TIMING_REDUCED : SIGN_TIMING;
    if (reduceMotion) {
      // "hasil tampil tanpa animasi bergerak (langsung tampilkan keadaan
      // signed sebentar)" — jump straight to the settled DONE state, no
      // FORMING/FLOWING travel in between, then reset after a short flash.
      setStep(SIGN_STEP.DONE);
      timeouts.current.push(setTimeout(() => setStep(SIGN_STEP.IDLE), t.reset));
      return;
    }
    setStep(SIGN_STEP.FORMING);
    timeouts.current.push(
      setTimeout(() => setStep(SIGN_STEP.FLOWING), t.toFlowing),
      setTimeout(() => setStep(SIGN_STEP.DONE), t.toDone),
      setTimeout(() => setStep(SIGN_STEP.IDLE), t.reset)
    );
  }

  return { step, approve, signing: step !== SIGN_STEP.IDLE };
}

function DappZone() {
  return (
    <div className="ext-zone ext-zone--dapp">
      <div className="ext-browser-mini">
        <span className="ext-browser-mini__dot" />
        <span className="ext-browser-mini__dot" />
        <span className="ext-browser-mini__dot" />
        <span className="ext-browser-mini__url">dapp.example.eth</span>
      </div>
    </div>
  );
}

// The approval popup now anchors directly to the gate zone (position:
// relative on .ext-zone--gate, popup at bottom:100%+gap) instead of the
// whole stage's top edge (prompt/0082 — the popup used to float far above
// the diagram with a large dead gap under it; anchoring it to the gate's
// own box keeps it snug against the element it's actually approving a
// request for, and scales correctly with the diagram itself rather than
// the stage's arbitrary aspect-ratio box).
function GateZone({ verified, verifiedOpacity, verifiedScale, popupOpacity, popupY, signing, onApprove }) {
  return (
    <div className="ext-zone ext-zone--gate">
      <ApprovePopup opacity={popupOpacity} y={popupY} signing={signing} onApprove={onApprove} />
      <motion.div className="ext-node ext-node--gate" animate={verified ? { boxShadow: '0 0 0 6px rgba(219,176,87,0.14)' } : { boxShadow: '0 0 0 0 rgba(219,176,87,0)' }}>
        <Icon name="shield" className="icon" />
      </motion.div>
      <motion.span className="ext-verified-badge" style={{ opacity: verifiedOpacity, scale: verifiedScale }}>
        origin verified <span className="ext-verified-badge__check">✓</span>
      </motion.span>
    </div>
  );
}

// Same anchoring idea for the post-signing confirmation — it appears
// right above the vault zone (the thing that's actually being kept safe)
// instead of floating at a stage-wide coordinate.
function VaultZone({ flash, signedShow }) {
  return (
    <div className="ext-zone ext-zone--vault">
      <SignedBadge show={signedShow} />
      <div className="ext-node ext-node--vault">
        <Icon name="lock" className="icon" />
        <motion.span
          className="ext-vault-flash"
          animate={flash ? { opacity: [0, 0.7, 0], scale: [1, 1.22, 1] } : { opacity: 0, scale: 1 }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
        />
      </div>
    </div>
  );
}

// The one connector that ever carries a traveling element (the request
// chip forward, the signature indicator back) — dApp <-> gate.
function RequestConnector({ chipLeft, chipOpacity, requestDraw, signStep }) {
  const indicatorLeft = signStep === SIGN_STEP.FLOWING ? '0%' : '100%';
  const indicatorVisible = signStep === SIGN_STEP.FORMING || signStep === SIGN_STEP.FLOWING;

  return (
    <div className="ext-connector">
      <svg className="ext-connector__svg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
        <motion.line x1="2" y1="5" x2="98" y2="5" className="ext-connector__line" style={{ pathLength: requestDraw }} />
      </svg>
      <motion.span className="ext-chip" style={{ left: chipLeft, opacity: chipOpacity }}>
        signMessage
      </motion.span>
      <motion.span
        className="ext-chip ext-chip--signed"
        initial={false}
        animate={{ left: indicatorLeft, opacity: indicatorVisible ? 1 : 0 }}
        transition={{ type: 'tween', duration: signStep === SIGN_STEP.FLOWING ? 0.8 : 0.35, ease: 'easeInOut' }}
      >
        <span className="ext-chip__check">✓</span> 0x4f…9a2
      </motion.span>
    </div>
  );
}

// gate <-> vault: always-trusted internal channel, never carries a
// traveling element (the vault never moves toward the page — see
// VaultZone's in-place flash instead) — just fades in once, no draw.
function TrustConnector({ trustDraw }) {
  return (
    <div className="ext-connector ext-connector--trust">
      <svg className="ext-connector__svg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
        <motion.line x1="2" y1="5" x2="98" y2="5" className="ext-connector__line ext-connector__line--trust" style={{ opacity: trustDraw }} />
      </svg>
    </div>
  );
}

// The blocked dApp -> vault shortcut: a dim, dashed curve tucked close
// under the main row, a "x" mark, and a short label — kept entirely
// inside .ext-stage's own box (unlike Vault's circular labels, which
// reached outside their stage and caused the desktop navbar-clipping bug
// fixed across prompt/0075-0079 — deliberately not repeating that here).
// No pathLength/draw-in here (prompt/0082 fix) — Framer's pathLength
// technique works by writing its own stroke-dasharray/stroke-dashoffset
// directly onto the element, which silently overrides any static
// stroke-dasharray set in CSS. Combined with .ext-blocked__path once
// having no real color/weight distinction from the active gold path, that
// made this render as a solid, bright, undashed line — the single most
// prominent thing on the stage, exactly backwards from "this route is
// blocked and secondary". Opacity alone now drives the reveal; the dashed
// look comes from a plain CSS stroke-dasharray that's free to stay in
// effect since nothing else touches this element's dasharray anymore.
function BlockedPath({ opacity }) {
  return (
    <motion.div className="ext-blocked" style={{ opacity }}>
      <svg className="ext-blocked__svg" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
        <path d="M6,3 Q50,32 94,3" className="ext-blocked__path" />
      </svg>
      <span className="ext-blocked__mark">✕</span>
      <span className="ext-blocked__label">no code path</span>
    </motion.div>
  );
}

function ApprovePopup({ opacity, y, signing, onApprove }) {
  return (
    <motion.div className="ext-popup" style={{ opacity, y }}>
      <div className="ext-popup__bar">
        <span className="ext-popup__dot" />
        <span className="ext-popup__title">Fluxio</span>
      </div>
      <div className="ext-popup__body">
        <p className="ext-popup__question">Approve this signature?</p>
        <motion.button
          type="button"
          className="ext-approve-btn"
          onClick={onApprove}
          disabled={signing}
          animate={signing ? {} : { boxShadow: ['0 0 0 0 rgba(219,176,87,0.35)', '0 0 0 12px rgba(219,176,87,0)', '0 0 0 0 rgba(219,176,87,0)'] }}
          transition={{ duration: 2.2, repeat: signing ? 0 : Infinity, ease: 'easeOut' }}
          whileTap={{ scale: 0.96 }}
        >
          Approve
        </motion.button>
      </div>
    </motion.div>
  );
}

function SignedBadge({ show }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.span
          className="ext-signed-badge"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
        >
          Signed with your consent
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/**
 * ExtensionFlow — "Your keys never meet the page.", rebuilt as a pinned,
 * scroll-scrubbed 3-stage choreography of a single signing request's
 * journey (see Vault.jsx for the shared pin technique), plus a genuinely
 * interactive 4th stage that plays on click, independent of scroll.
 *
 * Stage 1 [0, 0.28] — a "signMessage" request chip leaves the dApp mock
 * and travels along a connector line toward the extension gate, the line
 * drawing itself in step (RequestConnector's `pathLength`, same technique
 * as Vault's TechLabel connector lines). The gate<->vault trust channel
 * fades in alongside it (TrustConnector) — it's not "happening now", it
 * was always there, just revealed.
 * Stage 2 [0.28, 0.58] — the chip has arrived and faded out (already
 * absorbed); a scan sweep animates across the gate, then an "origin
 * verified ✓" badge locks in. At the same time, a dashed blocked path
 * dips below the row from dApp straight to the vault zone, with a "✕" and
 * "no code path" label — the direct route that never exists.
 * Stage 3 [0.58, 0.72] — the approval popup ("Approve this signature?")
 * fades/rises in, the left column's description settles. The pin still
 * has real dwell room after this (up to 1.0) before its natural release —
 * no scroll-lock, unlike Networks; approval is entirely optional to the
 * scroll experience.
 * Stage 4 (interactive, not scroll-bound) — useSigning()'s small state
 * machine: clicking Approve forms a signature indicator at the gate,
 * flies it back along the SAME dApp<->gate connector (reversed), flashes
 * the vault zone safely in place (it never moves toward the page), shows
 * a "Signed with your consent" badge, then resets to stage 3's own idle
 * state so it can be clicked again. Every animated value here is a plain
 * keyframe/tween, never a spring, so nothing can overshoot past a
 * property's valid bounds (the lesson from Panel.jsx's negative-blur bug,
 * prompt/0077).
 *
 * Reduced motion: no pin, no travel animation anywhere — a fully static
 * stage-3 end-state (all zones, blocked path, popup, description) is
 * shown directly. The Approve button stays real and interactive; clicking
 * it jumps straight to the DONE state (no FORMING/FLOWING) for a brief
 * flash before resetting — still a genuine result, just without motion.
 *
 * Mobile (isMobile && !reduceMotion): same lesson as Vault's own mobile
 * fix (prompt/0075) — dropping the pin must not mean dropping the story.
 * A second, independent useScroll target (stageRef, non-pinned,
 * viewport-fraction offset) drives the exact same 3-stage progression
 * through the same useExtensionStageMotion() hook, just in a vertically
 * stacked layout and with the blocked path simplified to a short dashed
 * side-annotation instead of the full curve (curving "below" a row that's
 * now a vertical column doesn't translate directly — this is the one
 * deliberate mobile simplification, same spirit as Vault dropping
 * particles on mobile). The Approve button and its full signing sequence
 * work identically to desktop.
 */
export default function ExtensionFlow() {
  const pinRef = useRef(null);
  const stageRef = useRef(null);
  const reduceMotion = useReducedMotion();
  const isMobile = useIsMobile();
  const simple = reduceMotion || isMobile;
  // Continuous color sweep (prompt 0127 Revision 1) — 700ms covers the
  // mobile branch's own title entrance (duration 0.65s + its own 0.05s
  // delay); shared with the desktop-pin branch, same reasoning as
  // Vault.jsx's own single shared sweep hook.
  const sweep = useHeadingSweep({ entranceMs: 700, reduceMotion });

  const { scrollYProgress: progress } = useScroll({
    target: pinRef,
    offset: ['start start', 'end start']
  });
  const { scrollYProgress: mobileProgress } = useScroll({
    target: stageRef,
    offset: ['start 1', 'end 0']
  });

  const [verified, setVerified] = useState(false);
  const [mobileVerified, setMobileVerified] = useState(false);
  useMotionValueEvent(progress, 'change', (v) => setVerified(v >= STAGE2_END));
  useMotionValueEvent(mobileProgress, 'change', (v) => setMobileVerified(v >= STAGE2_END));

  const desktopMotion = useExtensionStageMotion(progress);
  const mobileMotion = useExtensionStageMotion(mobileProgress);

  const headlineOpacity = useTransform(progress, [0, 0.05], [0, 1]);
  // Same x-slide as the mobile branch above, driven by the pin's own
  // scroll-scrubbed progress over the same [0, 0.05] slice headlineOpacity
  // already uses.
  const titleX = useTransform(progress, [0, 0.05], [-32, 0]);

  const desktopSign = useSigning(false);
  const mobileSign = useSigning(false);
  const staticSign = useSigning(true);

  return (
    <div ref={pinRef} className={`ext-pin ${simple ? 'ext-pin--static' : ''}`} id="extension">
      <section className="ext-inner">
        {reduceMotion ? (
          <div className="ext-split">
            <div className="ext-split__left">
              <span className="eyebrow">Manifest V3 · Origin checked</span>
              <h2 className="ext-split__title">{EXT_TITLE_TEXT}</h2>
              <p className="ext-split__desc">{DESC}</p>
            </div>
            <div className="ext-split__right">
              <div className="ext-stage">
                <div className="ext-row">
                  <DappZone />
                  <RequestConnector chipLeft="0%" chipOpacity={0} requestDraw={1} signStep={staticSign.step} />
                  <GateZone
                    verified
                    verifiedOpacity={1}
                    verifiedScale={1}
                    popupOpacity={1}
                    popupY={0}
                    signing={staticSign.signing}
                    onApprove={staticSign.approve}
                  />
                  <TrustConnector trustDraw={1} />
                  <VaultZone flash={staticSign.step === SIGN_STEP.DONE} signedShow={staticSign.step === SIGN_STEP.DONE} />
                </div>
                <BlockedPath opacity={1} />
              </div>
            </div>
          </div>
        ) : isMobile ? (
          <div className="ext-split">
            <div className="ext-split__left">
              <motion.span className="eyebrow" {...reveal(false, 0)}>
                Manifest V3 · Origin checked
              </motion.span>
              {/* Distinct entrance from Vault's rotateX tilt and every
                  other section here (prompt 0127) — a horizontal slide in
                  from the left, echoing this section's own boundary/edge
                  theme ("never meet the page") rather than Vault's
                  vertical-door metaphor. Tween only, per the 0077 lesson
                  noted throughout this file already. */}
              <motion.h2
                className="ext-split__title"
                ref={sweep.ref}
                initial={{ opacity: 0, x: -32 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, amount: 0.5 }}
                transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
                style={{ animationPlayState: sweep.sweeping ? 'running' : 'paused' }}
              >
                {EXT_TITLE_TEXT}
              </motion.h2>
              <motion.p className="ext-split__desc" {...reveal(false, 0.1)}>
                {DESC}
              </motion.p>
            </div>
            <div className="ext-split__right">
              <div ref={stageRef} className="ext-stage ext-stage--mobile">
                <div className="ext-col">
                  <DappZone />
                  <RequestConnector
                    chipLeft={mobileMotion.chipLeft}
                    chipOpacity={mobileMotion.chipOpacity}
                    requestDraw={mobileMotion.requestDraw}
                    signStep={mobileSign.step}
                  />
                  <motion.span className="ext-scan ext-scan--mobile" style={{ opacity: mobileMotion.scanOpacity, top: mobileMotion.scanLeft }} />
                  <GateZone
                    verified={mobileVerified}
                    verifiedOpacity={mobileMotion.verifiedOpacity}
                    verifiedScale={mobileMotion.verifiedScale}
                    popupOpacity={mobileMotion.popupOpacity}
                    popupY={mobileMotion.popupY}
                    signing={mobileSign.signing}
                    onApprove={mobileSign.approve}
                  />
                  <TrustConnector trustDraw={mobileMotion.trustDraw} />
                  <VaultZone flash={mobileSign.step === SIGN_STEP.DONE} signedShow={mobileSign.step === SIGN_STEP.DONE} />
                </div>
                {/* Mobile simplification (see this file's own JSDoc): a short
                    dashed side-note instead of the full curving blocked
                    path, which assumed a horizontal row. */}
                <motion.div className="ext-blocked ext-blocked--mobile" style={{ opacity: mobileMotion.blockedOpacity }}>
                  <span className="ext-blocked__mark">✕</span>
                  <span className="ext-blocked__label">no code path to webpage</span>
                </motion.div>
              </div>
            </div>
          </div>
        ) : (
          <div className="ext-split">
            <div className="ext-split__left">
              <motion.span className="eyebrow" style={{ opacity: headlineOpacity }}>
                Manifest V3 · Origin checked
              </motion.span>
              <motion.h2
                className="ext-split__title"
                ref={sweep.ref}
                style={{
                  opacity: headlineOpacity,
                  x: titleX,
                  animationPlayState: sweep.sweeping ? 'running' : 'paused'
                }}
              >
                {EXT_TITLE_TEXT}
              </motion.h2>
              <motion.p className="ext-split__desc" style={{ opacity: desktopMotion.descOpacity, y: desktopMotion.descY }}>
                {DESC}
              </motion.p>
            </div>
            <div className="ext-split__right">
              <div className="ext-stage">
                <div className="ext-row">
                  <DappZone />
                  <RequestConnector
                    chipLeft={desktopMotion.chipLeft}
                    chipOpacity={desktopMotion.chipOpacity}
                    requestDraw={desktopMotion.requestDraw}
                    signStep={desktopSign.step}
                  />
                  <GateZone
                    verified={verified}
                    verifiedOpacity={desktopMotion.verifiedOpacity}
                    verifiedScale={desktopMotion.verifiedScale}
                    popupOpacity={desktopMotion.popupOpacity}
                    popupY={desktopMotion.popupY}
                    signing={desktopSign.signing}
                    onApprove={desktopSign.approve}
                  />
                  <TrustConnector trustDraw={desktopMotion.trustDraw} />
                  <VaultZone flash={desktopSign.step === SIGN_STEP.DONE} signedShow={desktopSign.step === SIGN_STEP.DONE} />
                </div>
                <BlockedPath opacity={desktopMotion.blockedOpacity} />
                {/* Also gated by scanOpacity via CSS-driven opacity below the
                    row — the scan sweep only needs to read during stage 2,
                    it doesn't need its own JSX branch. */}
                <motion.span className="ext-scan" style={{ opacity: desktopMotion.scanOpacity, left: desktopMotion.scanLeft }} />
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
