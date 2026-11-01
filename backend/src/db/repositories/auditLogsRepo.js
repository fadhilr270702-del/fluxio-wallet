/**
 * Data access for `audit_logs`. `recordAuditLog` is called from other
 * controllers (login, announcement publish, broadcast send, version
 * update, admin role/status change) right after their primary action
 * succeeds — it deliberately never throws, so a logging failure can never
 * block the action it's recording.
 */
import { randomUUID } from 'node:crypto';
import { getDb, lazyStatement } from '../client.js';

const insertStmt = lazyStatement(`
  INSERT INTO audit_logs (id, admin_id, action, target_type, target_id, metadata, created_at)
  VALUES (@id, @adminId, @action, @targetType, @targetId, @metadata, @now)
`);

export function recordAuditLog({ adminId, action, targetType = null, targetId = null, metadata = null }) {
  try {
    insertStmt().run({
      id: randomUUID(),
      adminId,
      action,
      targetType,
      targetId,
      metadata: metadata ? JSON.stringify(metadata) : null,
      now: new Date().toISOString()
    });
  } catch (err) {
    // Never throws up to the caller — a logging failure must never block
    // the login/publish/send/update it was trying to record.
    console.error('[audit] failed to record log entry:', err);
  }
}

export function listAuditLogs({ limit = 50, offset = 0, action } = {}) {
  const clauses = [];
  const params = { limit, offset };
  if (action) {
    clauses.push('audit_logs.action = @action');
    params.action = action;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb()
    .prepare(
      `SELECT audit_logs.*, admins.email AS admin_email
       FROM audit_logs
       JOIN admins ON admins.id = audit_logs.admin_id
       ${where}
       ORDER BY audit_logs.created_at DESC
       LIMIT @limit OFFSET @offset`
    )
    .all(params);
}
