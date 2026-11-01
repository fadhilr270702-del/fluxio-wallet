/**
 * The third unauthenticated, public-facing endpoint in this service (see
 * publicAnnouncementsController.js and publicEventsController.js for the
 * others). Purely computed from query params against app_versions — never
 * writes anything, never reads/stores/logs any caller-identifying value.
 * The strongest possible privacy stance of the three public routes: it
 * doesn't even persist the request.
 */
import { z } from 'zod';
import { findByPlatform } from '../db/repositories/appVersionsRepo.js';
import { compareVersions } from '../utils/compareVersions.js';
import { sanitizeRichHtml } from '../utils/richHtml.js';
import { HttpError } from '../utils/httpError.js';

/**
 * Prompt 0163 — same defensive read-time re-sanitization as
 * publicAnnouncementsController.js's own sanitizeForPublic; a 'plain' value
 * passes through untouched.
 */
function sanitizeForPublic(value, format) {
  if (format !== 'html') return value;
  return sanitizeRichHtml(value).html;
}

const PLATFORMS = ['web', 'extension', 'mobile'];
const versionString = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+$/, 'Must be in X.Y.Z format.');

const querySchema = z.object({
  platform: z.enum(PLATFORMS),
  currentVersion: versionString
});

export function check(req, res) {
  // Same format as validateBody's error shape (middleware/validate.js) —
  // duplicated here rather than shared since it targets req.query, not
  // req.body, and this is the only route in this service that validates a
  // query string.
  const result = querySchema.safeParse(req.query);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`).join('; ');
    throw new HttpError(400, 'VALIDATION_ERROR', detail);
  }
  const { platform, currentVersion } = result.data;

  const config = findByPlatform(platform);
  if (!config) {
    // No config for this platform yet — never block a wallet client just
    // because an admin hasn't set one up.
    return res.json({
      platform,
      currentVersion,
      latestVersion: null,
      minSupportedVersion: null,
      updateRequired: false,
      updateAvailable: false,
      updateMessage: null,
      updateMessageFormat: null
    });
  }

  // Prompt 0163 — updateMessageFormat is now REQUIRED in this response
  // shape (documented in backend/README.md and CLAUDE.md) — same rendering
  // contract as publicAnnouncementsController.js's own titleFormat/
  // bodyFormat: restricted rich HTML only (<b><i><u><s><a href="https://...">,
  // no <tg-emoji>), sanitized again here defensively, never rendered raw or
  // via unsanitized innerHTML.
  res.json({
    platform,
    currentVersion,
    latestVersion: config.latest_version,
    minSupportedVersion: config.min_supported_version,
    updateRequired: compareVersions(currentVersion, config.min_supported_version) < 0,
    updateAvailable: compareVersions(currentVersion, config.latest_version) < 0,
    updateMessage: sanitizeForPublic(config.update_message, config.update_message_format),
    updateMessageFormat: config.update_message_format
  });
}
