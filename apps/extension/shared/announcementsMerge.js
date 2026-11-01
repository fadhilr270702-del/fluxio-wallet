/**
 * Prompt 0170 — pure cache/merge logic for the notifications inbox.
 * `fresh` is this poll's already-platform/time-filtered server result
 * (see announcementsFilter.js); `cached` is whatever was persisted from
 * the previous successful poll. The server is always the source of truth
 * for CONTENT (an admin may have edited a title/body since the last
 * poll), but `firstSeenAt` — the local timestamp this announcement first
 * appeared in the inbox, used as its display date — must survive across
 * polls for an item that's still active, or every poll would otherwise
 * reset every "date" to "just now".
 *
 * An id present in `cached` but missing from `fresh` means the admin
 * unpublished or the schedule window expired since the last poll — it is
 * dropped outright, and its id is pruned from `readIds` too (an
 * unbounded-growth guard: `readIds` should never accumulate ids for
 * announcements that no longer exist anywhere).
 *
 * Deliberately free of any DOM/`chrome.*` reference (`now` is passed in),
 * same pattern as shared/announcementsFilter.js.
 *
 * @param {object} params
 * @param {Array} params.cached - previously persisted announcements, each with its own `firstSeenAt`.
 * @param {Array} params.fresh - this poll's filtered server result (no `firstSeenAt` yet).
 * @param {Array<string>} params.readIds - previously persisted read-id list.
 * @param {number} params.now - epoch ms, used as `firstSeenAt` for a genuinely new id.
 * @returns {{ announcements: Array, readIds: Array<string> }}
 */
export function mergeAnnouncementsCache({ cached, fresh, readIds, now }) {
  const cachedById = new Map((Array.isArray(cached) ? cached : []).map((a) => [a.id, a]));
  const freshList = Array.isArray(fresh) ? fresh : [];
  const freshIds = new Set(freshList.map((a) => a.id));

  const announcements = freshList.map((a) => ({
    ...a,
    firstSeenAt: cachedById.get(a.id)?.firstSeenAt ?? now
  }));

  const prunedReadIds = (Array.isArray(readIds) ? readIds : []).filter((id) => freshIds.has(id));

  return { announcements, readIds: prunedReadIds };
}
