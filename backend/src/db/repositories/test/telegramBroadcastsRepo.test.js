/**
 * Prompt 0166 — first-ever dedicated test file for telegramBroadcastsRepo.js
 * (a heavily-used repo with no prior direct coverage), narrowly scoped to
 * the one thing this prompt's own fix genuinely needs a real database to
 * prove: migration 0024's new recurring_last_round_sent_count/
 * recurring_last_round_failed_count columns default to NULL for both a
 * pre-existing-shape row and a freshly created one, and recordRecurringSend()
 * actually persists real numbers onto them. Same isolated-temp-SQLite-file
 * pattern as richTextFormat.test.js/telegramEmojiPacksRepo.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let createBroadcast;
let recordRecurringSend;
let findBroadcastById;
let tempDir;

const ADMIN_ID = 'telegram-broadcasts-repo-test-admin';

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-telegram-broadcasts-repo-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');

  const { getDb } = await import('../../client.js');
  const { runMigrations } = await import('../../migrate.js');
  runMigrations();

  const now = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO admins (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ADMIN_ID, 'telegram-broadcasts-repo-test@example.com', 'hash', 'superadmin', 1, now, now);

  ({ createBroadcast, recordRecurringSend, findBroadcastById } = await import('../telegramBroadcastsRepo.js'));
});

afterAll(async () => {
  const { getDb } = await import('../../client.js');
  getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('migration 0024 — recurring_last_round_sent_count / _failed_count default to NULL', () => {
  it('a freshly created recurring broadcast starts with both fields NULL', () => {
    const broadcast = createBroadcast({
      botId: 'test',
      title: 'round-result migration test',
      body: 'body',
      targetType: 'subscribers',
      totalCount: 0,
      createdBy: ADMIN_ID,
      recurring: true
    });
    expect(broadcast.recurring_last_round_sent_count).toBeNull();
    expect(broadcast.recurring_last_round_failed_count).toBeNull();
  });

  it('a freshly created non-recurring broadcast also starts with both fields NULL (the columns are recurring-only in practice, but nullable for every row)', () => {
    const broadcast = createBroadcast({
      botId: 'test',
      title: 'non-recurring migration test',
      body: 'body',
      targetType: 'channel',
      targetChannelId: '@somechannel',
      totalCount: 0,
      createdBy: ADMIN_ID
    });
    expect(broadcast.recurring_last_round_sent_count).toBeNull();
    expect(broadcast.recurring_last_round_failed_count).toBeNull();
  });
});

describe('recordRecurringSend — persists real per-round counts', () => {
  it('writes the given sentCount/failedCount onto the row, alongside the existing sent_count/recurring_last_sent_at advance', () => {
    const broadcast = createBroadcast({
      botId: 'test',
      title: 'record round result test',
      body: 'body',
      targetType: 'subscribers',
      totalCount: 0,
      createdBy: ADMIN_ID,
      recurring: true
    });
    const sentAtIso = new Date().toISOString();
    recordRecurringSend(broadcast.id, sentAtIso, 2, 1);

    const updated = findBroadcastById(broadcast.id);
    expect(updated.sent_count).toBe(1); // "successful rounds", unrelated to the recipient count below
    expect(updated.recurring_last_sent_at).toBe(sentAtIso);
    expect(updated.recurring_last_round_sent_count).toBe(2);
    expect(updated.recurring_last_round_failed_count).toBe(1);
  });

  it('a second round overwrites the previous round\'s own counts (last round only, not accumulated)', () => {
    const broadcast = createBroadcast({
      botId: 'test',
      title: 'record round result overwrite test',
      body: 'body',
      targetType: 'subscribers',
      totalCount: 0,
      createdBy: ADMIN_ID,
      recurring: true
    });
    recordRecurringSend(broadcast.id, new Date().toISOString(), 3, 0);
    recordRecurringSend(broadcast.id, new Date().toISOString(), 1, 2);

    const updated = findBroadcastById(broadcast.id);
    expect(updated.sent_count).toBe(2); // two successful rounds total
    expect(updated.recurring_last_round_sent_count).toBe(1); // only the most recent round's numbers
    expect(updated.recurring_last_round_failed_count).toBe(2);
  });
});
