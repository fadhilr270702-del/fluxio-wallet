/**
 * Prompt 0193 — the worker's null-client fences, tested against the REAL
 * incident shape (6 September 2026: a migrated production DB carried an
 * active recurring broadcast for the token-less 'test' bot, and the worker
 * logged a failed round EVERY SECOND). Null clients are produced honestly
 * via TELEGRAM_DISABLED=1 (prompt 0191) + a fresh module graph, not by
 * mocking getTelegramClient; the DB is a real migrated temp SQLite file
 * (same pattern as telegramBroadcastsRepo.test.js).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ENV_KEYS = ['TELEGRAM_DISABLED', 'TELEGRAM_BOT_TOKEN_TEST', 'TELEGRAM_BOT_TOKEN_OFFICIAL', 'TELEGRAM_BOT_TOKEN'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let tempDir;
let getDb;
let worker;

const ADMIN_ID = 'worker-skip-null-client-admin';

function insertBroadcast(db, { id, status, targetType = 'subscribers', targetChannelId = null, scheduledAt = null, isRecurring = 0, recurringStartsAt = null }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO telegram_broadcasts
      (id, bot_id, title, title_format, body, media_url, media_file_id, media_server_filename, media_type, target_type, target_channel_id, status, scheduled_at, total_count, sent_count, failed_count, buttons, body_format, is_recurring, recurring_interval_hours, recurring_starts_at, created_by, created_at, updated_at)
     VALUES (?, 'test', 'T', 'plain', 'B', NULL, NULL, NULL, NULL, ?, ?, ?, ?, 0, 0, 0, '[]', 'plain', ?, 1, ?, ?, ?, ?)`
  ).run(id, targetType, targetChannelId, status, scheduledAt, isRecurring, recurringStartsAt, ADMIN_ID, now, now);
}

beforeAll(async () => {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  // Real-looking tokens present — the fence must win through the 0191
  // switch's null clients, exactly the worst-case verification setup.
  process.env.TELEGRAM_DISABLED = '1';
  process.env.TELEGRAM_BOT_TOKEN_TEST = 'real-looking-test-token';

  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-worker-skip-null-client-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');

  ({ getDb } = await import('../../db/client.js'));
  const { runMigrations } = await import('../../db/migrate.js');
  runMigrations();

  const now = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO admins (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ADMIN_ID, 'worker-skip-null-client@example.com', 'hash', 'superadmin', 1, now, now);

  worker = await import('../worker.js');
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

describe('worker null-client fences (prompt 0193)', () => {
  it('an active recurring broadcast for a client-less bot is skipped with ONE exact log line and zero DB writes — and a second tick logs nothing more', async () => {
    const id = randomUUID();
    insertBroadcast(getDb(), { id, status: 'recurring', isRecurring: 1, recurringStartsAt: '2020-01-01T00:00:00.000Z' });
    const before = getDb().prepare('SELECT status, recurring_last_sent_at, updated_at, sent_count FROM telegram_broadcasts WHERE id = ?').get(id);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.processDueRecurring();
    await worker.processDueRecurring(); // second tick — must not log again
    const lines = log.mock.calls.map((c) => c.join(' '));
    log.mockRestore();

    const expected = `[telegram] bot 'test' has no token configured in this process — active recurring broadcast ${id} skipped (not attempted, not modified); it resumes automatically once the bot has a token`;
    expect(lines.filter((l) => l === expected).length).toBe(1);
    // no round was attempted: no summary/failure lines at all
    expect(lines.some((l) => l.includes('recurring round summary') || l.includes('roundFailed') || l.includes('transport error'))).toBe(false);

    const after = getDb().prepare('SELECT status, recurring_last_sent_at, updated_at, sent_count FROM telegram_broadcasts WHERE id = ?').get(id);
    expect(after).toEqual(before); // untouched — resumes by itself once a token exists
    getDb().prepare('DELETE FROM telegram_broadcasts WHERE id = ?').run(id);
  });

  it('a queued recipient for a client-less bot is marked failed once with the readable reason (via the real tick), not a null-property TypeError', async () => {
    const id = randomUUID();
    insertBroadcast(getDb(), { id, status: 'queued' });
    const now = new Date().toISOString();
    getDb()
      .prepare('INSERT INTO telegram_subscribers (id, bot_id, chat_id, username, first_name, is_active, started_at, last_interaction_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
      .run('sub-null-client', 'test', '111222333', 'user', 'User', now, now, now, now);
    getDb()
      .prepare("INSERT INTO telegram_broadcast_recipients (id, broadcast_id, subscriber_id, chat_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run('rcpt-null-client', id, 'sub-null-client', '111222333', now);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.tick();
    log.mockRestore();

    const recipient = getDb().prepare('SELECT status, error_message FROM telegram_broadcast_recipients WHERE id = ?').get('rcpt-null-client');
    expect(recipient.status).toBe('failed');
    expect(recipient.error_message).toBe("bot 'test' has no token configured in this process");
    getDb().prepare('DELETE FROM telegram_broadcast_recipients WHERE id = ?').run('rcpt-null-client');
    getDb().prepare('DELETE FROM telegram_broadcasts WHERE id = ?').run(id);
  });

  it('a due scheduled CHANNEL broadcast for a client-less bot fails with the readable reason and tick() does not throw', async () => {
    const id = randomUUID();
    insertBroadcast(getDb(), {
      id,
      status: 'scheduled',
      targetType: 'channel',
      targetChannelId: '-1000123',
      scheduledAt: '2020-01-01T00:00:00.000Z'
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(worker.tick()).resolves.toBeUndefined();
    log.mockRestore();

    const row = getDb().prepare('SELECT status, error_message FROM telegram_broadcasts WHERE id = ?').get(id);
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe("bot 'test' has no token configured in this process");
    getDb().prepare('DELETE FROM telegram_broadcasts WHERE id = ?').run(id);
  });
});
