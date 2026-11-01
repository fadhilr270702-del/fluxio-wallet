/**
 * Prompt 0233 — behavioral tests for /start attribution and the /help
 * reply, driven through the REAL pollOnce() path (non-injected, so the
 * real upsert/offset writes run — against an isolated temp DB, never the
 * dev one) with `globalThis.fetch` stubbed so no request can ever reach
 * Telegram (the trial-bot token is a dummy set by this file; no backend
 * process is spawned).
 *
 * The /start update comes from a REAL captured Telegram Update — the
 * fixture `prompt/evidence/0233-telegram-ads-test/start-with-payload.json`
 * written by `backend/scripts/fetchStartFixture.js` (names redacted, real
 * shape, real update_id) — never a hand-invented object. Variants (bare
 * /start, invalid payload, /help) are shallow clones of that same real
 * shape with only text/chat id/update_id changed. Until the owner captures
 * the fixture, this whole describe SKIPS (same auto-skip convention as the
 * local-integration RPC tests) and startCommands.test.js's pure tests
 * still cover the parser.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../../../../prompt/evidence/0233-telegram-ads-test/start-with-payload.json');
const fixtureExists = existsSync(FIXTURE_PATH);

let pollOnce;
let findSubscriberByChatId;
let countActiveSubscribersBySource;
let parseStartPayload;
let HELP_MESSAGE_TEXT;
let getDb;
let tempDir;
let fixture;
let expectedPayload;

// Every Telegram call this suite triggers lands here instead of the
// network: getUpdates answers with whatever batch the current test set,
// send calls are captured for assertions.
const capture = { sends: [] };
let nextBatch = [];
let realFetch;

function installFetchStub() {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const reply = (result) => ({ json: async () => ({ ok: true, result }) });
    if (u.endsWith('/getUpdates')) return reply(nextBatch);
    if (u.endsWith('/sendMessage')) {
      capture.sends.push({ method: 'sendMessage', body: JSON.parse(options.body) });
      return reply({ message_id: 1000 + capture.sends.length });
    }
    if (u.endsWith('/sendPhoto') || u.endsWith('/sendVideo')) {
      // The welcome goes out as a multipart upload (legacy trial banner) —
      // body is FormData; the exact caption is welcome.js's concern, not
      // this suite's, so only the fact of the send is captured.
      capture.sends.push({ method: u.endsWith('/sendPhoto') ? 'sendPhoto' : 'sendVideo', body: null });
      return reply({ message_id: 1000 + capture.sends.length });
    }
    throw new Error(`Unexpected fetch in startSource.test.js: ${u}`);
  };
}

describe.skipIf(!fixtureExists)('/start attribution + /help reply (real fixture, temp DB, stubbed fetch)', () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-start-source-test-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
    // A dummy trial-bot token so getTelegramClient('test') resolves a real
    // client object — whose every request hits the stub above, never
    // Telegram. Set BEFORE any config-reading module is imported.
    process.env.TELEGRAM_BOT_TOKEN_TEST = '123456:startsource-dummy-token';
    delete process.env.TELEGRAM_DISABLED;
    installFetchStub();

    const { runMigrations } = await import('../../db/migrate.js');
    runMigrations();
    ({ getDb } = await import('../../db/client.js'));
    ({ pollOnce } = await import('../poller.js'));
    ({ findSubscriberByChatId, countActiveSubscribersBySource } = await import(
      '../../db/repositories/telegramSubscribersRepo.js'
    ));
    ({ parseStartPayload, HELP_MESSAGE_TEXT } = await import('../startCommands.js'));

    fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expectedPayload = parseStartPayload(fixture.message.text);
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN_TEST;
    if (getDb) getDb().close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A shallow clone of the REAL fixture with only text/chat/update_id changed. */
  function variant({ text, chatId, updateIdOffset }) {
    return {
      ...fixture,
      update_id: fixture.update_id + updateIdOffset,
      message: {
        ...fixture.message,
        text,
        chat: { ...fixture.message.chat, id: chatId }
      }
    };
  }

  async function poll(batch) {
    capture.sends.length = 0;
    nextBatch = batch;
    await pollOnce('test');
  }

  it('a NEW subscriber from the real ad-style /start gets the payload as source (and the welcome still goes out)', async () => {
    expect(expectedPayload).toBe('ads_2026_10_a');
    await poll([fixture]);
    const row = findSubscriberByChatId('test', String(fixture.message.chat.id));
    expect(row).not.toBeNull();
    expect(row.source).toBe(expectedPayload);
    expect(row.is_active).toBe(1);
    expect(capture.sends).toHaveLength(1); // the welcome, nothing else
  });

  it('a bare /start (organic) stores source NULL', async () => {
    await poll([variant({ text: '/start', chatId: 999001, updateIdOffset: 1 })]);
    const row = findSubscriberByChatId('test', '999001');
    expect(row.source).toBe(null);
    expect(capture.sends).toHaveLength(1); // welcome unchanged
  });

  it('an invalid payload stores source NULL but the welcome still goes out', async () => {
    await poll([variant({ text: '/start ads!bad', chatId: 999002, updateIdOffset: 2 })]);
    const row = findSubscriberByChatId('test', '999002');
    expect(row.source).toBe(null);
    expect(capture.sends).toHaveLength(1);
  });

  it('an EXISTING subscriber who re-starts via an ad link keeps their original source (both NULL and non-NULL)', async () => {
    // Organic subscriber 999001 taps an ad link later — stays organic.
    await poll([variant({ text: '/start late_campaign', chatId: 999001, updateIdOffset: 3 })]);
    expect(findSubscriberByChatId('test', '999001').source).toBe(null);
    // The ad-sourced subscriber re-starts via a DIFFERENT campaign — keeps the first.
    await poll([variant({ text: '/start other_campaign', chatId: fixture.message.chat.id, updateIdOffset: 4 })]);
    expect(findSubscriberByChatId('test', String(fixture.message.chat.id)).source).toBe(expectedPayload);
  });

  it('/help is answered with exactly one plain message (exact text, no buttons) and writes no subscriber row', async () => {
    await poll([variant({ text: '/help', chatId: 999003, updateIdOffset: 5 })]);
    expect(capture.sends).toHaveLength(1);
    expect(capture.sends[0].method).toBe('sendMessage');
    expect(capture.sends[0].body.text).toBe(HELP_MESSAGE_TEXT);
    expect(capture.sends[0].body.reply_markup).toBeUndefined();
    expect(capture.sends[0].body.parse_mode).toBeUndefined();
    expect(findSubscriberByChatId('test', '999003')).toBe(null);
  });

  it('the Analytics aggregate counts active subscribers per source (NULL = organic)', () => {
    const rows = countActiveSubscribersBySource('test');
    const bySource = Object.fromEntries(rows.map((r) => [r.source ?? 'organic', r.count]));
    expect(bySource[expectedPayload]).toBe(1);
    expect(bySource.organic).toBe(2); // 999001 + 999002; /help never created a row
  });

  it('the committed fixture itself is redacted and token-free (privacy lock on the archived evidence)', () => {
    const raw = readFileSync(FIXTURE_PATH, 'utf8');
    expect(fixture.message.from.first_name).toBe('redacted');
    expect(fixture.message.from.username).toBe('redacted');
    expect(fixture.message.chat.first_name).toBe('redacted');
    expect(fixture.message.chat.username).toBe('redacted');
    expect(/\d{8,}:[A-Za-z0-9_-]{30,}/.test(raw)).toBe(false); // no bot-token shape anywhere
    expect(fixture.message.text).toBe('/start ads_2026_10_a');
  });
});
