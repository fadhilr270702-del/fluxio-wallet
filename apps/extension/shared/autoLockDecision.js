/**
 * Pure decision logic for the auto-lock timer (prompt 0117): given the
 * current time, when the last FLUXIO_INTERNAL_* activity was observed,
 * and the user's configured duration, decides whether the wallet should
 * lock right now. Deliberately free of any chrome.* / DOM reference — same
 * "extract the decision, keep the side effects elsewhere" pattern
 * shared/swapAssetSources.js (prompt 0116) already established, reusing
 * the test infrastructure that feature set up rather than inventing a
 * second one.
 *
 * WHY THE DURATION SETTING (`fluxio_auto_lock_minutes` in chrome.storage.
 * local, see background.js) IS PERSISTED BUT `lastActivityAt` IS NOT
 * (kept as a plain in-memory variable in background.js instead of
 * chrome.storage.session/local): this was actually reasoned through, not
 * assumed — see this module's own AUTO_LOCK_NEVER/shouldAutoLock() below
 * for the mechanics, and background.js's own comment for the full
 * argument, but the short version is: `walletService`'s unlocked session
 * is ALSO just an in-memory variable (`session`, in walletService.js) —
 * it is unconditionally wiped the instant the MV3 service worker is
 * torn down and restarted, for ANY reason, auto-lock or not. That means
 * every scenario splits into exactly two cases: (1) the service worker
 * stayed alive continuously since the last activity — in which case a
 * plain in-memory `lastActivityAt` correctly tracks real elapsed idle
 * time, and this function's elapsed-time check is the thing that
 * actually locks the wallet; or (2) the service worker was torn down and
 * restarted at some point — in which case `walletService.isUnlocked()`
 * is ALREADY false by the time anything asks, so there is nothing left
 * to lock and this function's answer is moot. Persisting `lastActivityAt`
 * durably would only ever matter for a third case — "correctly resume an
 * elapsed-time count across a service-worker restart of a session that's
 * still unlocked" — which cannot happen, since restarting the worker IS
 * what unlocks-to-locked already. Persisting it anyway would be pure
 * over-engineering for a case that provably never occurs.
 */

/** Sentinel value for "auto-lock is disabled" — a duration of 0/null is deliberately NOT used for this, so an explicit user choice ("Never") can never be confused with "no value configured yet"/corrupt data (see shouldAutoLock's own comment on failing safe for exactly that ambiguity). */
export const AUTO_LOCK_NEVER = 'never';

/**
 * The 6 selectable durations — prompt 0117's original 5 (5/15/30/60
 * minutes, Never) plus a "1 minute" option added in a later revision for
 * fast manual verification — minutes, or the AUTO_LOCK_NEVER sentinel.
 * Exported so background.js's storage read/write and popup.js's/
 * settings.js's <select> options all build from the same one list rather
 * than independently-typed copies.
 *
 * 1 minute is the SAME as `AUTO_LOCK_CHECK_PERIOD_MINUTES` (the alarm's
 * own polling granularity, see background.js) — this is not a hidden
 * edge case for shouldAutoLock() below: at exactly one check interval of
 * inactivity, `elapsedMs >= durationMs` reads `60_000 >= 60_000`, which
 * is `true` (the boundary comparison is already `>=`, inclusive, for
 * every duration, not just 1 minute) — so a 1-minute setting locks on
 * the very FIRST alarm check that could possibly observe the boundary,
 * same as every other duration locks on its own first qualifying check.
 * Nothing about this function's own logic needed to change to support
 * this value; see the new dedicated test in test/autoLockDecision.test.js
 * confirming it.
 */
export const AUTO_LOCK_OPTIONS_MINUTES = Object.freeze([1, 5, 15, 30, 60, AUTO_LOCK_NEVER]);

/** This feature's own specified default. */
export const AUTO_LOCK_DEFAULT_MINUTES = 15;

/**
 * Pure decision: given `now`, `lastActivityAt` (both epoch milliseconds),
 * and the configured `durationMinutes` (a number, or AUTO_LOCK_NEVER),
 * should the wallet lock right now?
 *
 * - `durationMinutes === AUTO_LOCK_NEVER`, EXACTLY (the literal sentinel,
 *   nothing else): never locks. This is the one and only "safe to not
 *   lock" case — an explicit user opt-out, which must always be honored
 *   regardless of anything else (bad timestamp data included) — there's
 *   no ambiguity to resolve toward when no timer was ever supposed to be
 *   running in the first place.
 * - Anything else that ISN'T one of the recognized numeric durations
 *   (`AUTO_LOCK_OPTIONS_MINUTES`) — a corrupt/unrecognized
 *   `durationMinutes`, e.g. `undefined`, `NaN`, a stray string, a value
 *   from a future/older schema — LOCKS. In normal operation background.js's
 *   own storage reader already sanitizes this to a known-good value
 *   before it ever reaches here (falling back to AUTO_LOCK_DEFAULT_MINUTES
 *   on anything unrecognized), so this branch should be unreachable in
 *   practice — but this function doesn't rely on that upstream sanitizing
 *   actually having happened; it fails closed on its own.
 * - A missing/corrupt `lastActivityAt` or `now` (not a finite number) —
 *   while a real, non-Never duration IS configured — also LOCKS. Same
 *   fail-CLOSED reasoning: if this function can't actually tell how long
 *   the wallet has been idle, the safe assumption is "too long", not
 *   "just now". The cost of being wrong this way is a spurious extra
 *   unlock prompt (annoying); the cost of being wrong the other way
 *   (silently never locking because corrupt data always reads as "0
 *   elapsed") is a wallet that never auto-locks at all, defeating the
 *   entire feature. Fail closed.
 * - Otherwise: locks when `now - lastActivityAt >= durationMinutes * 60_000`
 *   — inclusive of the exact boundary (locking AT precisely N minutes
 *   idle, not only strictly after), since "lock after N minutes of
 *   inactivity" reads as inclusive of N itself.
 *
 * @param {{ now: number, lastActivityAt: number, durationMinutes: number|string }} params
 * @returns {boolean}
 */
export function shouldAutoLock({ now, lastActivityAt, durationMinutes }) {
  if (durationMinutes === AUTO_LOCK_NEVER) {
    return false;
  }
  const isRecognizedDuration = typeof durationMinutes === 'number' && AUTO_LOCK_OPTIONS_MINUTES.includes(durationMinutes);
  if (!isRecognizedDuration || !Number.isFinite(now) || !Number.isFinite(lastActivityAt)) {
    return true; // fail closed — see this function's own doc comment
  }
  const elapsedMs = now - lastActivityAt;
  const durationMs = durationMinutes * 60_000;
  return elapsedMs >= durationMs;
}
