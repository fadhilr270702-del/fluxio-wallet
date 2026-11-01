/**
 * Prompt 0180 — regression lock for a real production 500: prompt 0167's
 * lazy-getDb() refactor removed this file's module-level `db` import and
 * missed exactly one call site, `dailyWalletCreatedCounts()`, leaving a
 * `ReferenceError: db is not defined` that only ever fired at runtime on a
 * real GET /admin/analytics/summary (caught via journalctl on the live VM,
 * not by any test — nothing imported this repo in a test before this file).
 * This test calls the repaired function against a real temp database, so a
 * future "renders fine at import time, explodes when called" regression in
 * it can never ship green again.
 *
 * Same isolated-temp-db convention as the sibling repo tests here (own
 * DATABASE_PATH in beforeAll, dynamic imports after — see prompt 0167's
 * lesson in CLAUDE.md and setupDatabasePath.js's own header).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let insertWalletCreatedEvent;
let dailyWalletCreatedCounts;
let getDb;
let tempDir;

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-analytics-repo-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');

  const { runMigrations } = await import('../../migrate.js');
  runMigrations();
  ({ getDb } = await import('../../client.js'));
  ({ insertWalletCreatedEvent, dailyWalletCreatedCounts } = await import('../analyticsEventsRepo.js'));
});

afterAll(() => {
  getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dailyWalletCreatedCounts()', () => {
  it('buckets two events on different days into two ascending rows', () => {
    // Two real WALLET_CREATED events on two different UTC days, written
    // through the same repo function production uses (idempotent insert +
    // chain rows), never raw SQL.
    insertWalletCreatedEvent({
      walletId: 'wallet-day-one',
      platform: 'extension',
      timestamp: '2026-09-01T10:00:00.000Z',
      chains: ['solana'],
    });
    insertWalletCreatedEvent({
      walletId: 'wallet-day-three',
      platform: 'web',
      timestamp: '2026-09-03T12:34:56.000Z',
      chains: ['solana', 'base'],
    });

    // The pre-fix code threw `ReferenceError: db is not defined` on this
    // exact call — reaching the assertions at all is half the regression lock.
    const rows = dailyWalletCreatedCounts({ sinceIso: '2026-09-01T00:00:00.000Z' });

    expect(rows).toEqual([
      { day: '2026-09-01', count: 1 },
      { day: '2026-09-03', count: 1 },
    ]);

    // And the sinceIso lower bound genuinely filters: a cutoff after day
    // one leaves only day three.
    expect(dailyWalletCreatedCounts({ sinceIso: '2026-09-02T00:00:00.000Z' })).toEqual([
      { day: '2026-09-03', count: 1 },
    ]);
  });
});
