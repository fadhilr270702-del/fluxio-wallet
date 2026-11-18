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
 * Prompt 0246 — the anchor can now MOVE: the admin's Edit page re-anchors
 * an active broadcast (anchor = the chosen next round, plus a new
 * interval). Until then the anchor was never later than the first send, so
 * case 3's floor arithmetic only ever saw a last send at or after the
 * anchor. With a moved anchor it sees two new shapes, both measured
 * against the pre-0246 code before this change:
 *  a. The last send is OLDER than the anchor (the normal state right after
 *     an edit). The floor goes negative and produced slots BEFORE the
 *     anchor — a round 5.5 hours ahead of the chosen time in the measured
 *     case. Now: the next slot is the anchor itself, never earlier.
 *  b. The round that was in progress at edit time finishes AFTER the
 *     anchor. Its finish time made the floor read "anchor slot already
 *     served" and the chosen round was silently skipped. Now: a round
 *     credits the anchor's grid only if it STARTED at or after the anchor
 *     (`lastRoundStartedAtIso`, from telegram_recurring_rounds); one that
 *     started before it leaves the anchor slot owed, so that round runs as
 *     soon as the one in progress is done — owner decision, no slot is
 *     skipped. It is owed exactly once: the round that then serves it
 *     starts after the anchor, and plain arithmetic resumes.
 *     Deliberately requires the last send to be strictly AFTER the anchor:
 *     recordRecurringSend's legacy COALESCE backfill writes one and the
 *     same timestamp into both columns for a NULL-anchor row whose round
 *     necessarily started earlier, and that must stay plain arithmetic.
 *     With no round start supplied (a channel target sends one message and
 *     keeps no round row) nothing changes from the pre-0246 behavior.
 *
 * Returns `{ due, anchorForThisRound }` — `anchorForThisRound` is the ISO
 * timestamp of the specific slot this due-check is evaluating (null when
 * there's no anchor to report: cases 1's null-startsAt branch, and case 2's
 * fallback). Not load-bearing for the worker's own control flow (only
 * `due` is), but it IS what the admin panel shows as "next round"
 * (telegramBroadcastController.js's recurringNextRoundAt), so the worker
 * and the label can never disagree.
 */
export function computeRecurringDue(lastSentAtIso, startsAtIso, intervalMs, now = Date.now(), { lastRoundStartedAtIso = null } = {}) {
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
  const anchorSlotStillOwed =
    lastSentMs < startsMs ||
    (lastSentMs > startsMs && lastRoundStartedAtIso != null && Date.parse(lastRoundStartedAtIso) < startsMs);
  if (anchorSlotStillOwed) {
    return { due: now >= startsMs, anchorForThisRound: startsAtIso };
  }
  const nextSlotMs = nextSlotMsAfter(lastSentMs, startsMs, intervalMs);
  return { due: now >= nextSlotMs, anchorForThisRound: new Date(nextSlotMs).toISOString() };
}

/**
 * The first slot of the grid `anchorMs + k × intervalMs` (k = 0, 1, 2, …)
 * that comes after the slot `timestampMs` sits in — or the anchor itself
 * when the timestamp is before the anchor (prompt 0246: a grid has no
 * slots before its own anchor). Shared by computeRecurringDue above and by
 * worker.js's "open round with no cursor waits for the next slot" branch,
 * so the two can never disagree about where slots are.
 */
export function nextSlotMsAfter(timestampMs, anchorMs, intervalMs) {
  if (timestampMs < anchorMs) return anchorMs;
  return anchorMs + (Math.floor((timestampMs - anchorMs) / intervalMs) + 1) * intervalMs;
}
