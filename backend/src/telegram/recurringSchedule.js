/**
 * Pure due-check for a recurring broadcast's next round — extracted out of
 * worker.js's processDueRecurring() (prompt 0134 Revision 1) specifically
 * so this one piece of real scheduling logic has direct unit test coverage
 * without needing a database, a running worker, or a real Telegram call.
 *
 * A null/undefined `lastSentAtIso` (never sent yet) is treated as
 * "already due" — this is deliberate, not a default-to-zero accident: it's
 * what makes a broadcast's first round go out promptly (at most one worker
 * tick after activation, since activation itself no longer sends
 * synchronously — see the create controller's own comment on the
 * duplicate-send bug this fixed) and what makes a genuinely-failed round
 * retry on the very next tick, both via this exact same rule.
 *
 * Prompt 0164 — superseded by computeRecurringDue() below as worker.js's
 * own due-check (no two sources of truth in the worker — see that
 * function's own header), but kept here, unchanged, exactly as it was: its
 * own 7 existing tests still pass unmodified, and computeRecurringDue's own
 * "no anchor at all" fallback branch (a genuinely pre-0164 legacy row that
 * somehow never gets a recurring_starts_at backfilled — see
 * telegramBroadcastsRepo.js's recordRecurringSend()) is intentionally
 * IDENTICAL arithmetic to this function, not just similar — a case worth
 * keeping named and independently testable rather than folding away.
 */
export function isRecurringDue(lastSentAtIso, intervalMs, now = Date.now()) {
  const lastSentMs = lastSentAtIso ? Date.parse(lastSentAtIso) : 0;
  return now - lastSentMs >= intervalMs;
}

/**
 * Prompt 0164 — the anchor-based due-check that replaces isRecurringDue()
 * as worker.js's own single source of truth. Every timestamp is parsed via
 * Date.parse()/compared as milliseconds-since-epoch throughout — there is
 * no calendar-day/local-time reasoning anywhere in this function, so it is
 * inherently DST-agnostic: a plain ISO-8601 UTC instant in, a millisecond
 * comparison out, nothing else.
 *
 * Three cases:
 *  1. Never sent yet (`lastSentAtIso` null/undefined):
 *     - `startsAtIso` null → due immediately (identical to isRecurringDue's
 *       own null-lastSent rule — "Mulai sekarang", or a genuine legacy row).
 *     - `startsAtIso` set → due once `now >= startsAtIso`, never before.
 *  2. Already sent at least once, but `startsAtIso` is still null (should
 *     only happen for a genuine pre-0164 row whose very first post-upgrade
 *     round hasn't landed yet, since recordRecurringSend() backfills this
 *     the moment a round first succeeds — see that function's own comment):
 *     falls back to isRecurringDue()'s own plain elapsed-time rule, byte-
 *     for-byte — no anchor to pin slots to, so there's nothing more precise
 *     to compute.
 *  3. Already sent at least once, `startsAtIso` set (the normal case for
 *     every broadcast created after this migration, "Mulai sekarang"
 *     included, once its first round has landed): rounds fall on
 *     `startsAtIso + k*intervalMs` for k=0,1,2,... — `slotsCompleted` is how
 *     many FULL intervals separate the anchor from the last real send
 *     (measured from the anchor, never from the last send itself — this is
 *     what keeps every round pinned to the ORIGINAL anchor regardless of
 *     how much worker-tick/network jitter accumulated in `lastSentAtIso`,
 *     unlike isRecurringDue's own "next = last send + interval" rule, which
 *     drifts a little further every round). The next due slot is exactly
 *     one interval past whichever slot `lastSentAtIso` most recently
 *     fulfilled.
 *
 *     Catch-up policy (explicit, not incidental): if several slots were
 *     missed entirely (the worker was down, or the last round took unusually
 *     long), `slotsCompleted` simply reflects however many intervals have
 *     actually elapsed — the skipped slots are never individually visited
 *     or backfilled, so this naturally sends exactly ONE round to catch up,
 *     then resumes the regular cadence from the next REGULAR anchor slot
 *     after that, never a burst of back-to-back sends for the slots that
 *     were missed.
 *
 * Returns `{ due, anchorForThisRound }` — `anchorForThisRound` is the ISO
 * timestamp of the specific slot this due-check is evaluating (null when
 * there's no anchor to report: cases 1's null-startsAt branch, and case 2's
 * fallback). Not load-bearing for the worker's own control flow (only
 * `due` is), but useful for logging/debugging which slot a given round
 * actually corresponds to.
 */
export function computeRecurringDue(lastSentAtIso, startsAtIso, intervalMs, now = Date.now()) {
  if (!lastSentAtIso) {
    if (!startsAtIso) return { due: true, anchorForThisRound: null };
    const startsMs = Date.parse(startsAtIso);
    return { due: now >= startsMs, anchorForThisRound: startsAtIso };
  }

  if (!startsAtIso) {
    return { due: isRecurringDue(lastSentAtIso, intervalMs, now), anchorForThisRound: null };
  }

  const startsMs = Date.parse(startsAtIso);
  const lastSentMs = Date.parse(lastSentAtIso);
  const slotsCompleted = Math.floor((lastSentMs - startsMs) / intervalMs);
  const nextSlotMs = startsMs + (slotsCompleted + 1) * intervalMs;
  return { due: now >= nextSlotMs, anchorForThisRound: new Date(nextSlotMs).toISOString() };
}
