/**
 * Prompt 0170 — pure client-side defensive filtering for the notifications
 * inbox. `GET /api/announcements` (see backend/src/controllers/
 * publicAnnouncementsController.js) already filters server-side by
 * `status = 'published'` and the active `starts_at`/`ends_at` window
 * UNCONDITIONALLY, and by `target_platform` too WHEN a `platform` query
 * param other than `'all'` is passed — this file's own background.js
 * caller always passes `?platform=extension`, so both filters are already
 * applied server-side in the normal case. This module exists anyway as a
 * defensive second layer (the prompt's own explicit instruction: "kalau
 * server belum menyaring, klien menyaring; kalau sudah, klien tetap
 * defensif") — a clock-skew edge case, a future backend change, or a
 * caller that forgets the query param should never surface a stale/
 * wrong-platform announcement in the inbox.
 *
 * Deliberately free of any DOM/`chrome.*`/Date.now() reference — `now` is
 * always passed in by the caller — so this is plain-Vitest testable with
 * no mocking, same pattern as shared/swapAssetSources.js.
 *
 * @param {Array<{id:string, targetPlatform:string, startsAt:string|null, endsAt:string|null}>} rows
 * @param {{platform: string, now: number}} params - `now` is a epoch-ms timestamp; `startsAt`/`endsAt` are ISO-8601 strings (or null for open-ended), same shape the public API returns.
 * @returns {Array} the subset of `rows` whose targetPlatform is `platform` or `'all'`, and whose active window (if any) currently contains `now`.
 */
export function filterAnnouncementsForPlatform(rows, { platform, now }) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => {
    if (row.targetPlatform !== platform && row.targetPlatform !== 'all') return false;
    if (row.startsAt && new Date(row.startsAt).getTime() > now) return false;
    if (row.endsAt && new Date(row.endsAt).getTime() < now) return false;
    return true;
  });
}
