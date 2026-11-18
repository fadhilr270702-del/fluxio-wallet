/**
 * Prompt 0246 — migration 0028 (recurring_interval_hours CHECK 1..24 →
 * 1..168, by rebuilding telegram_broadcasts) against a database of REAL
 * shape: migrated 0001..0027 exactly the way migrate.js applies files,
 * then filled with what production actually holds — an active recurring
 * broadcast with rich content, its finished AND open rounds (cursor +
 * resume skip list), a sending broadcast with recipients in all three
 * states, a deactivated recurring one and a scheduled channel one.
 *
 * What it proves: every row of all three tables is identical after the
 * rebuild, both child tables' foreign keys still point at the table and
 * are still ENFORCED (including recipients' ON DELETE CASCADE, the one
 * that would have wiped every recipient row had enforcement stayed on
 * during DROP TABLE), the three indexes are back, and the CHECK now
 * accepts 168 where it rejected 25 before.
 *
 * Opens its own DatabaseSync on a temp file (same two PRAGMAs as
 * db/client.js) instead of going through runMigrations(), because the
 * point is to stop at 0027, load data, and then apply exactly 0028 — the
 * real runner cannot stop midway. The runner's own path for this file is
 * a single autocommit db.exec(sql), taken because of the marker on its
 * first line; the marker is asserted here so that equivalence holds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION_0028 = '0028_widen_recurring_interval_to_168.sql';
const MANUAL_MARKER = '-- fluxio:manual-transaction';

let tempDir;
let db;
const before = {};

/** Applies one migration file exactly the way migrate.js does. */
function applyMigration(file) {
  const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
  if (sql.startsWith(MANUAL_MARKER)) {
    db.exec(sql);
    return;
  }
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function snapshot() {
  return {
    broadcasts: db.prepare('SELECT * FROM telegram_broadcasts ORDER BY id').all(),
    recipients: db.prepare('SELECT * FROM telegram_broadcast_recipients ORDER BY id').all(),
    rounds: db.prepare('SELECT * FROM telegram_recurring_rounds ORDER BY id').all(),
    columns: db.prepare("PRAGMA table_info('telegram_broadcasts')").all()
  };
}

const ADMIN = 'adm-0028';
const B_RECURRING = 'b-0028-recurring-active';
const B_SENDING = 'b-0028-sending';
const B_OLD_RECURRING = 'b-0028-recurring-deactivated';
const B_SCHEDULED = 'b-0028-scheduled-channel';

function insertBroadcast(row) {
  db.prepare(`
    INSERT INTO telegram_broadcasts
      (id, bot_id, title, title_format, body, body_format, media_url, media_file_id, media_server_filename, media_type,
       target_type, target_channel_id, status, scheduled_at, total_count, sent_count, failed_count, error_message,
       buttons, is_recurring, recurring_interval_hours, recurring_starts_at, recurring_last_sent_at,
       recurring_last_round_sent_count, recurring_last_round_failed_count, created_by, created_at, updated_at)
    VALUES
      (@id, @bot_id, @title, @title_format, @body, @body_format, @media_url, @media_file_id, @media_server_filename, @media_type,
       @target_type, @target_channel_id, @status, @scheduled_at, @total_count, @sent_count, @failed_count, @error_message,
       @buttons, @is_recurring, @recurring_interval_hours, @recurring_starts_at, @recurring_last_sent_at,
       @recurring_last_round_sent_count, @recurring_last_round_failed_count, @created_by, @created_at, @updated_at)
  `).run({
    bot_id: 'official',
    title_format: 'plain',
    body_format: 'plain',
    media_url: null,
    media_file_id: null,
    media_server_filename: null,
    media_type: null,
    target_channel_id: null,
    scheduled_at: null,
    total_count: 0,
    sent_count: 0,
    failed_count: 0,
    error_message: null,
    buttons: '[]',
    is_recurring: 0,
    recurring_interval_hours: 1,
    recurring_starts_at: null,
    recurring_last_sent_at: null,
    recurring_last_round_sent_count: null,
    recurring_last_round_failed_count: null,
    created_by: ADMIN,
    created_at: '2026-10-28T23:00:00.000Z',
    updated_at: '2026-10-29T11:11:00.000Z',
    ...row
  });
}

function seedRealShapeData() {
  db.prepare('INSERT INTO admins (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(
    ADMIN,
    'migration-0028@example.com',
    'unused-placeholder',
    'superadmin',
    '2026-09-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z'
  );
  for (const [id, chat] of [
    ['sub-0028-a', '700000001'],
    ['sub-0028-b', '700000002'],
    ['sub-0028-c', '700000003']
  ]) {
    db.prepare(
      'INSERT INTO telegram_subscribers (id, bot_id, chat_id, username, first_name, is_active, started_at, last_interaction_at, created_at, updated_at, last_welcomed_update_id, source) VALUES (?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, NULL, ?)'
    ).run(id, 'official', chat, 'x', '2026-10-24T03:00:00.000Z', '2026-10-24T03:00:00.000Z', '2026-10-24T03:00:00.000Z', '2026-10-24T03:00:00.000Z', id === 'sub-0028-a' ? 'ads_2026_10_a' : null);
  }

  // The production shape: an active recurring broadcast to subscribers with
  // rich title/body, a premium icon button, uploaded media, a 6 hour
  // cadence anchored at activation, four recorded rounds.
  insertBroadcast({
    id: B_RECURRING,
    title: '<b>Who holds your crypto?</b>',
    title_format: 'html',
    body: 'Your keys, your crypto. <a href="https://fluxiowallet.com">Get Fluxio</a>\nNo added fee on transfers.',
    body_format: 'html',
    media_file_id: 'AgACAgUAAxkBAAIBQ2cfake_file_id_0028',
    media_server_filename: 'broadcast-media-0028.jpg',
    media_type: 'image',
    target_type: 'subscribers',
    status: 'recurring',
    sent_count: 4,
    buttons: JSON.stringify([{ text: 'GET FLUXIO', url: 'https://fluxiowallet.com', iconCustomEmojiId: '5368324170671202286' }]),
    is_recurring: 1,
    recurring_interval_hours: 6,
    recurring_starts_at: '2026-10-28T23:00:00.000Z',
    recurring_last_sent_at: '2026-10-29T11:11:02.417Z',
    recurring_last_round_sent_count: 15291,
    recurring_last_round_failed_count: 2
  });
  insertBroadcast({
    id: B_SENDING,
    bot_id: 'test',
    title: 'queued to subscribers',
    body: 'plain body',
    target_type: 'subscribers',
    status: 'sending',
    total_count: 3,
    sent_count: 1,
    failed_count: 1
  });
  insertBroadcast({
    id: B_OLD_RECURRING,
    title: 'Four chains. One wallet.',
    body: 'old recurring body',
    target_type: 'subscribers',
    status: 'completed',
    sent_count: 9,
    is_recurring: 1,
    recurring_interval_hours: 24,
    recurring_starts_at: '2026-10-20T11:00:00.000Z',
    recurring_last_sent_at: '2026-10-30T11:11:00.000Z',
    recurring_last_round_sent_count: 15234,
    recurring_last_round_failed_count: 59
  });
  insertBroadcast({
    id: B_SCHEDULED,
    bot_id: 'test',
    title: 'scheduled channel post',
    body: 'channel body',
    media_url: 'https://fluxiowallet.com/og-image.png',
    media_type: 'image',
    target_type: 'channel',
    target_channel_id: '@fluxio_test_channel',
    status: 'scheduled',
    scheduled_at: '2027-08-30T02:00:00.000Z',
    error_message: null
  });

  const insertRecipient = db.prepare(
    'INSERT INTO telegram_broadcast_recipients (id, broadcast_id, subscriber_id, chat_id, status, error_message, sent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  insertRecipient.run('rcp-0028-1', B_SENDING, 'sub-0028-a', '700000001', 'sent', null, '2026-11-15T03:00:01.000Z', '2026-11-15T03:00:00.000Z');
  insertRecipient.run('rcp-0028-2', B_SENDING, 'sub-0028-b', '700000002', 'failed', 'Forbidden: bot was blocked by the user', null, '2026-11-15T03:00:00.000Z');
  insertRecipient.run('rcp-0028-3', B_SENDING, 'sub-0028-c', '700000003', 'pending', null, null, '2026-11-15T03:00:00.000Z');

  const insertRound = db.prepare(
    'INSERT INTO telegram_recurring_rounds (id, broadcast_id, round_no, started_at, finished_at, sent_count, failed_count, cursor_started_at, cursor_subscriber_id, resume_skip_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  // A finished round, and an OPEN one interrupted mid-flight: cursor plus
  // the parallel sends that landed beyond it.
  insertRound.run('rnd-0028-1', B_RECURRING, 4, '2026-10-29T11:00:00.412Z', '2026-10-29T11:11:02.417Z', 15291, 2, '2026-10-25T09:14:07.000Z', 'sub-0028-c', null);
  insertRound.run('rnd-0028-2', B_RECURRING, 5, '2026-10-29T17:00:00.250Z', null, 9317, 1, '2026-10-24T03:00:00.000Z', 'sub-0028-b', JSON.stringify(['sub-0028-c']));
  insertRound.run('rnd-0028-3', B_OLD_RECURRING, 9, '2026-10-30T11:00:00.100Z', '2026-10-30T11:11:00.000Z', 15234, 59, null, null, null);
}

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-migration-0028-'));
  db = new DatabaseSync(path.join(tempDir, 'migration-0028.db'));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (file >= MIGRATION_0028) break;
    applyMigration(file);
  }
  seedRealShapeData();
  Object.assign(before, snapshot());
});

