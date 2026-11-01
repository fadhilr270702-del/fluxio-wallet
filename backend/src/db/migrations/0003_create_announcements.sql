-- One-way broadcast content. There is deliberately no "delivered to" /
-- "read by" / recipient table anywhere near this — announcements go out to
-- whoever polls the public endpoint, and nothing here ever records who that
-- was (see the public route handler for the enforcement of that).
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

CREATE INDEX idx_announcements_status_schedule ON announcements(status, starts_at, ends_at);
