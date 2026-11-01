/**
 * True if `element` appears anywhere in `event`'s real composed path — the
 * shadow-DOM-safe way to ask "did this event originate from inside this
 * element". Needed because `event.target` gets RETARGETED to a shadow
 * host once an event crosses a shadow boundary (confirmed live: a wheel
 * event dispatched deep inside emoji-mart's own Web-Component-based
 * Picker, `<em-emoji-picker>`, reports `e.target` as that host element by
 * the time a `window`-level listener sees it — `e.composedPath()` is what
 * still exposes the real path through the shadow tree). The only caller
 * is `EmojiPickerButton.jsx`'s own scroll-gesture guard (prompt 0148).
 * Moved alongside `EmojiPickerButton.jsx` to this shared location in
 * prompt 0159 — it has no other caller anywhere in the codebase, so
 * nothing else needed a re-export shim at its old path.
 *
 * Pure given an event-like object exposing `composedPath()` — no real DOM
 * node or browser environment is needed to unit-test it, since
 * `composedPath()` just returns an array and `element` never needs to be
 * an actual DOM element either, only something `Array.includes` can
 * compare by reference.
 */
export function isEventInsideElement(event, element) {
  if (!element || !event || typeof event.composedPath !== 'function') return false;
  return event.composedPath().includes(element);
}
