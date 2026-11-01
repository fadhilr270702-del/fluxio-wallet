/**
 * Login / logout / "who am I" (session check). Issues and revokes the
 * opaque session cookie — see utils/sessionToken.js and
 * db/repositories/sessionsRepo.js for the mechanics.
 */
import { config } from '../config/env.js';
import { findAdminByEmail, toPublicAdmin, updateAdminPasswordHash } from '../db/repositories/adminsRepo.js';
import { createSession, deleteSessionByTokenHash, deleteAdminSessionsExcept } from '../db/repositories/sessionsRepo.js';
import { recordAuditLog } from '../db/repositories/auditLogsRepo.js';
import { generateSessionToken, hashSessionToken } from '../utils/sessionToken.js';
import { verifyPassword, hashPassword } from '../utils/password.js';
import { HttpError } from '../utils/httpError.js';

function cookieOptions(expiresAt) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.session.cookieSecure,
    expires: expiresAt,
    path: '/'
  };
}

export async function login(req, res) {
  const { email, password } = req.body;

  const admin = findAdminByEmail(email);
  // Same generic error whether the email doesn't exist or the password is
  // wrong — doesn't reveal which one to a caller probing for valid emails.
  if (!admin || !(await verifyPassword(password, admin.password_hash))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
  }

  const token = generateSessionToken();
  const { expiresAt } = createSession(admin.id, hashSessionToken(token));

  res.cookie(config.session.cookieName, token, cookieOptions(expiresAt));
  recordAuditLog({ adminId: admin.id, action: 'admin.login' });
  res.json({ admin: toPublicAdmin(admin) });
}

export function logout(req, res) {
  if (req.sessionToken) {
    deleteSessionByTokenHash(hashSessionToken(req.sessionToken));
  }
  res.clearCookie(config.session.cookieName, { path: '/' });
  res.status(204).end();
}

export function session(req, res) {
  // requireAuth already ran and populated req.admin — reaching here means
  // the session is valid.
  res.json({ admin: toPublicAdmin(req.admin) });
}

/**
 * Self-service change password (prompt 0181) — the first and only way a
 * password ever changes after scripts/createAdmin.js creates the account.
 * requireAuth ran already (req.admin is the raw row, hash included; no
 * requireRole — editors need this exactly as much as superadmins), and the
 * zod layer (schemas/accountSchemas.js) already enforced newPassword's
 * shape, so this only does the parts that need the database:
 * re-prove the CURRENT password, swap the hash, and revoke every OTHER
 * session this admin holds — a device that knew the old password is out,
 * while the session that just proved it stays in.
 */
export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;

  // Same generic error code as login — wrong current password reveals
  // nothing beyond "credentials didn't check out."
  if (!(await verifyPassword(currentPassword, req.admin.password_hash))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
  }

  updateAdminPasswordHash(req.admin.id, await hashPassword(newPassword));
  deleteAdminSessionsExcept(req.admin.id, hashSessionToken(req.sessionToken));
  // Minimal by design: who + what + when. Never the password, never a hash.
  recordAuditLog({ adminId: req.admin.id, action: 'admin.password_changed' });
  // 204, matching logout's own precedent in this same controller.
  res.status(204).end();
}
