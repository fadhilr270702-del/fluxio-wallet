-- Telegram users/chats who have /start-ed the bot. chat_id is TEXT: channel
-- and supergroup chat IDs are large negative numbers that can exceed safe
-- integer range, so this is never stored as INTEGER (same reasoning as
-- every other id/timestamp column in this schema — see 0001/0002/0003).
CREATE TABLE telegram_subscribers (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  started_at TEXT NOT NULL,
  last_interaction_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_telegram_subscribers_active ON telegram_subscribers(is_active);

-- One row per compose-and-send action.
CREATE TABLE telegram_broadcasts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  media_url TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('channel', 'subscribers')),
  target_channel_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'completed', 'partial', 'failed')),
  total_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_by TEXT NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_telegram_broadcasts_status_created ON telegram_broadcasts(status, created_at);

-- Durable per-recipient queue for subscriber-targeted broadcasts ONLY — a
-- pending row IS a queued job; no separate job-queue library is used (no
-- Redis/Bull anywhere in this repo, SQLite is the only storage infra).
-- Channel-targeted broadcasts send synchronously inline and never get rows
-- here (a single message has no rate-limit concern).
CREATE TABLE telegram_broadcast_recipients (
  id TEXT PRIMARY KEY,
  broadcast_id TEXT NOT NULL REFERENCES telegram_broadcasts(id) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL REFERENCES telegram_subscribers(id),
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error_message TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_telegram_recipients_status_created ON telegram_broadcast_recipients(status, created_at);
CREATE INDEX idx_telegram_recipients_broadcast ON telegram_broadcast_recipients(broadcast_id, status);

-- Singleton row persisting the getUpdates long-poll offset across restarts.
-- No seed row here on purpose — every timestamp in this schema is computed
-- in JS (new Date().toISOString()), never via a SQL date function, so the
-- row is created lazily by telegramPollStateRepo.setOffset() on first write.
CREATE TABLE telegram_poll_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  update_offset INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
