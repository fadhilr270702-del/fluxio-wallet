/**
 * Gates every protected /admin/* route: reads the session cookie, hashes
 * it, and looks up a still-valid session + its admin. Anything short of a
 * fully valid, unexpired session for an active admin is a 401 — no route
 * behind this middleware ever runs its handler without `req.admin` set.
 *
 * This is the single piece of code "all admin endpoints are protected"
 * actually rests on; mounted once per protected router rather than
 * repeated per-handler, so there's one place to audit.
 */
import { config } from '../config/env.js';
import { hashSessionToken } from '../utils/sessionToken.js';
import { findValidSessionByTokenHash } from '../db/repositories/sessionsRepo.js';
import { findAdminById } from '../db/repositories/adminsRepo.js';
import { HttpError } from '../utils/httpError.js';

export function requireAuth(req, res, next) {
  const token = req.cookies?.[config.session.cookieName];
  if (!token) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'No session cookie present.');
  }

  const session = findValidSessionByTokenHash(hashSessionToken(token));
  if (!session) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Session is missing, expired, or was revoked.');
  }

  const admin = findAdminById(session.admin_id);
  if (!admin) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Session belongs to an admin that no longer exists or is inactive.');
  }

  req.admin = admin;
  req.sessionToken = token;
  next();
}
