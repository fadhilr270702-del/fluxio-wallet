/**
 * Prompt 0246 — pure helpers for a recurring broadcast's schedule on the
 * admin side: the "Repeat every" choices the composer offers, and the Edit
 * page's schedule section (Interval + Next round), which can now change
 * the schedule of an ACTIVE recurring broadcast without deactivating it.
 *
 * The Edit page sends the schedule only when the admin actually changed
 * it, always as a pair (intervalHours + nextRunAt) — the backend's
 * updateContentSchema enforces the same pairing. An untouched schedule
 * section therefore leaves a content only save exactly what it was before
 * this feature, including while a round is in progress (when there is no
 * future "next round" to prefill at all).
 *
 * Times use the browser's own zone, the same datetime-local helpers the
 * composer's schedule picker already uses (utils/formatDate.js) — the
 * owner's decision, so Compose and Edit can never disagree about what a
 * typed time means.
 */
import { toDatetimeLocalValue, fromDatetimeLocalValue } from '../../../utils/formatDate.js';

/**
 * The owner's list, and the ONE place it lives on the admin side (the
 * composer's "Repeat every" select reads it through
 * recurringIntervalOptions() below; the Edit page's Interval input is a
 * free number from 1 to MAX and needs no list).
 *
 * Prompt 0246 Revisi 1 (owner decision, 17 November 2026): every hour
 * from 1 to 24 with no gaps, then 48, 72 and 168 — 27 choices. The first
 * version of 0246 offered 1, 2, 3, 6, 12, 24, 48, 72, 168. The backend
 * accepts any whole number of hours from 1 to MAX either way.
 */
export const RECURRING_INTERVAL_CHOICES = [...Array.from({ length: 24 }, (_, index) => index + 1), 48, 72, 168];
export const MAX_RECURRING_INTERVAL_HOURS = 168;

function isValidIntervalHours(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_RECURRING_INTERVAL_HOURS;
}

/**
 * Options for the composer's "Repeat every" select: the fixed choices,
 * plus the form's current value when it is a valid interval that is not
 * on the list (a broadcast copied to the form from one whose interval was
 * set to, say, 36 hours on the Edit page) — so a copy never silently
 * changes the interval.
 */
export function recurringIntervalOptions(currentValue) {
  if (!isValidIntervalHours(currentValue) || RECURRING_INTERVAL_CHOICES.includes(currentValue)) {
    return RECURRING_INTERVAL_CHOICES;
  }
  return [...RECURRING_INTERVAL_CHOICES, currentValue].sort((a, b) => a - b);
}

/**
 * What the Edit page's two schedule inputs start as, from the broadcast's
 * own API shape. The next round is prefilled only when it is still ahead:
 * a round that is due now or in progress reports a slot at or before now,
 * which is not a time anyone could choose.
 */
export function initialScheduleEditState(broadcast, now = Date.now()) {
  const nextRoundAt = broadcast.recurringNextRoundAt;
  const isAhead = Boolean(nextRoundAt) && Date.parse(nextRoundAt) > now;
  return {
    intervalHours: String(broadcast.recurringIntervalHours ?? 1),
    nextRoundLocal: isAhead ? toDatetimeLocalValue(nextRoundAt) : ''
  };
}

/**
 * Decides what the Save request carries for the schedule.
 *
 * @param {{ original: { intervalHours: string, nextRoundLocal: string }, current: { intervalHours: string, nextRoundLocal: string }, now?: number }} args
 * @returns {{ changed: false } | { changed: true, intervalHours: number, nextRunAt: string } | { error: string }}
 */
export function resolveRecurringScheduleEdit({ original, current, now = Date.now() }) {
  const raw = String(current.intervalHours ?? '').trim();
  const intervalHours = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!isValidIntervalHours(intervalHours)) {
    return { error: `Interval must be a whole number of hours from 1 to ${MAX_RECURRING_INTERVAL_HOURS}.` };
  }

  const changed = String(intervalHours) !== String(original.intervalHours).trim() || current.nextRoundLocal !== original.nextRoundLocal;
  if (!changed) return { changed: false };

  if (!current.nextRoundLocal) return { error: 'Pick the date and time of the next round.' };
  const nextRunAt = fromDatetimeLocalValue(current.nextRoundLocal);
  if (!nextRunAt || Date.parse(nextRunAt) <= now) return { error: 'The next round must be in the future.' };
  return { changed: true, intervalHours, nextRunAt };
}

/** Adds the schedule pair to an edit payload only when it changed. */
export function applyScheduleEditToPayload(payload, resolved) {
  if (!resolved || !resolved.changed) return payload;
  return { ...payload, intervalHours: resolved.intervalHours, nextRunAt: resolved.nextRunAt };
}
