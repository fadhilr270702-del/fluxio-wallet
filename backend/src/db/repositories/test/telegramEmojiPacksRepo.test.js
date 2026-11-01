/**
 * Prompt 0152 — the FIRST DB-backed test in this backend (every prior test
 * here is pure-logic-only; I/O-heavy repository code has always been
 * verified live instead, per broadcastMedia.test.js's own explicit
 * comment). Deviated from that precedent deliberately, only for this one
 * function: the register/refresh sync logic (a full delete-then-reinsert
 * of a pack's own emoji rows) is exactly the kind of "does this genuinely
 * add AND remove correctly" behavior a live Telegram round trip can't
 * cheaply prove twice in a row, and the base prompt explicitly asked for
 * it. Uses a real, isolated, file-backed SQLite database (Node's own
 * `node:sqlite`, same engine the real app uses) in a fresh temp directory
 * — never `:memory:` (to stay closest to how the real app actually opens
 * its db) and never the real dev database (`backend/data/fluxio-admin.db`,
 * touched by zero code in this file).
 *
 * `process.env.DATABASE_PATH` is set BEFORE the first dynamic `import()`
 * of anything touching `db/client.js` — `config/env.js`'s `dotenv/config`
 * call never overwrites an already-set env var, so this env var wins over
 * whatever `backend/.env` says. Vitest isolates each test file's own
 * MODULE REGISTRY by default (isolate: true), so this file's `db/client.js`
 * singleton (now a lazily-created one — see that module's own prompt 0167
 * comment) is never literally the SAME connection object another file
 * imports. That is a narrower guarantee than it might sound, corrected here
 * after prompt 0167's own investigation: module-registry isolation does
 * NOT reset raw `process.env` between test files that happen to share a
 * reused Vitest worker thread, so a DATABASE_PATH set here could in
 * principle still be READ by a later file in the same thread that never
 * sets its own — this file staying safe relies on setting its own path
 * explicitly (as it already does, above), not on env isolation that
 * doesn't actually exist. As of prompt 0167 there's also a setup-file
 * safety net (see backend/test/setupDatabasePath.js) that gives every test
 * file its own unique DATABASE_PATH before this one's beforeAll even runs,
 * which this file's own explicit override still simply takes precedence
 * over.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let getDb;
let runMigrations;
let upsertPackWithEmojis;
let findPackByBotAndName;
let findPackById;
let listPacksForBot;
let listEmojisForPack;
let deletePack;
let tempDir;

const ADMIN_ID = 'test-admin-0152';

function emoji(customEmojiId, overrides = {}) {
  return {
    customEmojiId,
    fallbackEmoji: '⭐',
    isAnimated: true,
    isVideo: false,
    fileId: `file-${customEmojiId}`,
    fileUniqueId: `unique-${customEmojiId}`,
    fileSize: 1000,
    thumbFileId: `thumb-file-${customEmojiId}`,
    thumbFileUniqueId: `thumb-unique-${customEmojiId}`,
    thumbWidth: 128,
    thumbHeight: 128,
    ...overrides
  };
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-emoji-repo-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');

  ({ getDb } = await import('../../client.js'));
  ({ runMigrations } = await import('../../migrate.js'));
  runMigrations();

  ({
    upsertPackWithEmojis,
    findPackByBotAndName,
    findPackById,
    listPacksForBot,
    listEmojisForPack,
    deletePack
  } = await import('../telegramEmojiPacksRepo.js'));

  const now = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO admins (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ADMIN_ID, 'repo-test@example.com', 'hash', 'superadmin', 1, now, now);
});

afterAll(() => {
  // Windows holds an exclusive lock on the open WAL-mode db file (and its
  // -wal/-shm siblings) until the connection is explicitly closed — an
  // unclosed handle turns the temp-dir cleanup below into a real EPERM,
  // caught live while writing this very test.
  getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('upsertPackWithEmojis — register (first insert)', () => {
  it('creates a new pack row and its emoji rows, in order', () => {
    const pack = upsertPackWithEmojis({
      botId: 'test',
      setName: 'RegisterPack',
      title: 'Register Pack',
      stickerType: 'custom_emoji',
      registeredBy: ADMIN_ID,
      emojis: [emoji('E1'), emoji('E2'), emoji('E3')]
    });

    expect(pack.bot_id).toBe('test');
    expect(pack.set_name).toBe('RegisterPack');
    expect(pack.emoji_count).toBe(3);
    expect(pack.registered_by).toBe(ADMIN_ID);

    const rows = listEmojisForPack(pack.id);
    expect(rows.map((r) => r.custom_emoji_id)).toEqual(['E1', 'E2', 'E3']);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(rows[0].is_animated).toBe(1);
    expect(rows[0].thumb_file_id).toBe('thumb-file-E1');
  });

  it('scopes packs per bot — the same set_name on a different bot is a separate row', () => {
    const testPack = upsertPackWithEmojis({
      botId: 'test',
      setName: 'SharedName',
      title: 'Shared Name (test bot copy)',
      stickerType: 'custom_emoji',
      registeredBy: ADMIN_ID,
      emojis: [emoji('SHARED1')]
    });
    const officialPack = upsertPackWithEmojis({
      botId: 'official',
      setName: 'SharedName',
      title: 'Shared Name (official bot copy)',
      stickerType: 'custom_emoji',
      registeredBy: ADMIN_ID,
      emojis: [emoji('SHARED1'), emoji('SHARED2')]
    });

    expect(testPack.id).not.toBe(officialPack.id);
    expect(listPacksForBot('test').some((p) => p.id === testPack.id)).toBe(true);
    expect(listPacksForBot('official').some((p) => p.id === officialPack.id)).toBe(true);
    expect(listPacksForBot('test').some((p) => p.id === officialPack.id)).toBe(false);
    // Same custom_emoji_id ('SHARED1') coexists fine under two different
    // bots — the primary key is (bot_id, custom_emoji_id), not
    // custom_emoji_id alone.
    expect(listEmojisForPack(officialPack.id).map((r) => r.custom_emoji_id)).toEqual(['SHARED1', 'SHARED2']);
  });
});

describe('upsertPackWithEmojis — refresh sync (add AND remove)', () => {
  it('re-registering the same (bot_id, set_name) updates the SAME row, not a duplicate', () => {
    const first = upsertPackWithEmojis({
      botId: 'test',
      setName: 'RefreshPack',
      title: 'Refresh Pack v1',
      stickerType: 'custom_emoji',
      registeredBy: ADMIN_ID,
      emojis: [emoji('R1'), emoji('R2')]
    });

    const second = upsertPackWithEmojis({
      botId: 'test',
      setName: 'RefreshPack',
      title: 'Refresh Pack v2 (title changed upstream)',
      stickerType: 'custom_emoji',
      registeredBy: 'someone-else-should-be-ignored',
      emojis: [emoji('R1'), emoji('R2')]
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Refresh Pack v2 (title changed upstream)');
    // registered_by is never changed by a refresh — only the original
    // register call sets it (see the repo function's own comment).
    expect(second.registered_by).toBe(ADMIN_ID);
  });

  it('a refresh with a NEW emoji added and an OLD one removed reflects exactly the new set — no leftovers, no duplicates', () => {
    const pack = upsertPackWithEmojis({
      botId: 'test',
      setName: 'SyncPack',
      title: 'Sync Pack',
      stickerType: 'custom_emoji',
      registeredBy: ADMIN_ID,
      emojis: [emoji('S1'), emoji('S2'), emoji('S3')]
    });
    expect(listEmojisForPack(pack.id).map((r) => r.custom_emoji_id)).toEqual(['S1', 'S2', 'S3']);

    // Simulates Telegram's own pack having genuinely changed: S2 removed,
    // S4 added, S1/S3 kept but reordered.
    const refreshed = upsertPackWithEmojis({
      botId: 'test',
      setName: 'SyncPack',
      title: 'Sync Pack',
      stickerType: 'custom_emoji',
      registeredBy: ADMIN_ID,
      emojis: [emoji('S3'), emoji('S1'), emoji('S4')]
    });

    const rows = listEmojisForPack(pack.id);
    expect(rows.map((r) => r.custom_emoji_id)).toEqual(['S3', 'S1', 'S4']);
    expect(refreshed.emoji_count).toBe(3);
    // S2 must be genuinely gone, not just unreferenced.
    const s2Still = rows.find((r) => r.custom_emoji_id === 'S2');
    expect(s2Still).toBeUndefined();
  });

  it('a refresh down to zero emoji leaves the pack with no emoji rows at all', () => {
    const pack = upsertPackWithEmojis({
      botId: 'test',
      setName: 'EmptiedPack',
      title: 'Emptied Pack',
      stickerType: 'custom_emoji',
      registeredBy: ADMIN_ID,
      emojis: [emoji('Z1'), emoji('Z2')]
    });
    upsertPackWithEmojis({
      botId: 'test',
      setName: 'EmptiedPack',
      title: 'Emptied Pack',
      stickerType: 'custom_emoji',
      registeredBy: ADMIN_ID,
      emojis: []
    });
    expect(listEmojisForPack(pack.id)).toEqual([]);
    expect(findPackById(pack.id, 'test').emoji_count).toBe(0);
  });
});

describe('deletePack', () => {
  it('removes the pack row AND cascades to its own emoji rows (ON DELETE CASCADE)', () => {
    const pack = upsertPackWithEmojis({
      botId: 'test',
      setName: 'DoomedPack',
      title: 'Doomed Pack',
      stickerType: 'custom_emoji',
      registeredBy: ADMIN_ID,
      emojis: [emoji('D1'), emoji('D2')]
    });
    expect(listEmojisForPack(pack.id).length).toBe(2);

    deletePack(pack.id);

    expect(findPackById(pack.id, 'test')).toBeNull();
    expect(listEmojisForPack(pack.id)).toEqual([]);
  });

  it('does not affect a different pack that happens to share no state with the deleted one', () => {
    const survivor = upsertPackWithEmojis({
      botId: 'test',
      setName: 'SurvivorPack',
      title: 'Survivor Pack',
      stickerType: 'custom_emoji',
      registeredBy: ADMIN_ID,
      emojis: [emoji('SV1')]
    });
    const victim = upsertPackWithEmojis({
      botId: 'test',
      setName: 'VictimPack',
      title: 'Victim Pack',
      stickerType: 'custom_emoji',
      registeredBy: ADMIN_ID,
      emojis: [emoji('VC1')]
    });

    deletePack(victim.id);

    expect(findPackById(survivor.id, 'test')).not.toBeNull();
    expect(listEmojisForPack(survivor.id).map((r) => r.custom_emoji_id)).toEqual(['SV1']);
  });
});

describe('findPackByBotAndName', () => {
  it('returns null for a pack that was never registered', () => {
    expect(findPackByBotAndName('test', 'NeverRegisteredPack')).toBeNull();
  });
});
