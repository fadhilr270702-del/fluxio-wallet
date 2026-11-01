/**
 * Anchor-link navigation for the landing page's sections. The landing page
 * used to hijack scroll into horizontal slide movement (see CLAUDE.md's
 * vertical-scroll conversion slice for why that was removed) — this used
 * to compute an equivalent vertical scroll position for that track. Now
 * every section is a normal block-level element, so a plain
 * `scrollIntoView` is always correct; no track/breakpoint math needed.
 *
 * Routes through Lenis (see hooks/useLenis.js) when it's running, rather
 * than the native `scrollIntoView({behavior:'smooth'})` — both animate
 * scroll position on every frame, so running them together fights and
 * stutters. When Lenis isn't active (prefers-reduced-motion, or the hook
 * hasn't mounted yet), this falls back to an instant jump — no smooth CSS
 * left on `html` for it to borrow, which is also the more correct
 * reduced-motion behavior rather than an approximation of it.
 */
// Networks.jsx's own scroll-driven "reached the last chain, hold here
// until you reveal" gate (prompts 0065-0071) reads live scroll position
// through its own useScroll/useMotionValueEvent, with zero awareness of
// *why* scrollY changed. An animated multi-frame scroll-through — exactly
// what this file's own Lenis path produces — passes through every
// intermediate progress value on the way to a target below Networks
// (Vault/Extension/Get started), including crossing its LOCK_AT
// threshold; Networks then "locks" and forcibly snaps scroll back to its
// own boundary, stranding the user there instead of at the section they
// actually clicked. Even a single non-animated jump doesn't dodge this —
// the gate's "locked" state is a pure function of the CURRENT scroll
// position relative to the pin, not of how it got there, so landing
// anywhere past Networks reads as "locked" regardless.
// `window.__fluxioSectionJumpInProgress` is the fix: a global, Lenis-style
// escape-hatch flag (same idea as `window.__lenis`) that Networks.jsx's
// own gate checks alongside its existing `revealedRef`/`correctingRef`
// guards — set for the duration of any programmatic cross-section jump
// from this file, so a jump that happens to pass through/land past
// Networks is recognized as "not real user scroll" the same way
// Networks's own internal corrections already are. Cleared on Lenis's
// `onComplete`, with a defensive fallback timeout (same pattern as
// Networks.jsx's own correctingRef fallback) in case that never fires.
function withSectionGateBypass(run) {
  if (typeof window === 'undefined') return run(() => {});
  window.__fluxioSectionJumpInProgress = true;
  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    window.__fluxioSectionJumpInProgress = false;
  };
  setTimeout(clear, 1400); // Lenis's default scrollTo duration is 1.1s (see useLenis.js) — margin for slower frames.
  run(clear);
}

export function scrollToSlideId(id) {
  const target = document.getElementById(id);
  if (!target) return false;
  if (typeof window !== 'undefined' && window.__lenis) {
    // Lenis caches the page's scrollable height at construction time and
    // only re-measures on a native `window resize` event (see its own
    // resize() — "Force lenis to recalculate the dimensions"). A
    // client-side route swap (e.g. /privacy, a short page, to Landing, a
    // much taller one) never fires that event, so without this call
    // Lenis's cached limit is still the OLD page's height: scrollTo(target)
    // then animates toward a target it silently clamps to that stale,
    // too-short limit, landing well short of the real section — found by
    // instrumenting the actual animated scrollY over time and comparing
    // against the target's real offset, not assumed from reading the
    // library's docs alone. Cheap and safe to call unconditionally here,
    // including for same-page clicks where nothing was actually stale.
    window.__lenis.resize();
    withSectionGateBypass((clear) => {
      window.__lenis.scrollTo(target, { onComplete: clear });
    });
  } else {
    withSectionGateBypass((clear) => {
      target.scrollIntoView({ block: 'start' });
      clear();
    });
  }
  return true;
}

/**
 * Cross-page-safe version of the click handler above (prompt 0123
 * Revision 1). These same "#networks"/"#vault"/etc. links are shared by
 * MarketingNav's MENU overlay and MarketingFooter, both of which also
 * render on /privacy — but the section elements these ids target only
 * exist on the landing page ("/"). Previously this handler only ever
 * called `event.preventDefault()` when `scrollToSlideId` actually found
 * the target; on any other page that meant the click fell through to the
 * plain `href="#id"` default, which just rewrites the current page's own
 * URL hash (e.g. "/privacy#networks") with no visible effect — the exact
 * dead-link bug reported.
 *
 * Now: always prevent the default hash-only jump, then try the local
 * scroll first (unchanged, instant, same-page); if that target doesn't
 * exist on the current page, fall through to a real client-side
 * navigation to "/#id" via the passed-in react-router `navigate` — Landing
 * itself picks the hash back up on mount (see its own `useEffect` for
 * this) once the section has actually rendered. `navigate` is optional
 * only so this function stays easy to call from anywhere that already
 * knows it doesn't need the cross-page fallback (none currently do, but
 * failing safe to a plain location change rather than a hard requirement
 * costs nothing).
 */
export function handleSlideAnchorClick(event, id, navigate) {
  event.preventDefault();
  if (scrollToSlideId(id)) return;
  if (navigate) navigate(`/#${id}`);
  else if (typeof window !== 'undefined') window.location.assign(`/#${id}`);
}
