-- Prompt 0234 (P3) — per-round bookkeeping for recurring broadcasts, the
-- thing the production incident proved was missing: a round interrupted by
-- a transport error (or a worker restart/deactivation) used to leave NO
-- trace at all, so the retry re-sent the whole round from scratch — 9.317
-- real subscribers received the same message twice on 26 Oktober 2026.
--
-- One row per attempted round. `finished_at` NULL = the round is still
-- open (in flight, or interrupted); the worker resumes an open round from
-- its cursor instead of starting over. The cursor is the (started_at, id)
-- pair of the last subscriber this round has already ATTEMPTED (delivered,
-- or answered with a per-recipient error by Telegram — neither may ever be
-- re-attempted on resume), valid because the send order is deterministic:
-- listActiveSubscribers orders by started_at ASC, id ASC (the id tie break
-- exists precisely so two subscribers with identical started_at resume
-- correctly — see telegramSubscribersRepo.js).
--
-- cursor_subscriber_id and resume_skip_json are two deliberate columns
-- BEYOND the design sketch's own list (which named only cursor_started_at),
-- both needed to honor the sketch's own stricter requirement ("satu
-- subscriber tidak pernah menerima dua kali dalam satu putaran"):
--  * cursor_subscriber_id — started_at alone is ambiguous when two
--    subscribers share a timestamp; resuming strictly after it would skip
--    the second, resuming at-or-after would double the first. The id tie
--    break closes both.
--  * resume_skip_json — with P5's parallel sends (up to 10 in flight), a
--    transport failure can leave a GAP: sends launched after the failing
--    one may still have been delivered. The contiguous cursor cannot
--    express that hole, so the ids delivered BEYOND the cursor (at most
--    concurrency minus one of them) are persisted here and skipped on
--    resume — without this, every interrupted parallel round could double
--    up to 9 subscribers.
--
-- Plain CREATE TABLE, no CHECK rebuild — default wrapped migration path.
CREATE TABLE telegram_recurring_rounds (
  id TEXT PRIMARY KEY,
  broadcast_id TEXT NOT NULL REFERENCES telegram_broadcasts(id),
  round_no INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  cursor_started_at TEXT,
  cursor_subscriber_id TEXT,
  resume_skip_json TEXT,
  UNIQUE (broadcast_id, round_no)
);

CREATE INDEX idx_recurring_rounds_broadcast ON telegram_recurring_rounds (broadcast_id, round_no);
