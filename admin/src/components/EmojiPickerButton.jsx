import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';
import { isEventInsideElement } from './eventPath.js';
import PremiumEmojiPickerTab from '../features/broadcast/telegram/PremiumEmojiPickerTab.jsx';

/**
 * emoji-mart's Picker component AND its `@emoji-mart/data` module (the full
 * emoji dataset — genuinely large) are dynamically imported here, together,
 * only the first time a popover is actually opened — never part of the
 * initial admin bundle. `React.lazy()` alone only code-splits the component
 * import; the `data` import has to be deferred inside this same lazy-loaded
 * factory too, or the dataset would still end up pulled into whatever chunk
 * imports THIS file eagerly (every page that renders an EmojiPickerButton).
 * See prompt 0147's own archive for the before/after `pnpm build:admin`
 * comparison proving this actually stays out of the main chunk.
 */
const LazyPicker = lazy(() =>
  Promise.all([import('@emoji-mart/react'), import('@emoji-mart/data')]).then(
    ([{ default: Picker }, { default: data }]) =>
      ({ default: (props) => <Picker data={data} {...props} /> })
  )
);

// Module-scoped, not component state — this page can render many
// EmojiPickerButton instances at once (the toolbar, Title, one per button
// row), each managing its own `open` state independently. The "click
// outside closes it" handler below only catches a REAL mousedown on a
// different trigger; a keyboard user Tab-ing from one trigger straight to
// another (no intervening mousedown anywhere) would otherwise end up with
// two popovers open at once. This tracks whichever instance is currently
// open and closes it before a new one opens, regardless of how the switch
// happened.
//
// Keyed by each instance's own `setOpen` — NOT a freshly-defined closer
// function — deliberately: a plain function declared inside the component
// body (openPicker/closeThis) is a NEW object on every render, so
// comparing `storedCloser === closeThis` almost never holds true once any
// state update has happened (a real bug caught live: the second picker's
// own openPicker() call went through the "close the other one" branch,
// invoked a stale closure from an earlier render, and the newly-clicked
// instance's OWN setOpen(true) never actually ran). `setOpen` itself is
// exactly what React guarantees stays referentially stable across every
// render of the same component instance, so using it as the identity is
// the actual fix, not a workaround.
let openPickerSetter = null;

/**
 * A small emoji-icon button that opens an in-panel emoji-mart popover —
 * never the OS/browser-native picker (prompt 0147's own explicit goal).
 * Originally lived in `features/broadcast/telegram/`, its only integration
 * points at the time: RichTextEditor's toolbar (next to Link), ComposePage's
 * Title field, and every button-row's "Button text" input in both
 * ComposePage and WelcomePage. Prompt 0159 moved it (and `cursorInsert.js`,
 * `eventPath.js`) here once genuinely cross-feature callers existed
 * (Announcements' Title/Body, Versions' per-platform Update message,
 * neither anywhere near Telegram/Broadcast) — `admin/src/components/` is
 * this codebase's already-established home for cross-feature shared UI
 * (`Modal.jsx`, `Icon.jsx`, `Badge.jsx`, ...), so this was a move to the
 * existing pattern, not a new one.
 * `features/broadcast/telegram/EmojiPickerButton.jsx` still exists as a
 * plain re-export of this file — every existing Broadcast import
 * (`ComposePage.jsx`, `WelcomePage.jsx`, `RichTextEditor.jsx`,
 * `ButtonPremiumIconControl.jsx`) needed zero changes, and Broadcast's own
 * behavior is unchanged either way.
 *
 * This component has no opinion on WHERE the picked emoji actually goes —
 * `onSelect(nativeEmojiString)` is the only way it reports a pick; each
 * caller decides how to insert it (RichTextEditor uses TipTap's own
 * `insertContent`; every plain `<input>`/`<textarea>` caller — Broadcast's
 * button-text fields, and now Announcements/Versions — uses
 * `cursorInsert.js`'s `insertAtCursor()`).
 *
 * The popover renders through a React portal straight to `document.body`,
 * not as a normal DOM child of the trigger button — deliberately, to avoid
 * two real clipping/positioning hazards already known in this codebase
 * (see design.css's own `@supports(backdrop-filter)` glass-panel block and
 * prompt 0142's dialog-centering incident): a `.card`'s `backdrop-filter`
 * creates a new containing block for `position:fixed` descendants, and
 * `.rich-text-editor`'s own `overflow:hidden` (for its rounded border)
 * would clip a plain absolutely-positioned popover outright. A portal
 * sidesteps both by construction rather than by hoping neither ancestor
 * ever applies to a given call site.
 *
 * `className` lets each call site match its own surrounding button
 * language (`rich-text-editor__btn` in the toolbar, `icon-btn` next to a
 * plain field) without this component hardcoding either.
 *
 * Prompt 0153 — two new, independent modes on top of the above:
 *  - `showPremiumTab` adds a second "Premium" tab alongside the existing
 *    emoji-mart grid (now labeled "Standard") — RichTextEditor's own
 *    toolbar usage (Title and Message) turns this on; a plain-text input's
 *    usage (a button row's own "Button text") deliberately never does,
 *    per the base prompt's own explicit "label tetap teks biasa, tidak ada
 *    tab Premium" instruction — a button's own premium ICON is a
 *    completely separate control (see `premiumOnly` below).
 *  - `premiumOnly` skips the tab strip and the emoji-mart side entirely,
 *    showing ONLY the Premium tab's content — this is the button-icon
 *    picker (ComposePage/WelcomePage's own "premium icon" control per
 *    button row), which picks a custom_emoji_id for `icon_custom_emoji_id`,
 *    never text to insert.
 * Both modes need `onSelectPremium({customEmojiId, fallbackEmoji})`
 * (never `onSelect`, which stays reserved for a native emoji-mart pick).
 * Neither mode takes a `botId` prop (see prompt 0161's own note below) —
 * `PremiumEmojiPickerTab`, the only thing either mode ever mounts that
 * needs one, resolves it itself.
 *
 * Prompt 0159 — no new "standard only" prop was added, on investigation:
 * `showPremiumTab` and `premiumOnly` already both default to `false`, and
 * in that default state the tab strip below never renders at all (it's
 * gated on `showPremiumTab && !premiumOnly`), `activeTab` has no way to
 * ever become `'premium'` (nothing in the UI can set it), and
 * `PremiumEmojiPickerTab` — the only thing that ever fetches this bot's
 * premium-emoji library — is therefore never mounted, so it never fetches
 * anything. Announcements and Versions both simply omit `showPremiumTab`/
 * `premiumOnly` entirely and get exactly this already-existing behavior:
 * Standard-only, zero premium-library network activity. Verified live
 * (Network tab, both pages) rather than assumed from reading the code
 * alone — see this prompt's own archive.
 *
 * Prompt 0161 — this component's own `botId` prop was removed entirely
 * (it was a pure relay — the value was never used here directly, only
 * forwarded to `PremiumEmojiPickerTab`, which now resolves its own via
 * `<DataBotProvider>`/`useResolvedBotId()`). Every existing call site
 * already sits inside the correct provider by the time it renders, so
 * dropping this prop changed nothing about what any of them show.
 */
