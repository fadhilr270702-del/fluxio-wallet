/**
 * Prompt 0181 — endpoint tests for the self-service change password
 * (PATCH /admin/me/password). Same isolated-temp-DB + real-session pattern
 * as adminAnalyticsSummary.test.js (prompt 0180): createApp() on an
 * ephemeral port, a REAL admin + sessions built through the real repos
 * (never a mocked requireAuth), and real fetches. The real dev database is
 * never opened (prompt 0167's standing lesson).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OLD_PASSWORD = 'old-password-123';
const NEW_PASSWORD = 'new-password-456';

let createApp;
let getDb;
let config;
let verifyPassword;
let findAdminByIdAny;
let findValidSessionByTokenHash;
let hashSessionToken;
let listAuditLogs;
let admin;
let currentToken;
let otherDeviceToken;
let tempDir;
let server;
let baseUrl;

function cookieFor(token) {
  return `${config.session.cookieName}=${token}`;
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-change-password-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');

  const { runMigrations } = await import('../../db/migrate.js');
  runMigrations();
  ({ getDb } = await import('../../db/client.js'));
  ({ config } = await import('../../config/env.js'));

  const adminsRepo = await import('../../db/repositories/adminsRepo.js');
  ({ findAdminByIdAny } = adminsRepo);
  const sessionsRepo = await import('../../db/repositories/sessionsRepo.js');
  ({ findValidSessionByTokenHash } = sessionsRepo);
  const tokens = await import('../../utils/sessionToken.js');
  ({ hashSessionToken } = tokens);
  const passwords = await import('../../utils/password.js');
  ({ verifyPassword } = passwords);
  ({ listAuditLogs } = await import('../../db/repositories/auditLogsRepo.js'));

  // A real admin with a REAL bcrypt hash of the old password (the endpoint
  // verifies it for real), plus two real sessions: "this device" and a
  // second, older "other device" that must be revoked by a successful change.
  admin = adminsRepo.createAdmin({
    email: 'change-password-test@example.com',
    passwordHash: await passwords.hashPassword(OLD_PASSWORD),
  });
  currentToken = tokens.generateSessionToken();
  sessionsRepo.createSession(admin.id, hashSessionToken(currentToken));
  otherDeviceToken = tokens.generateSessionToken();
  sessionsRepo.createSession(admin.id, hashSessionToken(otherDeviceToken));

  ({ createApp } = await import('../../app.js'));
  server = createApp().listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

function patchPassword({ cookie, body }) {
  return fetch(`${baseUrl}/admin/me/password`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe('PATCH /admin/me/password', () => {
  it('rejects a request with no session cookie (401)', async () => {
    const res = await patchPassword({
      body: { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong current password (401) without touching the hash or any session', async () => {
    const res = await patchPassword({
      cookie: cookieFor(currentToken),
      body: { currentPassword: 'not-the-password', newPassword: NEW_PASSWORD },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_CREDENTIALS');

    // Hash unchanged: the OLD password still verifies.
    const row = findAdminByIdAny(admin.id);
    expect(await verifyPassword(OLD_PASSWORD, row.password_hash)).toBe(true);
    // Both sessions still valid.
    expect(findValidSessionByTokenHash(hashSessionToken(currentToken))).not.toBeNull();
    expect(findValidSessionByTokenHash(hashSessionToken(otherDeviceToken))).not.toBeNull();
  });

  it('rejects a new password shorter than 8 characters (400)', async () => {
    const res = await patchPassword({
      cookie: cookieFor(currentToken),
      body: { currentPassword: OLD_PASSWORD, newPassword: 'short7!' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a new password identical to the current one (400)', async () => {
    const res = await patchPassword({
      cookie: cookieFor(currentToken),
      body: { currentPassword: OLD_PASSWORD, newPassword: OLD_PASSWORD },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('changes the password, keeps this session, revokes the other one, and records the audit row', async () => {
    const res = await patchPassword({
      cookie: cookieFor(currentToken),
      body: { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.status).toBe(204);

    // Hash really swapped: new verifies, old no longer does.
    const row = findAdminByIdAny(admin.id);
    expect(await verifyPassword(NEW_PASSWORD, row.password_hash)).toBe(true);
    expect(await verifyPassword(OLD_PASSWORD, row.password_hash)).toBe(false);

    // The other device's session is gone; this one survives — proven both
    // at the repo level and through the real endpoint.
    expect(findValidSessionByTokenHash(hashSessionToken(otherDeviceToken))).toBeNull();
    expect(findValidSessionByTokenHash(hashSessionToken(currentToken))).not.toBeNull();
    const otherDeviceCheck = await fetch(`${baseUrl}/admin/session`, {
      headers: { cookie: cookieFor(otherDeviceToken) },
    });
    expect(otherDeviceCheck.status).toBe(401);
    const currentCheck = await fetch(`${baseUrl}/admin/session`, {
      headers: { cookie: cookieFor(currentToken) },
    });
    expect(currentCheck.status).toBe(200);

    // Audit row exists, minimal by design (no metadata — never a password).
    const entries = listAuditLogs({ action: 'admin.password_changed' });
    expect(entries).toHaveLength(1);
    expect(entries[0].admin_id).toBe(admin.id);
    expect(entries[0].metadata).toBeNull();
  });
});
