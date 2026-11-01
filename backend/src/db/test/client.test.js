/**
 * Prompt 0167's own explicit guard test — deliberately does NOT set its own
 * process.env.DATABASE_PATH (unlike richTextFormat.test.js/
 * telegramEmojiPacksRepo.test.js/telegramBroadcastsRepo.test.js/
 * telegramEmojiAssetsController.test.js), specifically so this proves the
 * new setup-file safety net (test/setupDatabasePath.js) on its own, with no
 * help from this file's own isolation.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { config } from '../../config/env.js';

describe('db/client.js — lazy connection (prompt 0167)', () => {
  it('config.databasePath does not point at the real dev database (./data/) in the test environment', () => {
    // Backslash-normalized for a robust check on Windows paths.
    const normalized = config.databasePath.replace(/\\/g, '/');
    expect(normalized).not.toMatch(/\/data\/fluxio-admin\.db$/);
    // Positive check too — not just "doesn't match the real path", but
    // actually IS the setup file's own guard temp directory.
    expect(normalized).toMatch(/fluxio-vitest-db-guard-/);
  });

  it('importing db/client.js does not create any database file until getDb() is actually called', async () => {
    // A fresh dynamic import — nothing above this point in this file has
    // ever touched client.js, so dbInstance is still null going in.
    const { getDb } = await import('../client.js');
    expect(existsSync(config.databasePath)).toBe(false);

    // Only NOW, on the first real getDb() call, should the file appear.
    getDb();
    expect(existsSync(config.databasePath)).toBe(true);
  });

  it('getDb() returns the exact same connection object on every call (one singleton, not one per call)', async () => {
    const { getDb } = await import('../client.js');
    const first = getDb();
    const second = getDb();
    const third = getDb();
    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});
