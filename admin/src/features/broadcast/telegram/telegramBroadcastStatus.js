/** Pure display helpers for Telegram broadcasts — mirrors features/announcements/announcementsStatus.js. */

export const STATUS_LABELS = {
  queued: 'Queued',
  scheduled: 'Scheduled',
  recurring: 'Recurring',
  sending: 'Sending',
  completed: 'Completed',
  partial: 'Partial',
  failed: 'Failed',
  canceled: 'Canceled'
};

export const TARGET_TYPE_LABELS = {
  channel: 'Channel',
  subscribers: 'Subscribers'
};

/** e.g. "42 / 50 sent" for a subscriber-targeted broadcast in progress. */
export function progressLabel(broadcast) {
  if (broadcast.targetType !== 'subscribers') return null;
  // Recipient count for a scheduled subscribers-broadcast isn't known until
  // the active list is snapshotted at activation time — a 0/0 here would
  // read as "nobody active", not "not sent yet".
  if (broadcast.status === 'scheduled') return 'Recipients determined at send time';
  if (broadcast.totalCount === 0) return 'No active subscribers at send time';
  return `${broadcast.sentCount + broadcast.failedCount} / ${broadcast.totalCount} processed`;
}

/**
 * The History table's Progress column for a recurring broadcast (prompt
 * 0134) — a single row's own running tally ("Sent N×, last HH:MM"), not the
 * per-recipient X/Y-processed shape progressLabel() above produces, since a
 * recurring broadcast's sent_count means "successful rounds", not
 * "recipients reached" (see the migration's own comment on this deliberate
 * dual meaning). Returns null for a broadcast that was never recurring, so
 * a call site can fall back to progressLabel() unconditionally.
 *
 * isRecurring is a PERMANENT marker (stays true after deactivation) — this
 * function keeps reporting the final tally even once `status` has moved on
 * from 'recurring' to 'completed', per prompt 0134's own "the history row
 * stays with its final counter" requirement, rather than silently reverting
 * to looking like an ordinary one-off broadcast.
 *
 * Prompt 0164 — every branch now names the chosen interval ("every N
 * hours"), and a broadcast whose own recurringStartsAt anchor is still in
 * the FUTURE (chosen "Mulai pada jam tertentu", not yet reached its first
 * round) gets its own distinct "not started yet" wording instead of the
 * misleading "first send in progress" text, which implied an imminent send
 * rather than a still-pending scheduled start. This is a pure display-layer
 * distinction — every one of the 4 surfaces that show recurring status
 * (History table, Recent cards, View modal, Detail page) already funnels
 * through this one function, so no other file needed a change to pick this
 * up. No literal "-" character in any of this copy, per the base prompt's
 * own explicit style note — "N hours", never "N-hour".
 */
function intervalPhrase(broadcast) {
  const hours = broadcast.recurringIntervalHours ?? 1;
  return `every ${hours} hour${hours === 1 ? '' : 's'}`;
}

function formatTimeShort(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Prompt 0166 — the most recent round's own delivered/failed counts, e.g.
 * "last round 3 of 3 delivered" or "last round 0 of 3 delivered" (a round
 * with subscribers but zero deliveries is exactly the incident this
 * prompt's own backend fix now prevents from ever being recorded as
 * "sent" in the first place — but a legacy row from before this column
 * existed, or a row whose round hasn't completed yet, has both fields
 * null, so this returns null and the caller falls back to the older
 * wording with no round-result fragment). No literal "-" character, same
 * style note as intervalPhrase() above — "3 of 3", never "3-of-3".
 */
function roundResultPhrase(broadcast) {
  const sent = broadcast.recurringLastRoundSentCount;
  const failed = broadcast.recurringLastRoundFailedCount;
  if (sent === null || sent === undefined || failed === null || failed === undefined) return null;
  return `last round ${sent} of ${sent + failed} delivered`;
}

/**
 * Prompt 0234 (P4) — a real round duration, from the backend's new
 * telegram_recurring_rounds row (recurringLastRound on the API shape; null
 * for every legacy row, so every pre-0234 label stays byte-identical). No
 * literal "-" character, same style note as everything here.
 */
function roundDurationPhrase(broadcast) {
  const round = broadcast.recurringLastRound;
  if (!round || !round.startedAt || !round.finishedAt) return null;
  const ms = Date.parse(round.finishedAt) - Date.parse(round.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalMinutes = Math.round(ms / 60000);
  const duration =
    totalMinutes >= 60
      ? `${Math.floor(totalMinutes / 60)} h ${totalMinutes % 60} m`
      : totalMinutes >= 1
        ? `${totalMinutes} m`
        : `${Math.max(1, Math.round(ms / 1000))} s`;
  return `last round ${duration}, ${round.sentCount} of ${round.sentCount + round.failedCount}`;
}

export function recurringProgressLabel(broadcast) {
  if (!broadcast.isRecurring) return null;
  const count = broadcast.sentCount ?? 0;
  const interval = intervalPhrase(broadcast);
  // Prompt 0234 (P4) — prefer the rounds-table phrase (real duration);
  // fall back to the 0166 counts-only phrase for legacy rows.
  const roundResult = roundDurationPhrase(broadcast) ?? roundResultPhrase(broadcast);
  // Prompt 0234 (P4) — the next due slot, finally VISIBLE in History
  // instead of only implied by the interval.
  const nextRound = broadcast.status === 'recurring' && broadcast.recurringNextRoundAt
    ? `next round ${formatTimeShort(broadcast.recurringNextRoundAt)}`
    : null;

  if (broadcast.status === 'recurring') {
    // Not yet sent even once, AND an explicit future start time was chosen
    // ("Mulai pada jam tertentu") — distinct from the generic "first send
    // in progress" wording below, which implies an imminent send rather
    // than a still-pending scheduled start.
    if (!broadcast.recurringLastSentAt && broadcast.recurringStartsAt && Date.parse(broadcast.recurringStartsAt) > Date.now()) {
      return `Not started yet — starts ${formatTimeShort(broadcast.recurringStartsAt)}, ${interval}`;
    }
    const lastTime = broadcast.recurringLastSentAt ? formatTimeShort(broadcast.recurringLastSentAt) : null;
    const nextPart = nextRound ? `, ${nextRound}` : '';
    if (!lastTime) return `Sent ${count}× — first send in progress, ${interval}${nextPart}`;
    return roundResult
      ? `Sent ${count}×, last ${lastTime} (${roundResult}), ${interval}${nextPart}`
      : `Sent ${count}×, last ${lastTime}, ${interval}${nextPart}`;
  }
  return roundResult
    ? `Sent ${count}× total (auto, deactivated), ${interval}, ${roundResult}`
    : `Sent ${count}× total (auto, deactivated), ${interval}`;
}
