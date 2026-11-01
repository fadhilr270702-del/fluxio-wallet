import { fromDatetimeLocalValue, todayLocalDateValue } from '../../../utils/formatDate.js';

/**
 * Resolves the Today/Later schedule-picker state into a UTC ISO string,
 * or an error message — mirrors the backend's own "must be in the future"
 * refine (adminTelegramBroadcastRoutes.js) so the composer/reschedule
 * dialog give an immediate error instead of waiting on a round trip. The
 * backend re-validates authoritatively either way.
 *
 * @param {{ mode: 'today'|'later', todayTime: string, laterValue: string }} state
 * @returns {{ iso: string, error: null } | { iso: null, error: string }}
 */
export function resolveScheduledAtIso({ mode, todayTime, laterValue }) {
  if (mode === 'today') {
    if (!todayTime) return { iso: null, error: 'Pick a time.' };
    const iso = fromDatetimeLocalValue(`${todayLocalDateValue()}T${todayTime}`);
    if (!iso || Date.parse(iso) <= Date.now()) {
      return { iso: null, error: 'That time has already passed today — pick a later time.' };
    }
    return { iso, error: null };
  }

  if (!laterValue) return { iso: null, error: 'Pick a date and time.' };
  const iso = fromDatetimeLocalValue(laterValue);
  if (!iso || Date.parse(iso) <= Date.now()) {
    return { iso: null, error: 'Pick a date and time in the future.' };
  }
  return { iso, error: null };
}
