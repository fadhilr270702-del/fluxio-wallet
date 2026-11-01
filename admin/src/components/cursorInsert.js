/**
 * Inserts text at (or in place of) the current selection of a plain
 * `<input>`/`<textarea>` value — the shared logic every plain-text emoji-
 * insertion call site needs (EmojiPickerButton's own plain-input
 * integration points: Title and every button-row's "Button text" in
 * Compose/Welcome, prompt 0147; Announcements' Title/Body and Versions'
 * per-platform Update message, prompt 0159). Originally written once here
 * instead of inline three times; prompt 0159 moved this file (and
 * `EmojiPickerButton.jsx`) from `features/broadcast/telegram/` to this
 * shared location once genuinely cross-feature callers existed — see
 * `EmojiPickerButton.jsx`'s own header comment for the full move
 * rationale. `features/broadcast/telegram/cursorInsert.js` still exists as
 * a plain re-export of this file, so neither Broadcast import needed to
 * change.
 *
 * A controlled input's own `onChange` has no notion of "insert at
 * cursor" — only the caller, reading `selectionStart`/`selectionEnd` off
 * the real DOM node at click time, knows where the caret actually is; this
 * function is the pure part of that: given the current value, the
 * selection bounds, and the text to insert, it returns the new value AND
 * where the caret should land afterward, so the caller can both update its
 * own state (through whichever existing update path that field already
 * uses) and restore focus+caret in one step.
 *
 * `insertText` replaces the selection when one exists (start !== end),
 * matching how typing a character into a real input with a selection
 * behaves — an emoji picker insertion should feel the same as if the
 * admin had typed the emoji themselves.
 *
 * Multi-line `<textarea>` values need no special handling here: a real
 * `<textarea>`'s own `selectionStart`/`selectionEnd` are already plain
 * UTF-16 character offsets into the whole flat `value` string (a `\n` is
 * just another character at some offset, not a separate per-line index),
 * so this function's simple `slice()`-based logic is already correct for
 * a selection anywhere on a second line or later — verified directly, not
 * just assumed, by `cursorInsert.test.js`'s own multi-line case.
 */
export function insertAtCursor(value, selectionStart, selectionEnd, insertText) {
  const safeValue = value ?? '';
  const start = selectionStart ?? safeValue.length;
  const end = selectionEnd ?? safeValue.length;
  const nextValue = safeValue.slice(0, start) + insertText + safeValue.slice(end);
  const nextCaret = start + insertText.length;
  return { nextValue, nextCaret };
}
