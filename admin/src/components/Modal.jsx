import React, { useEffect, useRef, useState } from 'react';

/**
 * Minimal reusable overlay+card dialog — no animation, no portal library,
 * just a fixed-position backdrop. The rest of this app's confirmations use
 * window.confirm(); this exists because a real form (e.g. the reschedule
 * picker) needs actual fields, which window.confirm()/prompt() can't render.
 *
 * `className` (prompt 0132 Revision 1) is optional and additive — every
 * existing call site omits it and keeps the default `.modal-card` sizing
 * (max-width 420px, see admin.css). Added for the new "View broadcast"
 * modal, which mirrors the full Compose form's layout and needs more room
 * than a confirmation dialog; kept as a plain className hook rather than a
 * `:has()` CSS selector (no precedent for `:has()` anywhere else in this
 * codebase) so widening one modal never risks affecting another.
 *
 * `footer` (prompt 0132 Revision 3) is optional and additive too — every
 * existing call site (this dialog's own overwrite-confirm usage,
 * RescheduleDialog) omits it and is completely unaffected, since their
 * short action rows just stay part of `children` exactly as before.
 *
 * Overflow fix (prompt 0132 Revision 3): the View broadcast modal's real
 * content (a full frozen form + a real image/video preview) could grow
 * taller than the viewport, clipping its own header/footer with no way to
 * scroll to them. Fixed here, universally, rather than only for that one
 * modal, since any future modal with enough content would hit the same
 * problem: `.modal-card` is now a capped-height (`max-height:calc(100vh -
 * 48px)`) flex column with three regions — header, a `.modal-card__body`
 * wrapper around `children` (the only thing that scrolls, `overflow-y:auto`
 * + `flex:1 1 auto` + `min-height:0` — that last one is what actually lets
 * a flex child shrink below its content's natural height instead of
 * forcing the whole card to grow past its own max-height), and an optional
 * `.modal-card__footer` for `footer`. Header and footer both use `flex:0 0
 * auto` (never shrink, always visible) — this achieves "sticky header/
 * footer" through plain flex layout rather than `position:sticky`,
 * deliberately: sticky has its own well-known edge cases (needs the right
 * overflow ancestor, can fight z-index/background bleed with content
 * scrolling underneath) that a simple 3-region flex column sidesteps
 * entirely, and it's no more code either way. This is also the smallest
 * change for existing call sites: they never restructure their own JSX at
 * all — Modal.jsx wraps `children` in the new body div internally, so
 * RescheduleDialog and the inline overwrite-confirm dialog (ComposePage.jsx)
 * need zero changes and render pixel-identical to before (their content is
 * always short enough that `.modal-card__body` never actually needs to
 * scroll — verified via screenshot, not just reasoned about, see the
 * archive). Only `ViewBroadcastModal.jsx` opts into the new `footer` prop,
 * since it's the one call site whose actions (Close/Salin ke
 * form/"Buka halaman detail") should stay reachable regardless of how much
 * the frozen form above them scrolls — see that component's own comment
 * for the UX reasoning.
 *
 * Scrollbar hidden + "more below" fade indicator (prompt 0132 Revision 4):
 * the scrollbar itself is suppressed cross-browser in admin.css
 * (`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`, scoped to
 * `.modal-card__body` only — scroll itself, via wheel/trackpad/touch/
 * keyboard, is completely unaffected). In its place, a small `showFade`
 * bit of state here drives a `.modal-card__fade` overlay div.
 *
 * A pure-CSS "scroll shadow" (two background layers on the scrolling
 * element itself, one `attachment:local` + one `attachment:scroll`, the
 * classic trick) was tried FIRST and rejected after a real screenshot
 * caught it not actually working: this modal's own children (the message
 * box, image/video previews, buttons) each paint their OWN opaque/
 * near-opaque background, and a CSS background painted on the *scrolling
 * container itself* is always behind its children, not in front of them —
 * so the fade was invisible any time a child happened to occupy the exact
 * pixels at the bottom edge, which in this form-shaped content is most of
 * the time. A background-only approach fundamentally can't paint on top of
 * arbitrary child content; only a real, stacked-on-top element can. Hence
 * the small amount of JS here, exactly as this prompt's own instructions
 * anticipated might be necessary.
 *
 * `showFade` = the body is actually scrollable (`scrollHeight >
 * clientHeight`) AND not already scrolled to its end — recomputed on
 * mount, on every scroll event, and via a `ResizeObserver` on the body
 * itself (content can grow after mount without a scroll ever happening,
 * e.g. ViewBroadcastModal's own image finishing its async load). A short
 * dialog whose content never overflows (the overwrite-confirm dialog,
 * RescheduleDialog) always computes `isScrollable: false`, so `showFade`
 * never turns on for them — no visible change, no separate opt-out needed.
 * The fade div itself lives in a `position:relative` wrapper alongside
 * `.modal-card__body` and is absolutely positioned over it — genuinely on
 * top in paint order, not fighting any child's own background — and is
 * always `pointer-events:none`/`aria-hidden`, purely decorative.
 */
export default function Modal({ title, onClose, children, footer = null, className = '' }) {
  const bodyRef = useRef(null);
  const [showFade, setShowFade] = useState(false);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    // A couple of px of slack — sub-pixel layout rounding can otherwise
    // leave scrollTop+clientHeight a hair short of scrollHeight even when
    // visually fully scrolled, which would keep the fade lit forever.
    const EPSILON = 2;
    function recompute() {
      const isScrollable = el.scrollHeight > el.clientHeight + EPSILON;
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - EPSILON;
      setShowFade(isScrollable && !atEnd);
    }
    recompute();
    el.addEventListener('scroll', recompute, { passive: true });
    const resizeObserver = new ResizeObserver(recompute);
    resizeObserver.observe(el);
    return () => {
      el.removeEventListener('scroll', recompute);
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`card modal-card${className ? ` ${className}` : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-card__head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-card__body-wrap">
          <div className="modal-card__body" ref={bodyRef}>{children}</div>
          <div className={`modal-card__fade${showFade ? ' modal-card__fade--visible' : ''}`} aria-hidden="true" />
        </div>
        {footer && <div className="modal-card__footer">{footer}</div>}
      </div>
    </div>
  );
}
