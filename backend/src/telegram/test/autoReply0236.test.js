/**
 * Prompt 0236 — the unknown-private-message auto reply, driven through the
 * REAL pollOnce() path with Update objects derived from the REAL captured
 * fixture (prompt/evidence/0233-telegram-ads-test/start-with-payload.json —
 * only text/chat/update_id/from changed per case), the 0233 harness: temp
 * DB, dummy trial-bot token, globalThis.fetch stubbed so nothing can reach
 * Telegram and no backend process is spawned.
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
let AUTO_REPLY_TEXT;
let HELP_MESSAGE_TEXT;
let getDb;
let tempDir;
let fixture;

const sends = []; // { method, text } untuk sendMessage; sendPhoto dicatat method saja
let nextBatch = [];
let realFetch;

function installFetchStub() {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const reply = (result) => ({ json: async () => ({ ok: true, result }) });
    if (u.endsWith('/getUpdates')) return reply(nextBatch);
    if (u.endsWith('/sendMessage')) {
      const body = JSON.parse(options.body);
      sends.push({ method: 'sendMessage', chatId: body.chat_id, text: body.text });
      return reply({ message_id: 8000 + sends.length });
    }
    if (u.endsWith('/sendPhoto') || u.endsWith('/sendVideo')) {
      sends.push({ method: 'sendPhoto', chatId: null, text: null });
      return reply({ message_id: 8000 + sends.length });
    }
    throw new Error(`fetch tak terduga di autoReply0236: ${u}`);
  };
}

describe.skipIf(!fixtureExists)('auto reply pesan pribadi non perintah (fixture nyata, temp DB, fetch distub)', () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-auto-reply-0236-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
    process.env.TELEGRAM_BOT_TOKEN_TEST = '123456:auto-reply-dummy';
    delete process.env.TELEGRAM_DISABLED;
    installFetchStub();

    const { runMigrations } = await import('../../db/migrate.js');
    runMigrations();
    ({ getDb } = await import('../../db/client.js'));
    ({ pollOnce } = await import('../poller.js'));
    ({ AUTO_REPLY_TEXT, HELP_MESSAGE_TEXT } = await import('../startCommands.js'));
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN_TEST;
    if (getDb) getDb().close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Turunan fixture NYATA: hanya text/chat/update_id/from yang diganti per kasus. */
  function variant({ text, chatId, updateIdOffset, chatType = 'private', fromIsBot = false }) {
    return {
      ...fixture,
      update_id: fixture.update_id + updateIdOffset,
      message: {
        ...fixture.message,
        text,
        chat: { ...fixture.message.chat, id: chatId, type: chatType },
        from: { ...fixture.message.from, is_bot: fromIsBot }
      }
    };
  }

  async function poll(batch) {
    sends.length = 0;
    nextBatch = batch;
    await pollOnce('test');
  }

  it('teks bebas private → tepat SATU balasan otomatis dengan teks persis', async () => {
    await poll([variant({ text: 'halo', chatId: 777001, updateIdOffset: 100 })]);
    expect(sends).toHaveLength(1);
    expect(sends[0].method).toBe('sendMessage');
    expect(sends[0].text).toBe(AUTO_REPLY_TEXT);
  });

  it('perintah asing (/settings) → satu balasan otomatis yang sama', async () => {
    await poll([variant({ text: '/settings', chatId: 777002, updateIdOffset: 101 })]);
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe(AUTO_REPLY_TEXT);
  });

  it('/start dan /help: perilaku lama TIDAK berubah dan tanpa balasan otomatis tambahan', async () => {
    await poll([variant({ text: '/start', chatId: 777003, updateIdOffset: 102 })]);
    expect(sends).toHaveLength(1); // welcome (sendPhoto, banner trial bot) — bukan auto reply
    expect(sends[0].method).toBe('sendPhoto');

    await poll([variant({ text: '/help', chatId: 777003, updateIdOffset: 103 })]);
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe(HELP_MESSAGE_TEXT); // balasan /help, bukan AUTO_REPLY_TEXT
  });

  it('pesan dari grup → tidak dibalas sama sekali', async () => {
    await poll([variant({ text: 'halo grup', chatId: -100123, updateIdOffset: 104, chatType: 'group' })]);
    expect(sends).toHaveLength(0);
  });

  it('dua pesan dari chat yang sama dalam 10 menit → hanya SATU balasan', async () => {
    await poll([variant({ text: 'pertama', chatId: 777005, updateIdOffset: 105 })]);
    expect(sends).toHaveLength(1);
    await poll([variant({ text: 'kedua', chatId: 777005, updateIdOffset: 106 })]);
    expect(sends).toHaveLength(0); // masih di jendela 10 menit — tidak dibalas lagi
  });

  it('pesan dari bot lain (from.is_bot) → tidak dibalas', async () => {
    await poll([variant({ text: 'halo', chatId: 777006, updateIdOffset: 107, fromIsBot: true })]);
    expect(sends).toHaveLength(0);
  });

  it('pesan tanpa teks (stiker/foto) di private → satu balasan otomatis', async () => {
    await poll([variant({ text: undefined, chatId: 777007, updateIdOffset: 108 })]);
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe(AUTO_REPLY_TEXT);
  });
});
