/**
 * Prompt 0152 — caps how many premium-emoji animations (Lottie/video) are
 * ever playing at once, per the base prompt's own explicit performance
 * requirement ("batasi jumlah animasi hidup bersamaan"). A grid can hold
 * hundreds of emoji; only the ones currently visible AND holding a slot
 * ever fetch+play their real animation — everything else shows its static
 * thumbnail instead (see PremiumEmojiAnimated.jsx).
 *
 * Deliberately a plain factory (`createSlotManager`) rather than a bare
 * module-singleton with hardcoded state — the whole admin app shares one
 * instance (`sharedEmojiAnimationSlots`, below) at runtime, but a factory
 * is what makes this pure enough to unit-test directly (each test gets its
 * own isolated manager, no shared module state to reset between tests).
 *
 * No forced eviction of an already-playing animation to make room for a
 * newly-visible one — slots free up naturally as items scroll OUT of view
 * (PremiumEmojiAnimated releases its own slot on that transition). If more
 * than `maxConcurrent` tiles are visible at once (a very tall unscrolled
 * grid on a large monitor), the overflow simply keeps showing its static
 * thumbnail until something else frees a slot — matches the base prompt's
 * literal wording ("cap concurrent, stop the ones that leave the
 * viewport"), not a policy of picking a "least important" animation to
 * kill.
 */
export function createSlotManager(maxConcurrent) {
  const active = new Set();
  const listeners = new Set();

  function notify() {
    listeners.forEach((fn) => fn());
  }

  return {
    maxConcurrent,

    /** True if `id` already holds a slot, or a free slot was successfully claimed for it. False if the manager is at capacity. */
    acquireSlot(id) {
      if (active.has(id)) return true;
      if (active.size >= maxConcurrent) return false;
      active.add(id);
      notify();
      return true;
    },

    /** No-op if `id` doesn't currently hold a slot — always safe to call defensively (e.g. on every unmount). */
    releaseSlot(id) {
      if (active.delete(id)) notify();
    },

    hasSlot(id) {
      return active.has(id);
    },

    activeCount() {
      return active.size;
    },

    /** Notified any time a slot is acquired or released — a caller that failed to acquire a slot subscribes to retry once one frees up. Returns an unsubscribe function. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

// The base prompt's own suggested figure ("misal 24") — a cap, not a
// measured hardware limit; easy to revisit later without touching any
// call site, since every consumer goes through the shared instance below
// rather than importing this constant directly.
export const DEFAULT_MAX_CONCURRENT_ANIMATIONS = 24;

export const sharedEmojiAnimationSlots = createSlotManager(DEFAULT_MAX_CONCURRENT_ANIMATIONS);
