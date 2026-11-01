import { describe, it, expect } from 'vitest';
import { insertAtCursor } from '../cursorInsert.js';

describe('insertAtCursor', () => {
  it('inserts at a cursor in the middle of the string', () => {
    const result = insertAtCursor('Hello world', 5, 5, '😊');
    expect(result).toEqual({ nextValue: 'Hello😊 world', nextCaret: 7 });
  });

  it('inserts at the very start (cursor at 0)', () => {
    const result = insertAtCursor('world', 0, 0, '😊');
    expect(result).toEqual({ nextValue: '😊world', nextCaret: 2 });
  });

  it('inserts at the very end (cursor at value.length)', () => {
    const result = insertAtCursor('Hello', 5, 5, '😊');
    expect(result).toEqual({ nextValue: 'Hello😊', nextCaret: 7 });
  });

  it('replaces an existing selection rather than inserting alongside it', () => {
    // "Hello [world]" with "world" selected (indices 6-11) -> replaced.
    const result = insertAtCursor('Hello world', 6, 11, '🔥');
    expect(result).toEqual({ nextValue: 'Hello 🔥', nextCaret: 8 });
  });

  it('handles an empty string value', () => {
    const result = insertAtCursor('', 0, 0, '😊');
    expect(result).toEqual({ nextValue: '😊', nextCaret: 2 });
  });

  it('handles a multi-code-unit emoji (skin-tone ZWJ sequence, 4 UTF-16 units)', () => {
    // 👍🏽 = U+1F44D (surrogate pair, 2 units) + U+1F3FD (surrogate pair, 2 units) = 4 units total.
    const emoji = '👍🏽';
    expect(emoji.length).toBe(4);
    const result = insertAtCursor('go ', 3, 3, emoji);
    expect(result).toEqual({ nextValue: 'go 👍🏽', nextCaret: 7 });
  });

  it('falls back to appending at the end when selection bounds are null/undefined', () => {
    const result = insertAtCursor('Hello', null, null, '!');
    expect(result).toEqual({ nextValue: 'Hello!', nextCaret: 6 });
  });

  it('handles a null value the same as an empty string', () => {
    const result = insertAtCursor(null, 0, 0, '😊');
    expect(result).toEqual({ nextValue: '😊', nextCaret: 2 });
  });

  // Prompt 0159 — a real `<textarea>`'s `selectionStart`/`selectionEnd` are
  // plain UTF-16 offsets into the whole flat `value` (a `\n` is just
  // another character at some offset, never a separate per-line index),
  // so a selection on the second line or later needs no special handling
  // — verified explicitly here rather than only inferred from the
  // implementation being offset-based.
  it('inserts correctly at a cursor on the second line of a multi-line value', () => {
    const value = 'First line\nSecond line here\nThird line';
    // Cursor placed right after "Second " (offset 18, inside the second line).
    const cursor = value.indexOf('Second ') + 'Second '.length;
    const result = insertAtCursor(value, cursor, cursor, '🎉');
    expect(result).toEqual({
      nextValue: 'First line\nSecond 🎉line here\nThird line',
      nextCaret: cursor + 2
    });
  });

  it('inserts correctly at a cursor on the third line, and a selection spanning a line break replaces both sides', () => {
    const value = 'Alpha\nBeta\nGamma';
    // Cursor at the very start of the third line. Uses 🎉 (astral-plane,
    // 2 UTF-16 units, like the rest of this file's emoji) rather than a
    // BMP symbol such as ✅ (only 1 unit) specifically so nextCaret's own
    // arithmetic below is exercised the same way as every other case here.
    const thirdLineStart = value.indexOf('Gamma');
    const atThirdLine = insertAtCursor(value, thirdLineStart, thirdLineStart, '🎉');
    expect(atThirdLine).toEqual({ nextValue: 'Alpha\nBeta\n🎉Gamma', nextCaret: thirdLineStart + 2 });

    // A selection spanning the Beta/Gamma line break (end of "Beta" through
    // start of "Gamma", i.e. including the '\n') is replaced as one unit,
    // exactly like any other selection.
    const selStart = value.indexOf('Beta');
    const selEnd = value.indexOf('Gamma');
    const spanningSelection = insertAtCursor(value, selStart, selEnd, '🔥');
    expect(spanningSelection).toEqual({ nextValue: 'Alpha\n🔥Gamma', nextCaret: selStart + 2 });
  });
});
