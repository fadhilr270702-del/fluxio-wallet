-- fluxio:manual-transaction
-- Prompt 0172 — widens announcements.target_platform to add 'mobile',
-- alongside the existing 'web'/'extension'/'all'. The project's own
-- platform vocabulary (Versions page, publicVersionRoutes) has always been
-- web/extension/mobile; announcements' own enum (migration 0003) simply
-- predated a mobile app existing as a concept in this schema and was never
-- updated. Data untouched — every existing row's target_platform value is
-- already one of 'web'/'extension'/'all', all still valid under the
-- widened constraint, so nothing about how an existing announcement
-- filters/displays changes.
--
-- SQLite can't ALTER a CHECK constraint in place — same rebuild pattern
-- migration 0008 already established and verified for this exact class of
-- change (telegram_broadcasts.status): create the new table with the
-- widened CHECK, copy every row across unchanged, drop the old table,
-- rename the new one into place, recreate its own index. No FK anywhere in
-- this schema references announcements.id (confirmed via grep across every
-- migration before writing this one), so PRAGMA foreign_keys=OFF isn't
-- strictly load-bearing here the way it was for 0008's own
-- telegram_broadcast_recipients FK — kept anyway for consistency with the
-- one proven-safe pattern this repo already has for a CHECK-widening
-- rebuild, rather than a second, subtly different variant.
--
-- `-- fluxio:manual-transaction` marker (see migrate.js/CLAUDE.md): needed
-- because PRAGMA foreign_keys is a documented no-op mid-transaction, and
-- migrate.js's default behavior always wraps a migration file in its own
-- BEGIN/COMMIT — this file supplies its own instead, autocommit-style.

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE announcements_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'critical')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  target_platform TEXT NOT NULL DEFAULT 'all' CHECK (target_platform IN ('web', 'extension', 'mobile', 'all')),
  starts_at TEXT,
  ends_at TEXT,
  created_by TEXT NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title_format TEXT NOT NULL DEFAULT 'plain' CHECK (title_format IN ('plain', 'html')),
  body_format TEXT NOT NULL DEFAULT 'plain' CHECK (body_format IN ('plain', 'html'))
);

INSERT INTO announcements_new (
  id, title, body, level, status, target_platform, starts_at, ends_at,
  created_by, created_at, updated_at, title_format, body_format
)
SELECT
  id, title, body, level, status, target_platform, starts_at, ends_at,
  created_by, created_at, updated_at, title_format, body_format
FROM announcements;

DROP TABLE announcements;
ALTER TABLE announcements_new RENAME TO announcements;

CREATE INDEX idx_announcements_status_schedule ON announcements(status, starts_at, ends_at);

COMMIT;

PRAGMA foreign_keys = ON;
