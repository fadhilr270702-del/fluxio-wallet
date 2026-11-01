/**
 * Pure helpers for AnalyticsPage (prompt 0235) — framework free and
 * side-effect free, same convention as dashboardHelpers.js.
 */

/**
 * The highest-count ATTRIBUTED source row (source non null) across the
 * summary's telegramSubscribersBySource rows, or null when nothing is
 * attributed yet. Organic rows are deliberately excluded — "Top source"
 * answers "which campaign", and organic is the absence of one.
 */
export function topSource(rows) {
  const attributed = (rows || []).filter((row) => row.source !== null && row.source !== undefined);
  if (attributed.length === 0) return null;
  return attributed.reduce((best, row) => (row.count > best.count ? row : best));
}

/** The by-source rows mapped to RankedBarList items — labels verbatim (no capitalization anywhere, see the 0233 cosmetic note), trial-bot rows suffixed so the official numbers stay unambiguous. */
export function subscribersBySourceItems(rows) {
  return (rows || []).map((row) => ({
    key: `${row.botId}:${row.source ?? 'organic'}`,
    label: `${row.source ?? 'organic'}${row.botId === 'official' ? '' : ` (${row.botId} bot)`}`,
    count: row.count
  }));
}
