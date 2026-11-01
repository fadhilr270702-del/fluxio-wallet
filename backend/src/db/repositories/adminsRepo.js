/**
 * Data access for the `admins` table. Never returns `password_hash` from
 * the "public" shape helpers — callers that genuinely need the hash (only
 * the login flow does) read the raw row directly.
 */
import { randomUUID } from 'node:crypto';
import { getDb, lazyStatement } from '../client.js';

const insertStmt = lazyStatement(`
  INSERT INTO admins (id, email, password_hash, role, is_active, created_at, updated_at)
  VALUES (@id, @email, @passwordHash, @role, 1, @now, @now)
`);
const findByEmailStmt = lazyStatement('SELECT * FROM admins WHERE email = ? AND is_active = 1');
const findByIdStmt = lazyStatement('SELECT * FROM admins WHERE id = ? AND is_active = 1');
const findByIdAnyStmt = lazyStatement('SELECT * FROM admins WHERE id = ?');
const listAllStmt = lazyStatement('SELECT * FROM admins ORDER BY created_at ASC');
const updatePasswordHashStmt = lazyStatement(
  'UPDATE admins SET password_hash = @passwordHash, updated_at = @now WHERE id = @id'
);

/**
 * @param {{ email: string, passwordHash: string, role?: 'superadmin'|'editor' }} input
 * @returns {object} the created admin row (including password_hash — caller decides what to expose)
 */
export function createAdmin({ email, passwordHash, role = 'superadmin' }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertStmt().run({ id, email, passwordHash, role, now });
  return findByIdStmt().get(id);
}

export function findAdminByEmail(email) {
  return findByEmailStmt().get(email) ?? null;
}

export function findAdminById(id) {
  return findByIdStmt().get(id) ?? null;
}

/** Unlike findAdminById, doesn't filter to is_active=1 — admin management needs to find a deactivated account too (to reactivate it). */
export function findAdminByIdAny(id) {
  return findByIdAnyStmt().get(id) ?? null;
}

/** Every admin, active or not, oldest first — for the admin-management list view. */
export function listAdmins() {
  return listAllStmt().all();
}

/**
 * The ONE way a password hash ever changes after account creation (prompt
 * 0181, self-service change password). Deliberately its own function
 * rather than a new field on updateAdmin() below — that function's own
 * contract ("never email/password") guards the admin-management endpoint
 * from ever being able to set someone else's password, and folding this in
 * would quietly dissolve that guarantee.
 */
export function updateAdminPasswordHash(id, passwordHash) {
  updatePasswordHashStmt().run({ id, passwordHash, now: new Date().toISOString() });
}

/** Partial update — only role and/or is_active are ever settable this way (never email/password). */
export function updateAdmin(id, { role, isActive }) {
  const sets = [];
  const params = { id, now: new Date().toISOString() };
  if (role !== undefined) {
    sets.push('role = @role');
    params.role = role;
  }
  if (isActive !== undefined) {
    sets.push('is_active = @isActive');
    params.isActive = isActive ? 1 : 0;
  }
  if (sets.length === 0) return findAdminByIdAny(id);
  getDb().prepare(`UPDATE admins SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
  return findAdminByIdAny(id);
}

/** Shape safe to send to the client — never includes password_hash. */
export function toPublicAdmin(admin) {
  if (!admin) return null;
  return { id: admin.id, email: admin.email, role: admin.role };
}
