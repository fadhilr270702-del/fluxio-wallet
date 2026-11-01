/**
 * Data access for `admin_sessions`. Callers pass/receive token *hashes*
 * only — hashing the raw token happens in utils/sessionToken.js, kept out
 * of this module so the repository layer never has to be trusted with the
 * raw secret either.
 */
import { randomUUID } from 'node:crypto';
import { lazyStatement } from '../client.js';
import { config } from '../../config/env.js';

const insertStmt = lazyStatement(`
  INSERT INTO admin_sessions (id, admin_id, token_hash, expires_at, created_at)
  VALUES (@id, @adminId, @tokenHash, @expiresAt, @now)
`);
const findByTokenHashStmt = lazyStatement('SELECT * FROM admin_sessions WHERE token_hash = ?');
const deleteByTokenHashStmt = lazyStatement('DELETE FROM admin_sessions WHERE token_hash = ?');
const deleteExpiredStmt = lazyStatement('DELETE FROM admin_sessions WHERE expires_at < ?');
const deleteForAdminExceptStmt = lazyStatement(
  'DELETE FROM admin_sessions WHERE admin_id = @adminId AND token_hash != @keepTokenHash'
);

export function createSession(adminId, tokenHash) {
  const id = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.session.ttlDays * 24 * 60 * 60 * 1000);
  insertStmt().run({
    id,
    adminId,
    tokenHash,
    expiresAt: expiresAt.toISOString(),
    now: now.toISOString()
  });
  return { id, expiresAt };
}

/** Returns the session row only if it exists AND hasn't expired; null otherwise. */
export function findValidSessionByTokenHash(tokenHash) {
  const session = findByTokenHashStmt().get(tokenHash);
  if (!session) return null;
  if (session.expires_at < new Date().toISOString()) return null;
  return session;
}

export function deleteSessionByTokenHash(tokenHash) {
  deleteByTokenHashStmt().run(tokenHash);
}

/** Best-effort housekeeping — safe to call periodically or on boot. */
export function deleteExpiredSessions() {
  deleteExpiredStmt().run(new Date().toISOString());
}

/**
 * Revokes every session this admin holds EXCEPT the one identified by
 * `keepTokenHash` — the change-password flow (prompt 0181): any other
 * device/browser that knew the old password is signed out immediately,
 * while the session that just proved the current password stays logged in.
 */
export function deleteAdminSessionsExcept(adminId, keepTokenHash) {
  deleteForAdminExceptStmt().run({ adminId, keepTokenHash });
}
