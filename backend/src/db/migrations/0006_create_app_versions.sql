-- Wallet-app version control, per platform. Named app_versions rather than
-- wallet_versions deliberately — "wallet" already means a user's crypto
-- account elsewhere in this schema (analytics_events.wallet_id,
-- packages/crypto's wallet.js); this table is about the *application's*
-- version, a different concept.
--
-- One row per platform, upserted directly by admins (no draft/publish
-- workflow like announcements — a version config is either set or not, and
-- an edit takes effect immediately) and no history table (not asked for).
CREATE TABLE app_versions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL UNIQUE CHECK (platform IN ('web', 'extension', 'mobile')),
  latest_version TEXT NOT NULL,
  min_supported_version TEXT NOT NULL,
  update_message TEXT,
  updated_by TEXT NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
