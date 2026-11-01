/**
 * Prompt 0139's "pagar kirim mode resmi" — pure decision + copy for the
 * confirmation modal Compose shows before any action that actually sends
 * to real subscribers/a real channel while the account switcher is on the
 * official bot. Kept pure (no React/DOM) so both pieces are directly
 * unit-testable, same pattern as composeRecentCards.js.
 *
 * Deliberately covers every branch create() can resolve to (immediate,
 * one-time schedule, AND recurring activation) rather than just an
 * immediate send: all three come from the same Compose submit button and
 * all three eventually reach real subscribers/a real channel with no human
 * in the loop at actual send time — a schedule/recurring activation is, if
 * anything, MORE in need of an explicit "yes, I know this is real" moment
 * than an immediate send, since nobody is present to notice a mistake when
 * it actually goes out. Saving the welcome message and editing an existing
 * broadcast's content are both deliberately EXCLUDED (per the base
 * prompt's own explicit list) — neither one itself causes a new send; only
 * whatever already-scheduled/recurring send eventually happens does, and
 * that send already passed through this same guard once, at creation time.
 */

/** True only for a brand-new (not edit-mode) submission while the official bot is the active context. */
export function isSendGuardRequired(botId, isEdit) {
  return !isEdit && botId === 'official';
}

/**
 * The confirmation copy itself — always names the real bot username (never
 * just "the official bot"), per the base prompt's own explicit example
 * wording ("Kirim via @FluxioWallet_bot ke N subscriber?").
 *
 * Prompt 0164 — a recurring activation's own copy now names the chosen
 * cadence ("setiap N jam mulai <waktu>") instead of just "pengiriman
 * berulang" with no detail — recurringIntervalHours/recurringStartsAt are
 * only ever meaningful (and only ever passed) when isRecurring is true.
 * recurringStartsAt null means "Mulai sekarang" — the summary says so
 * explicitly rather than naming a start time that doesn't exist.
 */
export function buildSendGuardMessage({
  botUsername,
  targetType,
  targetChannelId,
  activeSubscriberCount,
  isRecurring,
  recurringIntervalHours,
  recurringStartsAt
}) {
  const destination = targetType === 'channel'
    ? targetChannelId || 'channel ini'
    : `${activeSubscriberCount ?? 0} subscriber`;
  if (!isRecurring) {
    return `Kirim via @${botUsername} ke ${destination}?`;
  }
  const hours = recurringIntervalHours ?? 1;
  const startText = recurringStartsAt
    ? new Date(recurringStartsAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'sekarang';
  return `Aktifkan pengiriman setiap ${hours} jam mulai ${startText} via @${botUsername} ke ${destination}?`;
}
