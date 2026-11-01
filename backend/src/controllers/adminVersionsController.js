/**
 * Protected app-version management — every handler here runs behind
 * requireAuth (see routes/adminVersionsRoutes.js), so `req.admin` is
 * always populated.
 */
import { upsertPlatformVersion, listAllPlatforms } from '../db/repositories/appVersionsRepo.js';
import { recordAuditLog } from '../db/repositories/auditLogsRepo.js';
import { HttpError } from '../utils/httpError.js';

const PLATFORMS = ['web', 'extension', 'mobile'];

function toApiShape(row) {
  return {
    id: row.id,
    platform: row.platform,
    latestVersion: row.latest_version,
    minSupportedVersion: row.min_supported_version,
    updateMessage: row.update_message,
    updateMessageFormat: row.update_message_format,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Always exactly 3 entries (one per platform) — see appVersionsRepo.js's listAllPlatforms. */
export function list(req, res) {
  res.json({ versions: listAllPlatforms().map(toApiShape) });
}

export function update(req, res) {
  const { platform } = req.params;
  if (!PLATFORMS.includes(platform)) {
    throw new HttpError(400, 'INVALID_PLATFORM', `platform must be one of: ${PLATFORMS.join(', ')}`);
  }

  const { latestVersion, minSupportedVersion, updateMessage, updateMessageFormat } = req.body;
  // updated_by is always stamped from the session, never trusted from the body.
  const row = upsertPlatformVersion({
    platform,
    latestVersion,
    minSupportedVersion,
    updateMessage,
    updateMessageFormat,
    updatedBy: req.admin.id
  });
  recordAuditLog({
    adminId: req.admin.id,
    action: 'version.update',
    targetType: 'app_version',
    targetId: platform,
    metadata: { latestVersion, minSupportedVersion }
  });
  res.json({ version: toApiShape(row) });
}
