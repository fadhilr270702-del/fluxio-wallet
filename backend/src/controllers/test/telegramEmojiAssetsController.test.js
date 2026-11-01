/**
 * Prompt 0152 — the emoji-asset proxy's own security/behavior contract:
 * requireAuth actually gates the real route, an unknown bot/emoji 404s
 * without ever reaching Telegram, a TGS "file" response is genuinely
 * gunzipped to JSON, and — the one non-negotiable property — no response
 * this proxy ever sends contains the bot token's exact string, in either
 * the body or any header. `TELEGRAM_BOT_TOKEN_TEST`/`_OFFICIAL` are set to
 * throwaway dummy values here specifically so this last check means
 * something (asserting a REAL production token never appears would prove
 * nothing about code that could still be leaking some OTHER string).
 *
 * Same isolated-temp-db technique as telegramEmojiPacksRepo.test.js (see
 * that file's own header for the full reasoning) — this is the second,
 * not the first, DB-backed test in this backend.
 *
 * `global.fetch` is stubbed for the two deeper tests (content-type +
 * no-token-leak + gunzip) so no real network call to api.telegram.org ever
 * happens — this backend has no HTTP-mocking dependency, so the stub is
 * hand-rolled directly against the same native `fetch`/`Response` client.js
 * itself uses, restored via `vi.unstubAllGlobals()` afterward.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// The emoji-asset disk cache lives under the REAL backend/uploads/ tree
// (emojiAssetCache.js has no override hook, unlike DATABASE_PATH) — a
// stale cache file from a PRIOR run of this exact test file is real state
// on disk, not reset by vitest's per-file module isolation. Caught live:
// the "served from cache, no second fetch" test passed in isolation but
// failed when the full suite ran a second time, because the previous
// run's own cache file for the same hardcoded file_unique_id was still
// sitting on disk. Fixed by deleting this test's own known cache keys
// before it seeds anything, so every run starts genuinely cache-cold.
const TEST_CACHE_KEYS = ['tgs-unique-1', 'thumb-unique-1', 'tgs-unique-2', 'thumb-unique-2'];

const DUMMY_TEST_TOKEN = 'DUMMY-TEST-TOKEN-11111';
const DUMMY_OFFICIAL_TOKEN = 'DUMMY-OFFICIAL-TOKEN-22222';

let getDb;
let runMigrations;
let upsertPackWithEmojis;
let getThumb;
let getFile;
let createApp;
let tempDir;
let uploadsDir;

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    send(data) {
      this.body = data;
      this.ended = true;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.ended = true;
    }
  };
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-emoji-proxy-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
  // Isolates this test's emoji-asset disk cache from every other test/dev
  // run — welcome.js's UPLOADS_DIR resolves relative to backendRoot, which
  // this env var also lets us redirect for the same reason DATABASE_PATH
  // is redirected above (see welcome.js — it accepts no override today, so
  // this is set for documentation/intent even though UPLOADS_DIR itself is
  // fixed; the real isolation for THIS test comes from each seeded
  // file_unique_id being unique to this test file, so a cache collision
  // with a real dev-server cache entry is a non-issue either way).
  uploadsDir = path.join(tempDir, 'uploads');
  process.env.TELEGRAM_BOT_TOKEN_TEST = DUMMY_TEST_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN_OFFICIAL = DUMMY_OFFICIAL_TOKEN;

  ({ getDb } = await import('../../db/client.js'));
  ({ runMigrations } = await import('../../db/migrate.js'));
  runMigrations();

  ({ upsertPackWithEmojis } = await import('../../db/repositories/telegramEmojiPacksRepo.js'));
  ({ getThumb, getFile } = await import('../telegramEmojiAssetsController.js'));
  ({ createApp } = await import('../../app.js'));

  const { EMOJI_ASSET_CACHE_DIR } = await import('../../telegram/emojiAssetCache.js');
  for (const key of TEST_CACHE_KEYS) {
    for (const ext of ['.data', '.meta']) {
      const p = path.join(EMOJI_ASSET_CACHE_DIR, `${key}${ext}`);
      if (existsSync(p)) rmSync(p);
    }
  }

  const now = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO admins (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('proxy-test-admin', 'proxy-test@example.com', 'hash', 'superadmin', 1, now, now);

  upsertPackWithEmojis({
    botId: 'test',
    setName: 'ProxyTestPack',
    title: 'Proxy Test Pack',
    stickerType: 'custom_emoji',
    registeredBy: 'proxy-test-admin',
    emojis: [
      {
        customEmojiId: 'ANIMATED1',
        fallbackEmoji: '⭐',
        isAnimated: true,
        isVideo: false,
        fileId: 'tgs-file-id-1',
        fileUniqueId: 'tgs-unique-1',
        fileSize: 5000,
        thumbFileId: 'thumb-file-id-1',
        thumbFileUniqueId: 'thumb-unique-1',
        thumbWidth: 128,
        thumbHeight: 128
      },
      // A SEPARATE emoji, reserved for the caching test below — it needs
      // to start cache-cold, which ANIMATED1 no longer is by the time that
      // test runs (the earlier gunzip test already populated its cache
      // entry via the very same file_unique_id).
      {
        customEmojiId: 'ANIMATED2',
        fallbackEmoji: '🪙',
        isAnimated: true,
        isVideo: false,
        fileId: 'tgs-file-id-2',
        fileUniqueId: 'tgs-unique-2',
        fileSize: 5000,
        thumbFileId: 'thumb-file-id-2',
        thumbFileUniqueId: 'thumb-unique-2',
        thumbWidth: 128,
        thumbHeight: 128
      }
    ]
  });
});

afterAll(async () => {
  getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
  // Leaves the real backend/uploads/emoji-cache/ tree exactly as clean as
  // it found it — these are throwaway test keys, not real Telegram assets.
  const { EMOJI_ASSET_CACHE_DIR } = await import('../../telegram/emojiAssetCache.js');
  for (const key of TEST_CACHE_KEYS) {
    for (const ext of ['.data', '.meta']) {
      const p = path.join(EMOJI_ASSET_CACHE_DIR, `${key}${ext}`);
      if (existsSync(p)) rmSync(p);
    }
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('route-level auth (real Express app, real router wiring)', () => {
  it('rejects a thumb request with no session cookie — never reaches the controller at all', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/emoji-assets/test/ANIMATED1/thumb`);
      expect(res.status).toBe(401);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects a file request with no session cookie', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/emoji-assets/test/ANIMATED1/file`);
      expect(res.status).toBe(401);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('unknown botId / customEmojiId — 404, never reaches Telegram', () => {
  it('404s for an unrecognized bot id', async () => {
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('fetch must never be called for an invalid bot id');
    }));
    await expect(getThumb({ params: { botId: 'not-a-real-bot', customEmojiId: 'ANIMATED1' } }, fakeRes()))
      .rejects.toMatchObject({ status: 404, code: 'EMOJI_NOT_FOUND' });
  });

  it('404s for a bot id that IS valid but has no such emoji registered', async () => {
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('fetch must never be called for an unknown emoji id');
    }));
    await expect(getFile({ params: { botId: 'test', customEmojiId: 'NEVER-REGISTERED' } }, fakeRes()))
      .rejects.toMatchObject({ status: 404, code: 'EMOJI_NOT_FOUND' });
  });
});

describe('content-type, gunzip, and the no-token-leak guarantee', () => {
  function stubTelegramFetch({ filePath, rawBody }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_id: 'x', file_path: filePath, file_size: rawBody.length } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (urlStr.includes('/file/bot')) {
          return new Response(rawBody, { status: 200 });
        }
        throw new Error(`Unexpected fetch URL in test: ${urlStr}`);
      })
    );
  }

  it('gunzips a TGS "file" response into application/json Lottie data, with no token anywhere in the response', async () => {
    const lottieJson = { v: '5.9.0', fr: 30, w: 100, h: 100, layers: [] };
    const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify(lottieJson)));
    stubTelegramFetch({ filePath: 'documents/file_1.tgs', rawBody: gzipped });

    const res = fakeRes();
    await getFile({ params: { botId: 'test', customEmojiId: 'ANIMATED1' } }, res);

    expect(res.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(res.body.toString())).toEqual(lottieJson);

    const everythingSent = JSON.stringify(res.headers) + res.body.toString();
    expect(everythingSent).not.toContain(DUMMY_TEST_TOKEN);
    expect(everythingSent).not.toContain(DUMMY_OFFICIAL_TOKEN);
  });

  it('serves the thumb as a raw static image with no gunzip, and no token leak', async () => {
    const fakeWebpBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]);
    stubTelegramFetch({ filePath: 'photos/thumb.webp', rawBody: fakeWebpBytes });

    const res = fakeRes();
    await getThumb({ params: { botId: 'test', customEmojiId: 'ANIMATED1' } }, res);

    expect(res.headers['Content-Type']).toBe('image/webp');
    expect(Buffer.compare(res.body, fakeWebpBytes)).toBe(0);

    const everythingSent = JSON.stringify(res.headers) + res.body.toString('latin1');
    expect(everythingSent).not.toContain(DUMMY_TEST_TOKEN);
    expect(everythingSent).not.toContain(DUMMY_OFFICIAL_TOKEN);
  });

  it('a second request for the same emoji is served from the local cache — no second fetch at all', async () => {
    const lottieJson = { v: '5.9.0', fr: 30, w: 50, h: 50, layers: [] };
    const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify(lottieJson)));
    const fetchSpy = vi.fn(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_id: 'x', file_path: 'documents/file_1.tgs', file_size: gzipped.length } }), { status: 200 });
      }
      return new Response(gzipped, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await getFile({ params: { botId: 'test', customEmojiId: 'ANIMATED2' } }, fakeRes());
    const callsAfterFirst = fetchSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second call — first request already wrote this file_unique_id to the
    // disk cache (writeCachedEmojiAsset), so this one must be served
    // without touching fetch again at all.
    const res2 = fakeRes();
    await getFile({ params: { botId: 'test', customEmojiId: 'ANIMATED2' } }, res2);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
    expect(JSON.parse(res2.body.toString())).toEqual(lottieJson);
  });
});
