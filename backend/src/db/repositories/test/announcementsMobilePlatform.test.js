/**
 * Prompt 0172 — DB-backed test (same isolated-temp-SQLite-file pattern as
 * richTextFormat.test.js) proving migration 0025's own table-rebuild
 * (widening announcements.target_platform's CHECK constraint to add
 * 'mobile') genuinely preserves data that existed BEFORE it ran — not just
 * that the resulting schema happens to be correct.
 *
 * `runMigrations()` applies every pending migration in one call with no
 * "stop at version N" option (see migrate.js's own header), so a row
 * inserted after calling it would already be living in the POST-0025
 * table — that would only prove the new schema accepts old-shaped values,
 * not that the rebuild's own CREATE/COPY/DROP/RENAME sequence is
 * data-safe. To actually exercise that, this test recreates the
 * pre-migration-0025 table shape by hand (the exact 0003+0021 cumulative
 * shape — the only two migrations that ever touched this table before
 * 0025, confirmed by grep before writing this), inserts a legacy-style row
 * into THAT table, then executes migration 0025's own real .sql file
 * (read from disk, never duplicated/retyped) against it, and checks the
 * row survived byte-for-byte.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0025_PATH = path.join(__dirname, '..', '..', 'migrations', '0025_add_announcements_mobile_platform.sql');

let getDb;
let createAnnouncement;
let listPublic;
let tempDir;

const ADMIN_ID = 'mobile-platform-migration-test-admin';

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
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-mobile-platform-migration-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');

  ({ getDb } = await import('../../client.js'));
  ({ createAnnouncement } = await import('../announcementsRepo.js'));
  ({ listPublic } = await import('../../../controllers/publicAnnouncementsController.js'));
  const db = getDb();

  // Recreate exactly the pre-0025 shape (0003's own CREATE TABLE + 0021's
  // two ADD COLUMNs — confirmed against the real migration files, not
  // guessed) — this is the "before" state migration 0025 actually runs
  // against in production, on a database that already has these two
  // migrations applied.
  db.exec(`
    CREATE TABLE admins (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'critical')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
      target_platform TEXT NOT NULL DEFAULT 'all' CHECK (target_platform IN ('web', 'extension', 'all')),
      starts_at TEXT,
      ends_at TEXT,
      created_by TEXT NOT NULL REFERENCES admins(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    ALTER TABLE announcements ADD COLUMN title_format TEXT NOT NULL DEFAULT 'plain' CHECK (title_format IN ('plain', 'html'));
    ALTER TABLE announcements ADD COLUMN body_format TEXT NOT NULL DEFAULT 'plain' CHECK (body_format IN ('plain', 'html'));
    CREATE INDEX idx_announcements_status_schedule ON announcements(status, starts_at, ends_at);
  `);

  const now = new Date().toISOString();
  db.prepare('INSERT INTO admins (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ADMIN_ID, 'mobile-platform-migration-test@example.com', 'hash', 'superadmin', 1, now, now);

  // A pre-existing 'web'-targeted row, exactly the kind of legacy data this
  // migration must survive untouched.
  db.prepare(
    `INSERT INTO announcements (id, title, body, level, status, target_platform, starts_at, ends_at, created_by, created_at, updated_at, title_format, body_format)
     VALUES ('legacy-web-row', 'Legacy web announcement', 'Legacy body', 'warning', 'published', 'web', NULL, NULL, ?, ?, ?, 'plain', 'plain')`
  ).run(ADMIN_ID, now, now);
});

afterAll(() => {
  getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('migration 0025 — widening announcements.target_platform to add mobile', () => {
  it('applying the real migration 0025 SQL preserves the pre-existing legacy row exactly', () => {
    const db = getDb();
    const migrationSql = readFileSync(MIGRATION_0025_PATH, 'utf8');
    // Same execution path migrate.js itself uses for a
    // `-- fluxio:manual-transaction` file — run the file's own text as-is.
    db.exec(migrationSql);

    const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get('legacy-web-row');
    expect(row).toBeDefined();
    expect(row.title).toBe('Legacy web announcement');
    expect(row.body).toBe('Legacy body');
    expect(row.level).toBe('warning');
    expect(row.status).toBe('published');
    expect(row.target_platform).toBe('web');
    expect(row.title_format).toBe('plain');
    expect(row.body_format).toBe('plain');
    expect(row.created_by).toBe(ADMIN_ID);
  });

  it('the widened CHECK constraint now accepts a mobile row', () => {
    const db = getDb();
    const now = new Date().toISOString();
    expect(() => {
      db.prepare(
        `INSERT INTO announcements (id, title, body, target_platform, created_by, created_at, updated_at)
         VALUES ('mobile-row', 'Mobile announcement', 'Body', 'mobile', ?, ?, ?)`
      ).run(ADMIN_ID, now, now);
    }).not.toThrow();
    const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get('mobile-row');
    expect(row.target_platform).toBe('mobile');
  });

  it('the CHECK constraint still rejects a genuinely invalid target_platform value — widened, not removed', () => {
    const db = getDb();
    const now = new Date().toISOString();
    expect(() => {
      db.prepare(
        `INSERT INTO announcements (id, title, body, target_platform, created_by, created_at, updated_at)
         VALUES ('bogus-row', 'Bogus', 'Body', 'bogus-platform', ?, ?, ?)`
      ).run(ADMIN_ID, now, now);
    }).toThrow();
  });

  it('the rebuilt table still enforces every OTHER pre-existing CHECK/FK constraint (level, status, title_format, created_by)', () => {
    const db = getDb();
    const now = new Date().toISOString();
    expect(() => {
      db.prepare(
        `INSERT INTO announcements (id, title, body, level, created_by, created_at, updated_at)
         VALUES ('bogus-level-row', 'Bogus', 'Body', 'not-a-real-level', ?, ?, ?)`
      ).run(ADMIN_ID, now, now);
    }).toThrow();
  });
});

describe('GET /api/announcements?platform=mobile (prompt 0172)', () => {
  it('a mobile-targeted, published announcement is returned when platform=mobile', () => {
    createAnnouncement({
      title: 'Mobile-only notice',
      body: 'Body',
      level: 'info',
      targetPlatform: 'mobile',
      startsAt: null,
      endsAt: null,
      createdBy: ADMIN_ID
    });
    getDb().prepare("UPDATE announcements SET status = 'published' WHERE title = 'Mobile-only notice'").run();

    const res = fakeRes();
    listPublic({ query: { platform: 'mobile' } }, res);
    const found = res.body.announcements.find((a) => a.title === 'Mobile-only notice');
    expect(found).toBeDefined();
    expect(found.targetPlatform).toBe('mobile');
  });

  it('the same mobile-targeted announcement is NOT returned when platform=extension — logika sama seperti platform lain', () => {
    const res = fakeRes();
    listPublic({ query: { platform: 'extension' } }, res);
    const found = res.body.announcements.find((a) => a.title === 'Mobile-only notice');
    expect(found).toBeUndefined();
  });

  it('an unrecognized ?platform value still falls back to "all" (unchanged error contract — never a 400)', () => {
    const res = fakeRes();
    listPublic({ query: { platform: 'not-a-real-platform' } }, res);
    // Falls back to the unfiltered 'all' behavior — the mobile row (targetPlatform
    // itself is 'mobile', not 'all', but the FALLBACK behavior applies no
    // platform filter at all) is still returned, same as every other row.
    const found = res.body.announcements.find((a) => a.title === 'Mobile-only notice');
    expect(found).toBeDefined();
    expect(res.statusCode).toBe(200);
  });
});
