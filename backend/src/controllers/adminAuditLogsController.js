/**
 * Read-only audit log view — superadmin-only (see routes/adminAuditLogsRoutes.js).
 * Entries are written internally by other controllers (login, announcement
 * publish, broadcast send, version update, admin role/status change), never
 * directly through this router.
 */
import { listAuditLogs } from '../db/repositories/auditLogsRepo.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clamp(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toApiShape(row) {
  return {
    id: row.id,
    adminId: row.admin_id,
    adminEmail: row.admin_email,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at
  };
}

export function list(req, res) {
  const limit = clamp(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clamp(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const action = typeof req.query.action === 'string' ? req.query.action : undefined;

  const rows = listAuditLogs({ limit, offset, action });
  res.json({ logs: rows.map(toApiShape), limit, offset });
}