afterAll(() => {
  if (db) db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('migration 0028 — widen recurring_interval_hours to 1..168 by rebuilding telegram_broadcasts', () => {
  it('BEFORE the migration the fixture is real and the old CHECK rejects 25 hours', () => {
    expect(before.broadcasts).toHaveLength(4);
    expect(before.recipients).toHaveLength(3);
    expect(before.rounds).toHaveLength(3);
    expect(before.columns).toHaveLength(28);
    expect(() =>
      db.prepare('UPDATE telegram_broadcasts SET recurring_interval_hours = 25 WHERE id = ?').run(B_RECURRING)
    ).toThrow(/CHECK constraint failed/);
  });

  it('the file opts out of the wrapped transaction (the marker that makes PRAGMA foreign_keys = OFF effective) and applies cleanly', () => {
    const sql = readFileSync(path.join(migrationsDir, MIGRATION_0028), 'utf8');
    expect(sql.startsWith(MANUAL_MARKER)).toBe(true);
    applyMigration(MIGRATION_0028);
    // Enforcement is switched back on at the end of the file.
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
  });

  it('every row of telegram_broadcasts, recipients and rounds is identical after the rebuild', () => {
    const after = snapshot();
    expect(after.broadcasts).toEqual(before.broadcasts);
    expect(after.recipients).toEqual(before.recipients);
    expect(after.rounds).toEqual(before.rounds);
    // Same 28 columns, same order, same type/notnull/default/pk.
    expect(after.columns).toEqual(before.columns);
  });

  it('the only schema difference is the upper bound, and all three indexes are back', () => {
    const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telegram_broadcasts'").get().sql;
    expect(tableSql).toContain('recurring_interval_hours BETWEEN 1 AND 168');
    expect(tableSql).not.toContain('BETWEEN 1 AND 24');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'telegram_broadcasts_new'").get()).toBeUndefined();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'telegram_broadcasts' AND sql IS NOT NULL ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual([
      'idx_telegram_broadcasts_bot_status',
      'idx_telegram_broadcasts_status_created',
      'idx_telegram_broadcasts_status_scheduled'
    ]);
  });

  it('both child tables still reference telegram_broadcasts(id) and nothing dangles', () => {
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const recipientsFk = db.prepare("PRAGMA foreign_key_list('telegram_broadcast_recipients')").all().find((fk) => fk.from === 'broadcast_id');
    expect(recipientsFk).toMatchObject({ table: 'telegram_broadcasts', to: 'id', on_delete: 'CASCADE' });
    const roundsFk = db.prepare("PRAGMA foreign_key_list('telegram_recurring_rounds')").all().find((fk) => fk.from === 'broadcast_id');
    expect(roundsFk).toMatchObject({ table: 'telegram_broadcasts', to: 'id', on_delete: 'NO ACTION' });
  });

  it('the foreign keys are still ENFORCED: orphans are refused, the recipients cascade works, a broadcast with rounds cannot be deleted', () => {
    expect(() =>
      db
        .prepare('INSERT INTO telegram_broadcast_recipients (id, broadcast_id, subscriber_id, chat_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('rcp-0028-orphan', 'no-such-broadcast', 'sub-0028-a', '700000001', 'pending', '2026-11-16T00:00:00.000Z')
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      db
        .prepare('INSERT INTO telegram_recurring_rounds (id, broadcast_id, round_no, started_at) VALUES (?, ?, ?, ?)')
        .run('rnd-0028-orphan', 'no-such-broadcast', 1, '2026-11-16T00:00:00.000Z')
    ).toThrow(/FOREIGN KEY constraint failed/);

    // ON DELETE CASCADE, proven and then rolled back so later assertions
    // still see the full fixture.
    db.exec('BEGIN');
    db.prepare('DELETE FROM telegram_broadcasts WHERE id = ?').run(B_SENDING);
    expect(db.prepare('SELECT COUNT(*) AS n FROM telegram_broadcast_recipients WHERE broadcast_id = ?').get(B_SENDING).n).toBe(0);
    db.exec('ROLLBACK');
    expect(db.prepare('SELECT COUNT(*) AS n FROM telegram_broadcast_recipients WHERE broadcast_id = ?').get(B_SENDING).n).toBe(3);

    // The rounds FK is NO ACTION: the parent is protected while rounds exist.
    expect(() => db.prepare('DELETE FROM telegram_broadcasts WHERE id = ?').run(B_RECURRING)).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('the widened CHECK accepts 25 and 168 and still rejects 0 and 169', () => {
    const setInterval = db.prepare('UPDATE telegram_broadcasts SET recurring_interval_hours = ? WHERE id = ?');
    expect(() => setInterval.run(25, B_RECURRING)).not.toThrow();
    expect(() => setInterval.run(168, B_RECURRING)).not.toThrow();
    expect(db.prepare('SELECT recurring_interval_hours AS h FROM telegram_broadcasts WHERE id = ?').get(B_RECURRING).h).toBe(168);
    expect(() => setInterval.run(169, B_RECURRING)).toThrow(/CHECK constraint failed/);
    expect(() => setInterval.run(0, B_RECURRING)).toThrow(/CHECK constraint failed/);
  });
});
