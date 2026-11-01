import { describe, it, expect, vi } from 'vitest';
import { createSlotManager } from '../emojiAnimationSlots.js';

describe('createSlotManager', () => {
  it('acquires up to the cap, then rejects further acquisitions', () => {
    const slots = createSlotManager(2);
    expect(slots.acquireSlot('a')).toBe(true);
    expect(slots.acquireSlot('b')).toBe(true);
    expect(slots.acquireSlot('c')).toBe(false);
    expect(slots.activeCount()).toBe(2);
  });

  it('re-acquiring an id it already holds is a no-op success, not a second slot', () => {
    const slots = createSlotManager(1);
    expect(slots.acquireSlot('a')).toBe(true);
    expect(slots.acquireSlot('a')).toBe(true);
    expect(slots.activeCount()).toBe(1);
  });

  it('releasing a slot frees capacity for a new acquisition', () => {
    const slots = createSlotManager(1);
    expect(slots.acquireSlot('a')).toBe(true);
    expect(slots.acquireSlot('b')).toBe(false);
    slots.releaseSlot('a');
    expect(slots.acquireSlot('b')).toBe(true);
  });

  it('releasing an id that never held a slot is a safe no-op', () => {
    const slots = createSlotManager(2);
    expect(() => slots.releaseSlot('never-acquired')).not.toThrow();
    expect(slots.activeCount()).toBe(0);
  });

  it('hasSlot reflects current holders only', () => {
    const slots = createSlotManager(1);
    expect(slots.hasSlot('a')).toBe(false);
    slots.acquireSlot('a');
    expect(slots.hasSlot('a')).toBe(true);
    slots.releaseSlot('a');
    expect(slots.hasSlot('a')).toBe(false);
  });

  it('notifies subscribers on both acquire and release, and stops after unsubscribe', () => {
    const slots = createSlotManager(2);
    const listener = vi.fn();
    const unsubscribe = slots.subscribe(listener);

    slots.acquireSlot('a');
    expect(listener).toHaveBeenCalledTimes(1);
    slots.releaseSlot('a');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    slots.acquireSlot('b');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not notify on a redundant acquire/release (no actual state change)', () => {
    const slots = createSlotManager(1);
    const listener = vi.fn();
    slots.acquireSlot('a');
    slots.subscribe(listener);

    slots.acquireSlot('a'); // already held — no change
    slots.releaseSlot('never-held'); // nothing to release — no change
    expect(listener).not.toHaveBeenCalled();
  });

  it('a full manager lets a subscriber know the instant a slot frees, simulating the retry pattern PremiumEmojiAnimated uses', () => {
    const slots = createSlotManager(1);
    slots.acquireSlot('a');
    expect(slots.acquireSlot('b')).toBe(false);

    let acquiredOnRetry = false;
    const unsubscribe = slots.subscribe(() => {
      if (slots.acquireSlot('b')) {
        acquiredOnRetry = true;
        unsubscribe();
      }
    });

    slots.releaseSlot('a');
    expect(acquiredOnRetry).toBe(true);
    expect(slots.hasSlot('b')).toBe(true);
  });

  it('two independent managers never share state', () => {
    const slotsA = createSlotManager(1);
    const slotsB = createSlotManager(1);
    slotsA.acquireSlot('x');
    expect(slotsB.hasSlot('x')).toBe(false);
    expect(slotsB.acquireSlot('x')).toBe(true);
  });
});
