/**
 * Prompt 0167 — safety net, layer 3 of 3 (see db/client.js's own header for
 * layer 2, and schemas/*.js for layer 1). Runs once per test FILE (Vitest's
 * default `isolate: true` gives every file its own fresh module registry,
 * and setupFiles re-execute for each one) — BEFORE that file's own imports
 * are evaluated, so this always wins the race against any test file that
 * transitively reaches config/env.js's `config.databasePath` resolution.
 *
 * config.databasePath is computed ONCE, at config/env.js's own module-load
 * time (`process.env.DATABASE_PATH || './data/fluxio-admin.db'`, then
 * frozen) — so the only way to influence it is to set the env var before
 * that module is ever imported by anything, in any test file, no matter
 * how deep the import chain. This override is unconditional: even a test
 * file that never thinks about the database at all now gets a private,
 * disposable path instead of silently defaulting to the real one.
 *
 * A DB-backed test file that sets its OWN process.env.DATABASE_PATH in its
 * own beforeAll (richTextFormat.test.js, telegramEmojiPacksRepo.test.js,
 * telegramBroadcastsRepo.test.js, telegramEmojiAssetsController.test.js)
 * still works exactly as before: its own explicit assignment runs later —
 * inside a beforeAll hook, at test-execution time — and simply overwrites
 * this module-load-time default before that file's own first dynamic
 * `import('.../client.js')` ever resolves config.databasePath. Whichever
 * value was set LAST, before db/client.js's config import actually
 * happens, wins — no coordination between this file and those needed.
 *
 * Named `.db` but never created as a real file — nothing in the vast
 * majority of test files ever calls getDb() at all (that's the whole
 * point: importing a schema or a pure function must never touch a
 * database), so this path exists only as an inert placeholder value for
 * the rare accidental case, and cleanup below is defense-in-depth for that
 * case, not an expectation that this file will typically exist.
 */
import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const guardTempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-vitest-db-guard-'));
process.env.DATABASE_PATH = path.join(guardTempDir, 'unused.db');

afterAll(async () => {
  try {
    // The common case: nothing in this test file ever called getDb(), so
    // guardTempDir is still empty and this succeeds immediately.
    rmSync(guardTempDir, { recursive: true, force: true });
  } catch {
    // Something DID call getDb() somewhere in this file — Windows holds an
    // exclusive lock on an open WAL-mode db file (and its -wal/-shm
    // siblings) until the connection is explicitly closed, turning the
    // rmSync above into a real EPERM (same failure mode documented in
    // telegramEmojiPacksRepo.test.js's own afterAll, caught live here too).
    // Close the real connection, then retry once.
    const { getDb } = await import('../src/db/client.js');
    getDb().close();
    rmSync(guardTempDir, { recursive: true, force: true });
  }
});
