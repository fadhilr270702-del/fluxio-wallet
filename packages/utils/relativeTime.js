/**
 * Formats a past epoch-millisecond timestamp as a short relative-time
 * string ("2m ago", "3h ago", ...) for the extension's Activity screen.
 * Pure and deterministic given an explicit `now` — callers that need a
 * real "current time" pass none (defaults to `Date.now()`); every test
 * passes one explicitly so results never depend on wall-clock time at
 * the moment the test happens to run.
 *
 * Deliberately coarse (minutes/hours/days/months/years, no seconds) and
 * deliberately static: this is computed once, server-side in
 * background.js, at the moment a history entry is fetched — same "no
 * timer, fetch on open + explicit refresh only" philosophy already used
 * for every balance/token value in this popup (see popup.js's own
 * comments on that). A string like "2m ago" does not tick forward to
 * "3m ago" while the popup sits open; refreshing the Activity screen is
 * what re-computes it.
 *
 * @param {number} timestampMs - epoch milliseconds, in the past (or now).
 * @param {number} [now] - epoch milliseconds to compare against; defaults to Date.now().
 * @returns {string}
 */
export function formatRelativeTime(timestampMs, now = Date.now()) {
  const diffMs = now - timestampMs;
  // A future timestamp (clock skew between this device and whatever
  // produced it, e.g. an on-chain blockTime) has no sensible "N units
  // ago" — shown the same as "just happened" rather than a negative
  // duration.
  if (diffMs <= 0) return 'just now';

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;

  // Cutoff for the months/years branch is checked on `diffDay` itself
  // (< 365), not on a `diffMonth < 12` re-derived from it — those two
  // checks can disagree right at the boundary (364 days is under a
  // year, but floor(364/30) is already 12), which would otherwise fall
  // through to the years branch and print "0y ago". Confirmed by hand
  // before shipping this, not just assumed correct.
  if (diffDay < 365) {
    const diffMonth = Math.floor(diffDay / 30);
    return `${diffMonth}mo ago`;
  }

  const diffYear = Math.floor(diffDay / 365);
  return `${diffYear}y ago`;
}
