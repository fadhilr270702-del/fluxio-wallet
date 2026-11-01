/**
 * Prompt 0163 — DB-backed test (same isolated-temp-SQLite-file pattern as
 * telegramEmojiPacksRepo.test.js), specifically for the one thing that
 * genuinely needs a real database to prove: migration 0021/0022's own
 * DEFAULT 'plain' behavior for a row/column that never explicitly
 * specified a format, PLUS the public controllers' response shape
 * (format fields present, html values re-sanitized defensively at read
 * time) — both need the real repo + controller + a real SQLite file behind
 * them, not just the zod schemas (already covered in
 * routes/test/announcementSchemas.test.js / versionSchemas.test.js).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let getDb;
let runMigrations;
let createAnnouncement;
let upsertPlatformVersion;
let listPublicAnnouncements;
let checkVersion;
let tempDir;

const ADMIN_ID = 'richtext-format-test-admin';

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-richtext-format-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');

  ({ getDb } = await import('../../client.js'));
  ({ runMigrations } = await import('../../migrate.js'));
  runMigrations();

  ({ createAnnouncement } = await import('../announcementsRepo.js'));
  ({ upsertPlatformVersion } = await import('../appVersionsRepo.js'));
  ({ listPublic: listPublicAnnouncements } = await import('../../../controllers/publicAnnouncementsController.js'));
  ({ check: checkVersion } = await import('../../../controllers/publicVersionController.js'));

  const now = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO admins (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ADMIN_ID, 'richtext-format-test@example.com', 'hash', 'superadmin', 1, now, now);
});

afterAll(() => {
  getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('GET /api/version — unconfigured platform (runs before any test below configures one)', () => {
  it('a never-configured platform returns updateMessageFormat: null alongside every other null field, never blocking the client', () => {
    // 'extension' is deliberately untouched by any test above this point —
    // migration 0022's own describe block (below) is the first to write a
    // row for it, so this genuinely exercises publicVersionController.js's
    // "no config yet" branch, not a platform some earlier test already
    // configured.
    const req = { query: { platform: 'extension', currentVersion: '1.0.0' } };
    const res = fakeRes();
    checkVersion(req, res);
    expect(res.body).toEqual({
      platform: 'extension',
      currentVersion: '1.0.0',
      latestVersion: null,
      minSupportedVersion: null,
      updateRequired: false,
      updateAvailable: false,
      updateMessage: null,
      updateMessageFormat: null
    });
  });
});

describe('migration 0021 — announcements.title_format/body_format default to plain', () => {
  it('a row inserted via raw SQL, omitting the new columns entirely, reads back as plain (the migration\'s own column DEFAULT, not app-layer logic)', () => {
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO announcements (id, title, body, level, status, target_platform, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'info', 'draft', 'all', ?, ?, ?)`
    ).run('legacy-row-1', 'Legacy title <b>literal</b>', 'Legacy body & literal', ADMIN_ID, now, now);
    const row = getDb().prepare('SELECT * FROM announcements WHERE id = ?').get('legacy-row-1');
    expect(row.title_format).toBe('plain');
    expect(row.body_format).toBe('plain');
  });

  it('createAnnouncement() defaults titleFormat/bodyFormat to plain when the caller omits them', () => {
    const row = createAnnouncement({
      title: 'No format specified',
      body: 'Body text',
      level: 'info',
      targetPlatform: 'all',
      startsAt: null,
      endsAt: null,
      createdBy: ADMIN_ID
    });
    expect(row.title_format).toBe('plain');
    expect(row.body_format).toBe('plain');
  });

  it('createAnnouncement() persists an explicit html format correctly', () => {
    const row = createAnnouncement({
      title: '<b>Bold</b>',
      body: '<i>Italic</i>',
      titleFormat: 'html',
      bodyFormat: 'html',
      level: 'info',
      targetPlatform: 'all',
      startsAt: null,
      endsAt: null,
      createdBy: ADMIN_ID
    });
    expect(row.title_format).toBe('html');
    expect(row.body_format).toBe('html');
  });
});

describe('migration 0022 — app_versions.update_message_format defaults to plain', () => {
  it('a row inserted via raw SQL, omitting the new column, reads back as plain', () => {
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO app_versions (id, platform, latest_version, min_supported_version, update_message, updated_by, created_at, updated_at)
       VALUES (?, 'mobile', '1.0.0', '1.0.0', 'Legacy <literal> message', ?, ?, ?)`
    ).run('legacy-version-row', ADMIN_ID, now, now);
    const row = getDb().prepare('SELECT * FROM app_versions WHERE id = ?').get('legacy-version-row');
    expect(row.update_message_format).toBe('plain');
  });

  it('upsertPlatformVersion() defaults updateMessageFormat to plain when omitted', () => {
    const row = upsertPlatformVersion({
      platform: 'extension',
      latestVersion: '2.0.0',
      minSupportedVersion: '1.0.0',
      updateMessage: 'No format specified',
      updatedBy: ADMIN_ID
    });
    expect(row.update_message_format).toBe('plain');
  });
});

describe('GET /api/announcements — response includes format fields, re-sanitized defensively', () => {
  it('includes titleFormat/bodyFormat for a plain announcement, values untouched', async () => {
    createAnnouncement({
      title: 'Plain <literal>',
      body: 'Plain & literal',
      level: 'info',
      targetPlatform: 'all',
      startsAt: null,
      endsAt: null,
      createdBy: ADMIN_ID
    });
    // Publish it directly via SQL (no controller for that exercised here — out of this test's scope).
    getDb().prepare("UPDATE announcements SET status = 'published' WHERE title = 'Plain <literal>'").run();

    const res = fakeRes();
    listPublicAnnouncements({ query: {} }, res);
    const found = res.body.announcements.find((a) => a.title === 'Plain <literal>');
    expect(found).toBeDefined();
    expect(found.titleFormat).toBe('plain');
    expect(found.bodyFormat).toBe('plain');
  });

  it('includes titleFormat/bodyFormat html and re-sanitizes the stored HTML defensively at read time', async () => {
    createAnnouncement({
      title: '<b>Bold</b>',
      body: '<i>Italic</i>',
      titleFormat: 'html',
      bodyFormat: 'html',
      level: 'info',
      targetPlatform: 'all',
      startsAt: null,
      endsAt: null,
      createdBy: ADMIN_ID
    });
    getDb().prepare("UPDATE announcements SET status = 'published' WHERE title = '<b>Bold</b>'").run();
    // Simulates a row that somehow got a disallowed tag past write-time
    // sanitization (defense in depth against a hypothetical bug/bypass, or
    // a row written directly via SQL) — the public read path must still
    // never leak it.
    getDb().prepare("UPDATE announcements SET body = '<i>Italic</i><script>evil()</script>' WHERE title = '<b>Bold</b>'").run();

    const res = fakeRes();
    listPublicAnnouncements({ query: {} }, res);
    const found = res.body.announcements.find((a) => a.title === '<b>Bold</b>');
    expect(found).toBeDefined();
    expect(found.titleFormat).toBe('html');
    expect(found.bodyFormat).toBe('html');
    expect(found.body).toBe('<i>Italic</i>'); // <script> stripped defensively at read time
  });
});

describe('GET /api/version — response includes updateMessageFormat, re-sanitized defensively', () => {
  it('includes updateMessageFormat for a plain-format version config', async () => {
    upsertPlatformVersion({
      platform: 'web',
      latestVersion: '3.0.0',
      minSupportedVersion: '1.0.0',
      updateMessage: 'Plain <literal> update',
      updatedBy: ADMIN_ID
    });
    const req = { query: { platform: 'web', currentVersion: '1.0.0' } };
    const res = fakeRes();
    checkVersion(req, res);
    expect(res.body.updateMessageFormat).toBe('plain');
    expect(res.body.updateMessage).toBe('Plain <literal> update');
  });

  it('includes updateMessageFormat html and re-sanitizes defensively at read time', async () => {
    upsertPlatformVersion({
      platform: 'mobile',
      latestVersion: '3.0.0',
      minSupportedVersion: '1.0.0',
      updateMessage: '<b>Bold</b><script>evil()</script>',
      updateMessageFormat: 'html',
      updatedBy: ADMIN_ID
    });
    const req = { query: { platform: 'mobile', currentVersion: '1.0.0' } };
    const res = fakeRes();
    checkVersion(req, res);
    expect(res.body.updateMessageFormat).toBe('html');
    expect(res.body.updateMessage).toBe('<b>Bold</b>'); // <script> stripped defensively
  });

});
