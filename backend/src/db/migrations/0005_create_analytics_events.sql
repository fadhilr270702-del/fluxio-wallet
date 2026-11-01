-- Event ingestion for aggregate/anonymous analytics. wallet_id is a random
-- ID generated client-side — no column here or anywhere else in this schema
-- maps it to an on-chain address or public key. Hard constraint, mirrors
-- the non-custodial posture already established for announcements/telegram.
--
-- `event` is deliberately NOT CHECK-constrained (unlike every other enum in
-- this schema) — WALLET_CREATED strongly implies more event types will
-- follow, and a CHECK would force a migration per new event type. The
-- known set (WALLET_CREATED only, for now) is validated at the zod layer
-- instead (routes/publicEventsRoutes.js). `platform` stays CHECK-constrained
-- — a genuinely closed, stable set.
CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('web', 'extension', 'mobile')),
  -- Client-reported event time, normalized server-side to strict UTC
  -- ISO-8601 via new Date(timestamp).toISOString() before storage — the
  -- payload's raw `timestamp` is parseable-but-not-necessarily-canonical,
  -- and the day-bucketing query (analyticsEventsRepo.js) assumes a
  -- canonical YYYY-MM-DDTHH:MM:SS.sssZ shape (substr(occurred_at,1,10)).
  occurred_at TEXT NOT NULL,
  -- Server receipt time, computed in JS — same convention as every other
  -- created_at in this schema.
  created_at TEXT NOT NULL,
  -- Idempotency: a retried WALLET_CREATED beacon for the same wallet must
  -- not create a second row (see analyticsEventsRepo.js's ON CONFLICT DO
  -- NOTHING). Assumes WALLET_CREATED is one-time-per-wallet — a future
  -- recurring event type needs its own dedup key, not this constraint.
  UNIQUE (event, wallet_id)
);
CREATE INDEX idx_analytics_events_event_occurred ON analytics_events(event, occurred_at);
CREATE INDEX idx_analytics_events_event_platform ON analytics_events(event, platform);

-- One row per chain reported in a single event's chains array. Normalized,
-- not JSON-in-TEXT (no precedent for that anywhere in this schema) — makes
-- "most popular chain" a plain indexed GROUP BY.
--
-- chain is hardcoded to the 4 current values (a SQL CHECK can't reference a
-- JS import) — must stay in sync with packages/constants/networks.js's
-- NETWORK_KEYS if that set ever changes.
CREATE TABLE analytics_event_chains (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES analytics_events(id) ON DELETE CASCADE,
  chain TEXT NOT NULL CHECK (chain IN ('solana', 'ethereum', 'bnb', 'base')),
  created_at TEXT NOT NULL,
  -- Defensive: a duplicate chain within one payload's array (["solana","solana"])
  -- shouldn't double-count for that event.
  UNIQUE (event_id, chain)
);
CREATE INDEX idx_analytics_event_chains_chain ON analytics_event_chains(chain);