export default function EmojiPickerButton({
  onSelect,
  ariaLabel = 'Insert emoji',
  className = 'icon-btn',
  showPremiumTab = false,
  premiumOnly = false,
  onSelectPremium = null
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const [activeTab, setActiveTab] = useState(premiumOnly ? 'premium' : 'standard');
  // Read directly off the DOM (useTheme.js's own hook writes `data-theme`
  // onto document.documentElement) rather than calling useTheme() itself —
  // deliberately: this page can render many EmojiPickerButton instances at
  // once, and useTheme() is its own independent useState per call site, so
  // N instances would each hold N independent, non-reactive copies of
  // "the theme at whatever moment THIS instance happened to mount" — none
  // of which would update if the admin toggles theme afterward via the
  // sidebar's own single real ThemeToggle. Reading fresh at the moment the
  // picker actually opens (not subscribing for this component's whole
  // lifetime) is both simpler and correct: a transient popover only needs
  // to match the CURRENT theme when it appears, not stay live-reactive
  // while already open (an admin toggling theme mid-pick is not a
  // real-world scenario worth the extra subscription machinery).
  const [pickerTheme, setPickerTheme] = useState('light');
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);

  // Anchored below-left of the trigger by default; flips upward if there
  // isn't enough room below (a picker is ~380px tall) so it never renders
  // off the bottom of the viewport. Pure given a rect — called twice (see
  // openPicker() and the settle-frame effect below).
  function computePositionFromRect(rect) {
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUpward = spaceBelow < 420 && rect.top > 420;
    return {
      left: Math.min(rect.left, window.innerWidth - 360),
      top: openUpward ? null : rect.bottom + 6,
      bottom: openUpward ? window.innerHeight - rect.top + 6 : null
    };
  }

  function openPicker() {
    // Close whatever other instance is currently open first — see
    // openPickerSetter's own module-level comment above for why this
    // compares against `setOpen` rather than a freshly-defined function.
    if (openPickerSetter && openPickerSetter !== setOpen) openPickerSetter(false);
    openPickerSetter = setOpen;

    setPickerTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    setPosition(computePositionFromRect(triggerRef.current.getBoundingClientRect()));
    setOpen(true);
  }

  // Clears this instance's own claim on the module-level "which one is
  // open" slot — harmless to skip (openPicker() calling a stale closer on
  // an already-closed instance is just a no-op setOpen(false)), but keeps
  // that slot accurate rather than pointing at a closed instance forever.
  function closeThis() {
    setOpen(false);
    if (openPickerSetter === setOpen) openPickerSetter = null;
  }

  useEffect(() => {
    if (!open) return;
    function handleOutside(e) {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target) &&
        triggerRef.current && !triggerRef.current.contains(e.target)
      ) {
        closeThis();
      }
    }
    function handleEscape(e) {
      if (e.key === 'Escape') closeThis();
    }
    // Closes on a genuine user scroll gesture (wheel/touch) rather than
    // re-tracking the trigger's position on every scroll — simpler, and
    // matches how a short "pick one emoji" interaction is normally used
    // (no reason to keep it open while the admin scrolls the page
    // underneath it). Deliberately 'wheel'/'touchmove', NOT the generic
    // 'scroll' event: this app sets `html{scroll-behavior:smooth}`
    // (design.css), so the BROWSER's own native "scroll the newly-focused
    // trigger into view" (clicking a button near the viewport edge focuses
    // it, and an only-partially-visible focus target gets auto-scrolled
    // into view) fires a whole SERIES of 'scroll' events over that smooth
    // animation's duration — a real, reproducible bug caught live: even
    // deferring the listener by one requestAnimationFrame wasn't enough to
    // outlast that animation, and the picker kept closing itself the
    // instant it opened whenever the trigger was near the bottom of the
    // viewport (e.g. the last button row on a shorter window). Listening
    // for the actual user INPUT gesture instead of its resulting 'scroll'
    // effect sidesteps the whole timing question rather than guessing at
    // a delay long enough to outlast an animation of unknown duration.
    // The one remaining recompute-position-after-settle (below) still
    // uses a rAF, since a single frame IS enough for getBoundingClientRect
    // to reflect the post-focus-scroll layout even while that scroll's own
    // smooth animation is still visually in flight.
    const rafId = requestAnimationFrame(() => {
      if (triggerRef.current) setPosition(computePositionFromRect(triggerRef.current.getBoundingClientRect()));
    });
    // Prompt 0148 fix — a real reported bug: this had NO "did this happen
    // inside the popover" check at all, so scrolling the emoji list itself
    // (mouse wheel over the results grid) closed the picker before ever
    // reaching the lower rows of a category. See eventPath.js's own
    // comment for why `isEventInsideElement` (composedPath-based) is used
    // here rather than `popoverRef.current.contains(e.target)` — both were
    // verified live to work for this component's current DOM shape, but
    // composedPath() is the one that stays correct regardless of shadow
    // structure, not just today's.
    function handleUserScrollGesture(e) {
      if (isEventInsideElement(e, popoverRef.current)) return;
      closeThis();
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('wheel', handleUserScrollGesture, { passive: true });
    window.addEventListener('touchmove', handleUserScrollGesture, { passive: true });
    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('wheel', handleUserScrollGesture);
      window.removeEventListener('touchmove', handleUserScrollGesture);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleEmojiSelect(emoji) {
    onSelect(emoji.native);
    // Closes after one pick — the common pattern for this kind of insert-
    // and-continue-typing flow, and nothing in this codebase's existing UI
    // (Link's own single-prompt-then-done interaction, button rows'
    // one-shot Add/Remove) suggested a "stay open for repeated picks" model
    // would fit better instead.
    closeThis();
  }

  // Prompt 0153 — same "close after one pick" behavior as the standard tab.
  function handlePremiumSelect(picked) {
    onSelectPremium(picked);
    closeThis();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        onClick={() => (open ? closeThis() : openPicker())}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        <Icon name="smile" />
      </button>
      {open && position && createPortal(
        <div
          ref={popoverRef}
          className={`card emoji-picker-popover${premiumOnly || activeTab === 'premium' ? ' emoji-picker-popover--premium' : ''}`}
          style={{ left: position.left, top: position.top ?? undefined, bottom: position.bottom ?? undefined }}
        >
          {showPremiumTab && !premiumOnly && (
            <div className="emoji-picker-popover__tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'standard'}
                className={`emoji-picker-popover__tab${activeTab === 'standard' ? ' is-active' : ''}`}
                onClick={() => setActiveTab('standard')}
              >
                Standard
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'premium'}
                className={`emoji-picker-popover__tab${activeTab === 'premium' ? ' is-active' : ''}`}
                onClick={() => setActiveTab('premium')}
              >
                Premium
              </button>
            </div>
          )}
          {activeTab === 'premium' || premiumOnly ? (
            <PremiumEmojiPickerTab onSelect={handlePremiumSelect} />
          ) : (
            <Suspense fallback={<div className="emoji-picker-popover__loading">Loading…</div>}>
              <LazyPicker
                theme={pickerTheme}
                onEmojiSelect={handleEmojiSelect}
                previewPosition="none"
                skinTonePosition="search"
                maxFrequentRows={2}
              />
            </Suspense>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
