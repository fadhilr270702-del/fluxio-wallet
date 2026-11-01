/**
 * Prompt 0170 — pure unread-count and action-badge-text logic for the
 * notifications inbox. Split out of background.js the same way every
 * other piece of pure decision logic in this feature is (see
 * announcementsFilter.js/announcementsMerge.js's own header comments) so
 * it's plain-Vitest testable with no chrome.* mocking.
 */

/**
 * @param {Array<{id: string}>} announcements
 * @param {Array<string>} readIds
 * @returns {number}
 */
export function countUnread(announcements, readIds) {
  if (!Array.isArray(announcements)) return 0;
  const read = new Set(Array.isArray(readIds) ? readIds : []);
  return announcements.filter((a) => !read.has(a.id)).length;
}

/**
 * chrome.action.setBadgeText's own text, from an unread count: empty
 * string hides the badge entirely (Chrome's own documented behavior for
 * `setBadgeText({text: ''})`), 1-99 is the plain count, 100+ is capped at
 * "99+" so the badge never grows wide enough to crowd the toolbar icon
 * next to it.
 * @param {number} count
 * @returns {string}
 */
export function formatBadgeText(count) {
  if (!count || count <= 0) return '';
  if (count > 99) return '99+';
  return String(count);
}
