import { formatDate } from '../../utils/formatDate.js';

/**
 * Prompt 0171 — the collapsed "Display schedule" section's own header
 * summary text, extracted as a pure function (given `startsAt`/`endsAt`,
 * returns a summary string or `null`) specifically so it's unit-testable
 * without mounting AnnouncementForm.jsx — same "extract the pure decision,
 * keep the side effects in the component" pattern this codebase already
 * uses elsewhere (e.g. apps/extension/shared/swapAssetSources.js).
 *
 * Accepts either a real ISO-8601 string or a `<input type="datetime-local">`
 * value string (e.g. "2026-01-15T14:30") — `formatDate()`'s own
 * `new Date(...)` parses both correctly, and AnnouncementForm.jsx's own
 * `fields.startsAt`/`fields.endsAt` are always the latter (the raw
 * datetime-local input value, only ever converted to/from ISO at load/
 * submit time via toDatetimeLocalValue()/fromDatetimeLocalValue()) — so
 * this function is called directly against `fields`, no extra conversion
 * needed here.
 *
 * Returns `null` (not an empty string) when neither is set, so a caller
 * can use it directly as a falsy check for "nothing to show" — matching
 * this codebase's own null-for-absent convention (see e.g.
 * announcementsMerge.js's own `firstSeenAt` handling in apps/extension).
 *
 * @param {{startsAt?: string|null, endsAt?: string|null}} fields
 * @returns {string|null}
 */
export function formatScheduleSummary({ startsAt, endsAt }) {
  const hasStart = Boolean(startsAt);
  const hasEnd = Boolean(endsAt);
  if (!hasStart && !hasEnd) return null;
  if (hasStart && hasEnd) return `Visible ${formatDate(startsAt)} to ${formatDate(endsAt)}`;
  if (hasStart) return `Visible from ${formatDate(startsAt)}`;
  return `Visible until ${formatDate(endsAt)}`;
}
