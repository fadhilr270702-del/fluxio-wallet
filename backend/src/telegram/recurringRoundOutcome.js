/**
 * Prompt 0166 — pure classification/decision logic extracted out of
 * worker.js's sendRecurringRound(), so "what does this error mean for the
 * round" and "what's this round's final verdict" have direct unit test
 * coverage without needing a running worker, a database, or a real
 * Telegram call.
 *
 * Fixes a real incident (see prompt/0166's own archive): recurring
 * broadcast 50287fba recorded a "successful" round (sent_count advanced,
 * recurring_last_sent_at moved forward, DB shows recurring_last_sent_at
 * 2026-09-01T11:48Z / sent_count 4) while every single delivery attempt in
 * that round actually failed with a network error — the laptop had just
 * woken from sleep, and the backend process's own timers/interval fired
 * immediately on wake, before the OS network stack was actually ready. The
 * old code only ever failed a round on a 429 (rate limit); every OTHER
 * error — including a total network outage — was treated as "that one
 * recipient's own problem, keep going" and the round still returned
 * `{ success: true }` even with zero successful sends.
 */
import { TelegramApiError } from './client.js';

/**
 * Classifies one failed send attempt into what it means for the ROUND
 * (not just that one recipient):
 *
 *  - 'rate_limited' — a TelegramApiError with errorCode 429. Telegram
 *    itself answered, but says to back off; the whole round fails and is
 *    retried later (see computeRoundOutcome) — unchanged from the
 *    pre-0166 behavior.
 *  - 'recipient' — any OTHER TelegramApiError (403 blocked, 400 chat not
 *    found, etc.). Telegram answered normally; this ONE recipient just
 *    can't be reached, so the round continues to the next recipient (403
 *    additionally deactivates that subscriber — unchanged, handled by the
 *    caller, not this function).
 *  - 'transport' — anything that ISN'T a TelegramApiError at all, i.e. no
 *    valid API response was ever received: a DNS failure (ENOTFOUND), a
 *    reset connection (ECONNRESET), a request timeout/abort, or fetch's
 *    own generic `TypeError: fetch failed` wrapper (undici's catch-all for
 *    a connection that never got established). There is no other way
 *    `callTelegramApi()` (client.js) can throw something that isn't a
 *    TelegramApiError, so this is deliberately just "not a
 *    TelegramApiError" rather than a list of specific error
 *    codes/names to match against — that list is inherently incomplete
 *    (real Node/undici network failures take many shapes), and every one
 *    of them means the same thing here: this attempt never reached
 *    Telegram at all, so nothing about it can be trusted as delivered.
 */
export function classifySendError(err) {
  if (err instanceof TelegramApiError) {
    return err.errorCode === 429 ? 'rate_limited' : 'recipient';
  }
  return 'transport';
}

/**
 * Summarizes an already-run (or already-cut-short) sequence of per-recipient
 * send attempts into the round's final verdict. The actual loop (in
 * worker.js) still owns the real early-exit decision — it must stop
 * calling sendOne() the instant a 'transport' or 'rate_limited' attempt
 * happens, per this prompt's own explicit "hentikan loop, jangan lanjut ke
 * subscriber berikutnya" requirement — this function only summarizes
 * whatever attempts the loop actually made before stopping (if it did).
 *
 * @param {Array<'success'|'recipient_error'>} attempts one entry per
 *   recipient actually attempted, in order. A loop cut short by a
 *   transport/rate_limited error simply has fewer entries than the total
 *   subscriber count — `stoppedEarlyBy` conveys that, not an extra array
 *   entry (a transport/rate_limited attempt is never itself pushed here).
 * @param {{ stoppedEarlyBy?: 'transport'|'rate_limited'|null, hadSubscribers: boolean }} context
 * @returns {{ success: boolean, sentCount: number, failedCount: number, failureReason: 'transport'|'rate_limited'|'zero_delivered'|null }}
 */
export function computeRoundOutcome(attempts, { stoppedEarlyBy = null, hadSubscribers }) {
  const sentCount = attempts.filter((a) => a === 'success').length;
  const failedCount = attempts.filter((a) => a === 'recipient_error').length;

  // A transport failure fails the round OUTRIGHT, regardless of how many
  // recipients already succeeded before it hit — per this prompt's own
  // explicit "gagalkan ronde SEKETIKA... tanpa tulis DB" requirement. The
  // recipients who DID get a message this attempt keep it (Telegram
  // doesn't un-send), but the round itself is not recorded, so the very
  // next tick retries the WHOLE round from scratch (including re-sending
  // to anyone already reached this attempt) — a known, deliberate
  // trade-off, not a bug: a transport failure means "the network's own
  // state is unknown right now", so treating anything from this attempt
  // as trustworthy would be worse than a rare duplicate send.
  if (stoppedEarlyBy === 'transport') {
    return { success: false, sentCount, failedCount, failureReason: 'transport' };
  }
  // Unchanged from the pre-0166 behavior — a 429 still fails the round,
  // still leaves recurring_last_sent_at untouched, still relies on the
  // caller's own pausedUntil to actually back the worker off.
  if (stoppedEarlyBy === 'rate_limited') {
    return { success: false, sentCount, failedCount, failureReason: 'rate_limited' };
  }
  // Prompt 0166 investigation: the pre-existing behavior for a recurring
  // broadcast with literally no active subscribers is to still report the
  // round as sent (sent_count still advances, with 0/0 recipients) —
  // preserved exactly here, per this prompt's own explicit "cek perilaku
  // sekarang dan pertahankan" instruction. This is genuinely different
  // from "had subscribers but zero of them succeeded" below: there was
  // never anyone to fail to reach in the first place, so there's nothing
  // to flag as a delivery failure.
  if (!hadSubscribers) {
    return { success: true, sentCount: 0, failedCount: 0, failureReason: null };
  }
  // The actual incident fix: previously this branch didn't exist at all —
  // the round returned { success: true } unconditionally once the loop
  // finished, even if every single attempt failed. Now: at least one real
  // delivery is required for the round to count as sent.
  if (sentCount === 0) {
    return { success: false, sentCount, failedCount, failureReason: 'zero_delivered' };
  }
  return { success: true, sentCount, failedCount, failureReason: null };
}
