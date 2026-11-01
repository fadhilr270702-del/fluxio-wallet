/**
 * Prompt 0157 — pure geometry helpers backing useIsVisible.js's new
 * synchronous on-mount visibility check (see that file's own comment for
 * why). Kept as plain, dependency-free functions so the actual
 * math — not just the DOM wiring around it — has direct test coverage.
 */

/**
 * Parses an IntersectionObserver-style `rootMargin` string into
 * `{top, right, bottom, left}` pixel numbers, mirroring the CSS
 * margin shorthand rules IntersectionObserver itself follows: one value
 * applies to all four sides, two values apply top/bottom then
 * left/right, three values apply top, left/right, then bottom, and four
 * values apply in top/right/bottom/left order. Percentage values are
 * deliberately NOT supported — this codebase's only two current callers
 * (PremiumEmojiStatic, PremiumEmojiAnimated) always pass a fixed `px`
 * value — an unparsable token falls back to `0` for that side rather than
 * throwing, so a future caller passing something this doesn't understand
 * degrades to "no margin" instead of crashing the component tree.
 */
export function parseRootMargin(rootMargin) {
  const parts = String(rootMargin ?? '0px')
    .trim()
    .split(/\s+/)
    .map((part) => parseFloat(part) || 0);
  const [top = 0, right = top, bottom = top, left = right] = parts;
  return { top, right, bottom, left };
}

/**
 * True if `rect` (a plain `{top,right,bottom,left}`-shaped object — a real
 * `DOMRect` satisfies this) falls within the viewport once expanded
 * outward by `rootMargin` on each side — the same "close enough to start
 * loading early" region `IntersectionObserver`'s own `rootMargin` option
 * describes. Used once, synchronously, at mount time (see
 * useIsVisible.js) — the ongoing/authoritative visibility signal after
 * mount is still the real `IntersectionObserver` callback, which already
 * correctly accounts for things this simpler check does not (scroll-
 * container clipping, non-viewport roots, etc.) — this only ever needs to
 * be "good enough for the common case", not exact.
 */
export function isRectNearViewport(rect, viewportWidth, viewportHeight, rootMargin) {
  const { top, right, bottom, left } = parseRootMargin(rootMargin);
  return (
    rect.bottom >= -top &&
    rect.top <= viewportHeight + bottom &&
    rect.right >= -left &&
    rect.left <= viewportWidth + right
  );
}
