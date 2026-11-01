/**
 * Data access for `analytics_events` / `analytics_event_chains`. Every
 * query here is a COUNT(*)/GROUP BY — there is deliberately no function in
 * this file that returns individual rows keyed by wallet_id; the public
 * endpoint (routes/publicEventsRoutes.js) only writes, and the admin
 * summary endpoint only reads aggregates. See db/migrations/0005_create_analytics_events.sql
 * for the schema and the non-custodial rationale.
 */
import { randomUUID } from 'node:crypto';
import { getDb, lazyStatement } from '../client.js';

const insertEventStmt = lazyStatement(`
  INSERT INTO analytics_events (id, event, wallet_id, platform, occurred_at, created_at)
  VALUES (@id, 'WALLET_CREATED', @walletId, @platform, @occurredAt, @now)
  ON CONFLICT(event, wallet_id) DO NOTHING
`);
const insertChainStmt = lazyStatement(`
  INSERT INTO analytics_event_chains (id, event_id, chain, created_at)
  VALUES (@id, @eventId, @chain, @now)
  ON CONFLICT(event_id, chain) DO NOTHING
`);
const countTotalStmt = lazyStatement("SELECT COUNT(*) AS count FROM analytics_events WHERE event = 'WALLET_CREATED'");
const platformBreakdownStmt = lazyStatement(`
  SELECT platform, COUNT(*) AS count
  FROM analytics_events
  WHERE event = 'WALLET_CREATED'
  GROUP BY platform
  ORDER BY count DESC
`);
const chainBreakdownStmt = lazyStatement(`
  SELECT c.chain AS chain, COUNT(*) AS count
  FROM analytics_event_chains c
  JOIN analytics_events e ON e.id = c.event_id
  WHERE e.event = 'WALLET_CREATED'
  GROUP BY c.chain
  ORDER BY count DESC
`);
// Prompt 0180 — this query used to be the one read in this file still doing a
// raw `db.prepare(...)` per call against the OLD module-level `db` import;
// prompt 0167's lazy-getDb() refactor removed that import and missed this one
// call site (every sibling already used lazyStatement), leaving a
// `ReferenceError: db is not defined` that only fired at runtime, on the
// first real GET /admin/analytics/summary — caught in production, not by any
// test, since nothing tested this path (fixed alongside: see
// test/analyticsEventsRepo.test.js + test/adminAnalyticsSummary.test.js).
const dailyCountsStmt = lazyStatement(`
  SELECT substr(occurred_at, 1, 10) AS day, COUNT(*) AS count
  FROM analytics_events
  WHERE event = 'WALLET_CREATED' AND occurred_at >= @sinceIso
  GROUP BY day
  ORDER BY day ASC
`);

/**
 * Records one WALLET_CREATED event. Idempotent on (event, wallet_id) — a
 * retried beacon for the same wallet is silently a no-op, not a second row.
 * `timestamp` is normalized to strict ISO-8601 here (new Date().toISOString()),
 * not stored as whatever loose-but-parseable string the client sent, since
 * the day-bucketing query below assumes a canonical shape.
 */
export function insertWalletCreatedEvent({ walletId, platform, timestamp, chains }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const occurredAt = new Date(timestamp).toISOString();

  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = insertEventStmt().run({ id, walletId, platform, occurredAt, now });
    // Only insert chain rows if the event row was actually inserted — on a
    // deduped (already-seen) wallet_id, `id` was never written to
    // analytics_events, so an FK insert against it would fail.
    if (result.changes > 0) {
      for (const chain of chains) {
        insertChainStmt().run({ id: randomUUID(), eventId: id, chain, now });
      }
    }
    db.exec('COMMIT');
    return result.changes > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function countTotalWalletCreated() {
  return countTotalStmt().get().count;
}

/** One row per day with at least one event, ascending — callers zero-fill the gaps. */
export function dailyWalletCreatedCounts({ sinceIso }) {
  return dailyCountsStmt().all({ sinceIso });
}

export function platformBreakdown() {
  return platformBreakdownStmt().all();
}

export function chainBreakdown() {
  return chainBreakdownStmt().all();
}
