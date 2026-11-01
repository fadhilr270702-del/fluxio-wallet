/**
 * Small pure helpers for interpreting an announcement's schedule — used by
 * both the table (to show "scheduled" / "expired" hints next to the raw
 * draft/published badge) and the form. This is display-only logic; the
 * authoritative "is this active" check lives server-side in
 * backend/src/db/repositories/announcementsRepo.js's listPublicActiveAnnouncements query.
 */
export function scheduleHint(announcement) {
  const now = Date.now();
  const starts = announcement.startsAt ? Date.parse(announcement.startsAt) : null;
  const ends = announcement.endsAt ? Date.parse(announcement.endsAt) : null;

  if (announcement.status !== 'published') return null;
  if (starts && starts > now) return 'Scheduled — not yet visible';
  if (ends && ends < now) return 'Expired — no longer visible';
  return null;
}

export const LEVEL_OPTIONS = ['info', 'warning', 'critical'];

// Prompt 0172 — 'mobile' added (backend migration 0025 widens the matching
// target_platform CHECK constraint the same way), and this exact display
// order — All platforms, Browser extension, Mobile app, Web app — is the
// user's own explicit choice for the form dropdown, not alphabetical or
// insertion order. Stored value is always the raw lowercase code
// (`AnnouncementForm.jsx`'s <option value={t}>), never the label.
export const TARGET_OPTIONS = ['all', 'extension', 'mobile', 'web'];

const TARGET_PLATFORM_LABELS = {
  all: 'All platforms',
  extension: 'Browser extension',
  mobile: 'Mobile app',
  web: 'Web app'
};

/**
 * The one shared human-readable label for a target_platform code — used by
 * both AnnouncementForm.jsx's dropdown options and AnnouncementTable.jsx's
 * TARGET column, so the two can never drift into showing different wording
 * for the same code. An unrecognized code (defensive — the backend's own
 * zod enum should make this unreachable in practice) falls back to the raw
 * code itself rather than throwing or rendering blank.
 */
export function targetPlatformLabel(code) {
  return TARGET_PLATFORM_LABELS[code] || code;
}
