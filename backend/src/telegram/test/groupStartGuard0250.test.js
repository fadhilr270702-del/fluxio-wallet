/**
 * Prompt 0250 (catatan 24) — the bot serves PRIVATE chats only. Driven
 * through the REAL pollOnce() path with the two REAL group updates the
 * owner captured on 20 November 2026 with a temporary bot
 * (prompt/evidence/0250-group-start/start-group.json and
 * start-supergroup.json — a plain "/start" typed inside a basic group and
 * inside the same group after it became a supergroup; names redacted by
 * backend/scripts/fetchStartFixture.js --group), plus the real PRIVATE
 * /start from prompt 0233 as the "private still works" control.
 *
 * Where a case needs another message text (/start@Bot, /help, free text)
 * it is a clone of a REAL group fixture with ONLY message.text (and the
 * update_id) changed — the chat/from shape stays exactly what Telegram
 * sent. Two cases are explicitly NOT real shapes and say so in their
 * names: chat.type 'channel' and a missing chat.type exist only to pin the
 * guard's fail-closed rule.
 *
 * Harness: the 0233 one — temp DB, dummy trial-bot token, globalThis.fetch
 * stubbed so nothing can reach Telegram and no backend process is spawned.
 * Like the other fixture-driven suites, this one SKIPS when the fixtures
 * are absent (the public snapshot ships no prompt/ folder).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, '../../../../prompt/evidence');
const GROUP_PATH = path.join(EVIDENCE, '0250-group-start/start-group.json');
const SUPERGROUP_PATH = path.join(EVIDENCE, '0250-group-start/start-supergroup.json');
const PRIVATE_PATH = path.join(EVIDENCE, '0233-telegram-ads-test/start-with-payload.json');
const fixturesExist = existsSync(GROUP_PATH) && existsSync(SUPERGROUP_PATH) && existsSync(PRIVATE_PATH);

let pollOnce;
let findSubscriberByChatId;
let getOffset;
let getDb;
let AUTO_REPLY_TEXT;
let HELP_MESSAGE_TEXT;
let tempDir;
let groupFixture;
let supergroupFixture;
let privateFixture;

const sends = []; // { method, chatId }
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
      sends.push({ method: 'sendMessage', chatId: String(body.chat_id), text: body.text });
      return reply({ message_id: 9000 + sends.length });
    }
    if (u.endsWith('/sendPhoto') || u.endsWith('/sendVideo')) {
      // The welcome goes out as a multipart upload (legacy trial banner).
      sends.push({ method: 'welcome', chatId: String(options.body.get('chat_id')), text: null });
      return reply({ message_id: 9000 + sends.length });
    }
    throw new Error(`fetch tak terduga di groupStartGuard0250: ${u}`);
  };
}

describe.skipIf(!fixturesExist)('/start di grup: diam total, tanpa baris subscriber (fixture grup NYATA, temp DB, fetch distub)', () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-group-guard-0250-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
    process.env.TELEGRAM_BOT_TOKEN_TEST = '123456:group-guard-dummy';
    delete process.env.TELEGRAM_DISABLED;
    installFetchStub();

    const { runMigrations } = await import('../../db/migrate.js');
    runMigrations();
    ({ getDb } = await import('../../db/client.js'));
    ({ pollOnce } = await import('../poller.js'));
    ({ findSubscriberByChatId } = await import('../../db/repositories/telegramSubscribersRepo.js'));
    ({ getOffset } = await import('../../db/repositories/telegramPollStateRepo.js'));
    ({ AUTO_REPLY_TEXT, HELP_MESSAGE_TEXT } = await import('../startCommands.js'));

    groupFixture = JSON.parse(readFileSync(GROUP_PATH, 'utf8'));
    supergroupFixture = JSON.parse(readFileSync(SUPERGROUP_PATH, 'utf8'));
    privateFixture = JSON.parse(readFileSync(PRIVATE_PATH, 'utf8'));
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN_TEST;
    if (getDb) getDb().close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const subscriberCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM telegram_subscribers').get().n;
  const groupRowCount = () => getDb().prepare("SELECT COUNT(*) AS n FROM telegram_subscribers WHERE chat_id LIKE '-%'").get().n;

  /** A REAL group update with only the text (and update_id) changed; `text: undefined` removes text + entities (a sticker/photo shape). */
  function withText(real, text, updateId) {
    const message = { ...real.message, text };
    if (text === undefined) {
      delete message.text;
      delete message.entities;
    }
    return { ...real, update_id: updateId, message };
  }

  async function poll(batch) {
    sends.length = 0;
    nextBatch = batch;
    await pollOnce('test');
  }

  it('fixture nyata: grup biasa dan supergroup, teks "/start" polos, nama diredaksi, tanpa bentuk token', () => {
    expect(groupFixture.message.chat.type).toBe('group');
    expect(supergroupFixture.message.chat.type).toBe('supergroup');
    for (const fixture of [groupFixture, supergroupFixture]) {
      expect(fixture.message.text).toBe('/start');
      expect(fixture.message.chat.id).toBeLessThan(0);
      expect(fixture.message.chat.title).toBe('redacted');
      expect(fixture.message.from.first_name).toBe('redacted');
      expect(fixture.message.from.username).toBe('redacted');
      expect(fixture.message.from.is_bot).toBe(false);
      expect(/\d{8,}:[A-Za-z0-9_-]{30,}/.test(JSON.stringify(fixture))).toBe(false);
    }
    expect(String(supergroupFixture.message.chat.id).startsWith('-100')).toBe(true);
  });

  it('/start NYATA di grup biasa: tidak ada baris subscriber, tidak ada welcome, offset tetap maju', async () => {
    await poll([groupFixture]);
    expect(sends).toEqual([]);
    expect(findSubscriberByChatId('test', String(groupFixture.message.chat.id))).toBeNull();
    expect(subscriberCount()).toBe(0);
    expect(getOffset('test')).toBe(groupFixture.update_id + 1);
  });

  it('/start NYATA di supergroup: tidak ada baris subscriber, tidak ada welcome, offset tetap maju', async () => {
    await poll([supergroupFixture]);
    expect(sends).toEqual([]);
    expect(findSubscriberByChatId('test', String(supergroupFixture.message.chat.id))).toBeNull();
    expect(subscriberCount()).toBe(0);
    expect(getOffset('test')).toBe(supergroupFixture.update_id + 1);
  });

  it('/start@Bot dan /start berpayload iklan di grup dan supergroup: tetap diam, tetap tanpa baris', async () => {
    const base = supergroupFixture.update_id;
    await poll([
      withText(groupFixture, '/start@FluxioFixture0250_bot', base + 1),
      withText(supergroupFixture, '/start@FluxioFixture0250_bot', base + 2),
      withText(groupFixture, '/start ads_2026_10_a', base + 3),
      withText(supergroupFixture, '/start ads_2026_10_a', base + 4)
    ]);
    expect(sends).toEqual([]);
    expect(subscriberCount()).toBe(0);
    expect(getOffset('test')).toBe(base + 5);
  });

  it('/help dan /help@Bot di grup dan supergroup: tidak dibalas (Opsi A, diam total)', async () => {
    const base = supergroupFixture.update_id + 10;
    await poll([
      withText(groupFixture, '/help', base + 1),
      withText(supergroupFixture, '/help', base + 2),
      withText(groupFixture, '/help@FluxioFixture0250_bot', base + 3),
      withText(supergroupFixture, '/help@FluxioFixture0250_bot', base + 4)
    ]);
    expect(sends).toEqual([]);
    expect(subscriberCount()).toBe(0);
  });

  it('teks bebas, perintah asing dan pesan tanpa teks di grup dan supergroup: balasan otomatis 0236 tidak terpicu', async () => {
    const base = supergroupFixture.update_id + 20;
    await poll([
      withText(groupFixture, 'halo semua', base + 1),
      withText(supergroupFixture, 'halo semua', base + 2),
      withText(groupFixture, '/settings', base + 3),
      withText(supergroupFixture, '/settings', base + 4),
      withText(groupFixture, undefined, base + 5),
      withText(supergroupFixture, undefined, base + 6)
    ]);
    expect(sends).toEqual([]);
    expect(subscriberCount()).toBe(0);
  });

  it('jalur injeksi (dry run verifikasi) juga diam untuk grup: tidak ada kiriman welcome ke grup', async () => {
    sends.length = 0;
    await pollOnce('test', async () => [groupFixture, supergroupFixture]);
    expect(sends).toEqual([]);
    expect(subscriberCount()).toBe(0);
  });

  it('BUKAN bentuk nyata, hanya mengunci aturan gagal tertutup: chat.type channel dan chat.type hilang diperlakukan bukan private', async () => {
    const base = supergroupFixture.update_id + 30;
    const asChannel = { ...groupFixture, update_id: base + 1, message: { ...groupFixture.message, chat: { ...groupFixture.message.chat, type: 'channel' } } };
    const noType = { ...groupFixture, update_id: base + 2, message: { ...groupFixture.message, chat: { id: groupFixture.message.chat.id } } };
    await poll([asChannel, noType]);
    expect(sends).toEqual([]);
    expect(subscriberCount()).toBe(0);
    expect(getOffset('test')).toBe(base + 3);
  });

  it('batch campuran: /start private NYATA (0233) tetap membuat SATU baris ber source dan SATU welcome, grup di batch yang sama tetap diam', async () => {
    const base = supergroupFixture.update_id + 40;
    const privateChatId = String(privateFixture.message.chat.id);
    await poll([
      withText(groupFixture, '/start', base + 1),
      { ...privateFixture, update_id: base + 2 },
      withText(supergroupFixture, '/start', base + 3)
    ]);
    expect(sends).toEqual([{ method: 'welcome', chatId: privateChatId, text: null }]);
    const row = findSubscriberByChatId('test', privateChatId);
    expect(row).not.toBeNull();
    expect(row.source).toBe('ads_2026_10_a');
    expect(row.is_active).toBe(1);
    expect(row.last_welcomed_update_id).toBe(base + 2);
    expect(subscriberCount()).toBe(1);
    expect(groupRowCount()).toBe(0);
    expect(getOffset('test')).toBe(base + 4);
  });

  it('private tetap seperti sebelumnya: /help dibalas satu pesan, teks bebas mendapat balasan otomatis 0236', async () => {
    const base = supergroupFixture.update_id + 50;
    const privateChatId = String(privateFixture.message.chat.id);
    await poll([{ ...privateFixture, update_id: base + 1, message: { ...privateFixture.message, text: '/help' } }]);
    expect(sends).toEqual([{ method: 'sendMessage', chatId: privateChatId, text: HELP_MESSAGE_TEXT }]);
    await poll([{ ...privateFixture, update_id: base + 2, message: { ...privateFixture.message, text: 'halo' } }]);
    expect(sends).toEqual([{ method: 'sendMessage', chatId: privateChatId, text: AUTO_REPLY_TEXT }]);
    expect(subscriberCount()).toBe(1);
    expect(groupRowCount()).toBe(0);
  });
});
