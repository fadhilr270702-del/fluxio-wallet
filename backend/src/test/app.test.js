/**
 * Prompt 0178 — a real deploy behind Caddy (api.fluxiowallet.com) surfaced
 * `X-Powered-By: Express` reaching the public internet on a real response.
 * Fixed with a single `app.disable('x-powered-by')` in `app.js`; this test
 * proves the header is actually gone from a real response, not just that
 * the line exists in source.
 *
 * Same isolated-temp-db technique as telegramEmojiAssetsController.test.js/
 * telegramEmojiPacksRepo.test.js/telegramBroadcastsRepo.test.js (see those
 * files' own headers for the full reasoning, and prompt 0167's own "never
 * open the real dev database" lesson) — this backend's `setupFiles` already
 * isolates `DATABASE_PATH` to an inert placeholder before any test file's
 * imports run, but a test that actually calls `runMigrations()` against it
 * (this one does, so a real request has real routes/tables to answer with)
 * sets its own dedicated temp path explicitly, matching that established
 * convention rather than relying on the generic guard's own unused default.
 *
 * `GET /api/announcements` (not an `/admin/*` route) is the target purely
 * because it needs no auth/session setup at all — any route would prove the
 * same header-level fact, this one is just the least ceremony to reach.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let createApp;
let getDb;
let tempDir;

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-app-headers-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');

  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  ({ getDb } = await import('../db/client.js'));
  ({ createApp } = await import('../app.js'));
});

afterAll(() => {
  getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('createApp() — response headers', () => {
  it('never sends X-Powered-By on a real response', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/announcements`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-powered-by')).toBeNull();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
