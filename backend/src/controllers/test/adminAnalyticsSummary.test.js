/**
 * Prompt 0180 — endpoint-level regression lock for the production 500 on
 * GET /admin/analytics/summary (ReferenceError: db is not defined, a prompt
 * 0167 lazy-getDb() refactor leftover in analyticsEventsRepo.js — see that
 * repo's own test for the unit-level lock). This one proves the WHOLE real
 * path answers 200 again: createApp() on an ephemeral port, a REAL admin +
 * session created through the real repos (never a mocked requireAuth — the
 * same cookie → token-hash → session → admin lookup production runs), and a
 * real fetch asserting the full response shape the admin dashboard reads.
 *
 * Same isolated-temp-db convention as telegramEmojiAssetsController.test.js
 * next door (own DATABASE_PATH in beforeAll, dynamic imports after).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let createApp;
let getDb;
let config;
let sessionCookie;
let tempDir;

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-analytics-summary-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');

  const { runMigrations } = await import('../../db/migrate.js');
  runMigrations();
  ({ getDb } = await import('../../db/client.js'));
  ({ config } = await import('../../config/env.js'));

  // A real admin and a real session, through the same repos production
  // uses. The password hash is never exercised here (login isn't the path
  // under test — requireAuth only checks cookie → session → admin), so an
  // inert placeholder hash is honest, not a shortcut.
  const { createAdmin } = await import('../../db/repositories/adminsRepo.js');
  const { createSession } = await import('../../db/repositories/sessionsRepo.js');
  const { generateSessionToken, hashSessionToken } = await import('../../utils/sessionToken.js');
  const admin = createAdmin({ email: 'analytics-test@example.com', passwordHash: 'unused-placeholder' });
  const token = generateSessionToken();
  createSession(admin.id, hashSessionToken(token));
  sessionCookie = `${config.session.cookieName}=${token}`;

  // Two real events (today, so they land inside any days window) so the
  // summary's numbers are real aggregates, not just an all-zero shape.
  const { insertWalletCreatedEvent } = await import('../../db/repositories/analyticsEventsRepo.js');
  const now = new Date().toISOString();
  insertWalletCreatedEvent({ walletId: 'w-ext', platform: 'extension', timestamp: now, chains: ['solana'] });
  insertWalletCreatedEvent({ walletId: 'w-web', platform: 'web', timestamp: now, chains: ['solana', 'base'] });

  // Prompt 0233 — three real subscribers through the real repo (one
  // ad-sourced, one organic, plus a re-start with a DIFFERENT payload that
  // must NOT overwrite the original source), so the summary's new
  // telegramSubscribersBySource field is a real aggregate too.
  const { upsertFromStart, deactivateSubscriber, findSubscriberByChatId } = await import(
    '../../db/repositories/telegramSubscribersRepo.js'
  );
  upsertFromStart({ botId: 'official', chatId: '111', firstName: 'a', source: 'ads_2026_10_a' });
  upsertFromStart({ botId: 'official', chatId: '222', firstName: 'b' });
  upsertFromStart({ botId: 'official', chatId: '111', firstName: 'a', source: 'other_campaign' });
  // Prompt 0235 — growth/attrition fixtures with CRAFTED timestamps (the
  // 0234 test pattern): one subscriber 10 days old (prev7d window), one
  // deactivated today (counts in unsubscribed30d), one deactivated long ago
  // with an old updated_at (must NOT count).
  upsertFromStart({ botId: 'official', chatId: '333', firstName: 'c' });
  upsertFromStart({ botId: 'official', chatId: '444', firstName: 'd' });
  upsertFromStart({ botId: 'official', chatId: '555', firstName: 'e' });
  const db = getDb();
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
  const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
  db.prepare('UPDATE telegram_subscribers SET started_at = ? WHERE chat_id = ?').run(tenDaysAgo, '333');
  deactivateSubscriber(findSubscriberByChatId('official', '444').id);
  deactivateSubscriber(findSubscriberByChatId('official', '555').id);
  db.prepare('UPDATE telegram_subscribers SET started_at = ?, updated_at = ? WHERE chat_id = ?').run(
    fortyDaysAgo,
    fortyDaysAgo,
    '555'
  );

  ({ createApp } = await import('../../app.js'));
});

afterAll(() => {
  getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('GET /admin/analytics/summary', () => {
  it('answers 200 with the full summary shape for a real session (and 401 without one)', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/admin/analytics/summary?days=7`;
    try {
      // No cookie → the real requireAuth must reject; proves auth is the
      // genuine middleware, not something this test bypassed.
      const unauthenticated = await fetch(url);
      expect(unauthenticated.status).toBe(401);

      // Real session cookie → the exact request that 500'd in production.
      const res = await fetch(url, { headers: { cookie: sessionCookie } });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.totalWalletsCreated).toBe(2);
      expect(body.days).toBe(7);
      expect(body.dailyTrend).toHaveLength(7);
      const today = new Date().toISOString().slice(0, 10);
      expect(body.dailyTrend.at(-1)).toEqual({ date: today, count: 2 });
      expect(body.platformBreakdown).toEqual(
        expect.arrayContaining([
          { platform: 'extension', count: 1 },
          { platform: 'web', count: 1 },
        ])
      );
      expect(body.chainBreakdown).toEqual(
        expect.arrayContaining([
          { chain: 'solana', count: 2 },
          { chain: 'base', count: 1 },
        ])
      );
      // Prompt 0233 — aggregate subscribers-by-source rows: the re-start
      // with a different payload did NOT overwrite the original source
      // (INSERT-only attribution), and the organic row counts under null.
      expect(body.telegramSubscribersBySource).toEqual(
        expect.arrayContaining([
          { botId: 'official', source: 'ads_2026_10_a', count: 1 },
          { botId: 'official', source: null, count: 2 }, // 222 + 333 (aktif, organik)
        ])
      );
      expect(body.telegramSubscribersBySource).toHaveLength(2);

      // Prompt 0235 — the live subscriber metrics. Fixture map: 111 (ads,
      // today) + 222 (organic, today) + 333 (organic, 10 days ago) active;
      // 444 deactivated today; 555 deactivated with a 40 day old updated_at.
      expect(body.activeSubscribers).toBe(3);
      expect(body.newSubscribers7d).toBe(3); // 111, 222, 444 (started today; growth counts joiners regardless of later blocks)
      expect(body.newSubscribersPrev7d).toBe(1); // 333
      expect(body.newSubscribersToday).toBe(3);
      expect(body.subscribersFromAds).toBe(1);
      expect(body.unsubscribed30d).toBe(1); // 444 saja — 555 terlalu lama
      expect(body.dailyNewSubscribers.official).toHaveLength(30);
      expect(body.dailyNewSubscribers.test).toHaveLength(30);
      expect(body.dailyNewSubscribers.official.at(-1)).toEqual({ date: today, count: 3 });
      const tenDaysAgoDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
      expect(body.dailyNewSubscribers.official.find((d) => d.date === tenDaysAgoDate)).toEqual({
        date: tenDaysAgoDate,
        count: 1,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
