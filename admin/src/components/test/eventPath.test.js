import { describe, it, expect } from 'vitest';
import { isEventInsideElement } from '../eventPath.js';

// `element` and the entries returned by `composedPath()` never need to be
// real DOM nodes for this function's own logic — plain objects compared by
// reference are enough, which is exactly what keeps this unit-testable
// without a browser/DOM environment (see eventPath.js's own comment).
function fakeEvent(path) {
  return { composedPath: () => path };
}

describe('isEventInsideElement', () => {
  it('true when the element is exactly the event target (no shadow DOM involved)', () => {
    const el = {};
    expect(isEventInsideElement(fakeEvent([el]), el)).toBe(true);
  });

  it('true when the element is an ancestor further up the composed path (the shadow-retargeting case)', () => {
    const button = {};
    const shadowHost = {};
    const wrapper = {};
    // Mirrors the real, live-verified path: [button, ...shadow internals, shadowHost, wrapper, ...]
    expect(isEventInsideElement(fakeEvent([button, shadowHost, wrapper]), wrapper)).toBe(true);
  });

  it('false when the element never appears in the composed path', () => {
    const el = {};
    const somethingElse = {};
    expect(isEventInsideElement(fakeEvent([somethingElse]), el)).toBe(false);
  });

  it('false when element is null/undefined (popoverRef.current not yet mounted)', () => {
    const path = [{}];
    expect(isEventInsideElement(fakeEvent(path), null)).toBe(false);
    expect(isEventInsideElement(fakeEvent(path), undefined)).toBe(false);
  });

  it('false when the event has no composedPath function at all', () => {
    const el = {};
    expect(isEventInsideElement({}, el)).toBe(false);
    expect(isEventInsideElement(null, el)).toBe(false);
  });

  it('false for an empty composed path', () => {
    const el = {};
    expect(isEventInsideElement(fakeEvent([]), el)).toBe(false);
  });
});
