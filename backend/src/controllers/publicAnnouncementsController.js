/**
 * The one unauthenticated, public-facing endpoint in this service — what
 * the wallet apps will eventually poll. Reads only `req.query.platform`
 * (which chain/app the caller wants announcements for); nothing about the
 * caller's identity (no IP, no user-agent, no wallet address) is read,
 * stored, or logged anywhere in this path. See routes/publicAnnouncementsRoutes.js
 * for the standing "no logging middleware on this route" guarantee.
 */
import { listPublicActiveAnnouncements } from '../db/repositories/announcementsRepo.js';
import { sanitizeRichHtml } from '../utils/richHtml.js';

// Prompt 0172 — 'mobile' added. Behavior for an unrecognized value is
// unchanged (falls back to 'all' below, never a 400) — this set only grows
// which values count as recognized, it never touches that fallback
// contract itself.
const VALID_PLATFORMS = new Set(['web', 'extension', 'mobile', 'all']);

/**
 * Prompt 0163 — an 'html'-format value is re-sanitized here too, not just
 * at write time (adminAnnouncementsRoutes.js's own sanitizeHtmlFieldsIfNeeded)
 * — the same "defensive two-layer" posture sanitizeTelegramHtml() already
 * has for broadcasts (re-sanitized again at send time). A 'plain' value
 * passes through completely untouched.
 */
function sanitizeForPublic(value, format) {
  if (format !== 'html') return value;
  return sanitizeRichHtml(value).html;
}

export function listPublic(req, res) {
  const platformParam = typeof req.query.platform === 'string' ? req.query.platform : 'all';
  const platform = VALID_PLATFORMS.has(platformParam) ? platformParam : 'all';

  const rows = listPublicActiveAnnouncements({ platform });
  // Intentionally excludes createdBy/id-of-author — nothing internal leaks
  // through the public shape.
  //
  // Prompt 0163 — titleFormat/bodyFormat are now REQUIRED in this response
  // shape (documented in backend/README.md and CLAUDE.md): any future
  // consumer of this endpoint must render title/body as restricted rich
  // HTML (only <b><i><u><s><a href="https://...">, the exact
  // sanitizeRichHtml() whitelist — no <tg-emoji>, this isn't Telegram) using
  // that SAME whitelist, never dangerouslySetInnerHTML/innerHTML without
  // sanitizing first, and never display the raw HTML string as literal text
  // when format is 'html'.
  res.json({
    announcements: rows.map((row) => ({
      id: row.id,
      title: sanitizeForPublic(row.title, row.title_format),
      body: sanitizeForPublic(row.body, row.body_format),
      titleFormat: row.title_format,
      bodyFormat: row.body_format,
      level: row.level,
      targetPlatform: row.target_platform,
      startsAt: row.starts_at,
      endsAt: row.ends_at
    }))
  });
}
