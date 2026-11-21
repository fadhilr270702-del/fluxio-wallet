/**
 * Prompt 0250 — unit tests for the PURE helpers behind
 * backend/scripts/fetchStartFixture.js's group mode. These test the capture
 * TOOL (does it redact everything, does it pick the right update), so the
 * input objects here are hand-built on purpose and claim nothing about what
 * a real Telegram group update looks like — that is exactly what the real
 * fixtures this tool writes are for.
 */
import { describe, it, expect } from 'vitest';
import { redactDeep, pickGroupStartUpdates, GROUP_FIXTURE_FILES, BOT_TOKEN_SHAPE, REDACTED_KEYS } from '../../../scripts/startFixtureHelpers.js';

const SECRET_STRINGS = ['Nama Depan', 'Nama Belakang', 'namapengguna', 'Judul Grup Rahasia', 'Admin Anonim', 'judulbalasan', 'Pengirim Asal'];

const rawUpdate = {
  update_id: 500,
  message: {
    message_id: 7,
    from: { id: 111, is_bot: false, first_name: 'Nama Depan', last_name: 'Nama Belakang', username: 'namapengguna', language_code: 'id' },
    sender_chat: { id: -100222, title: 'Admin Anonim', type: 'supergroup' },
    chat: { id: -100222, title: 'Judul Grup Rahasia', type: 'supergroup', username: 'namapengguna' },
    reply_to_message: { message_id: 6, chat: { id: -100222, title: 'judulbalasan', type: 'supergroup' }, from: { id: 333, first_name: 'Pengirim Asal' } },
    date: 1790000000,
    text: '/start@SomeFixture_bot',
    entities: [{ offset: 0, length: 22, type: 'bot_command' }]
  }
};

describe('redactDeep', () => {
  it('redacts every name and title at any depth and leaves no original string behind', () => {
    const out = redactDeep(rawUpdate);
    const serialized = JSON.stringify(out);
    for (const secret of SECRET_STRINGS) expect(serialized.includes(secret)).toBe(false);
    expect(out.message.chat.title).toBe('redacted');
    expect(out.message.from.first_name).toBe('redacted');
    expect(out.message.from.last_name).toBe('redacted');
    expect(out.message.from.username).toBe('redacted');
    expect(out.message.sender_chat.title).toBe('redacted');
    expect(out.message.reply_to_message.chat.title).toBe('redacted');
    expect(out.message.reply_to_message.from.first_name).toBe('redacted');
  });

  it('keeps everything that is not a name: ids, chat.type, text, entities, dates', () => {
    const out = redactDeep(rawUpdate);
    expect(out.update_id).toBe(500);
    expect(out.message.chat.id).toBe(-100222);
    expect(out.message.chat.type).toBe('supergroup');
    expect(out.message.from.id).toBe(111);
    expect(out.message.from.is_bot).toBe(false);
    expect(out.message.from.language_code).toBe('id');
    expect(out.message.text).toBe('/start@SomeFixture_bot');
    expect(out.message.entities).toEqual([{ offset: 0, length: 22, type: 'bot_command' }]);
    expect(out.message.date).toBe(1790000000);
  });

  it('does not mutate its input and does not invent keys that were absent', () => {
    const before = JSON.stringify(rawUpdate);
    const out = redactDeep({ message: { chat: { id: -5, type: 'group' }, from: { id: 1 } } });
    expect(JSON.stringify(rawUpdate)).toBe(before);
    for (const key of REDACTED_KEYS) {
      expect(key in out.message.chat).toBe(false);
      expect(key in out.message.from).toBe(false);
    }
  });
});

describe('pickGroupStartUpdates', () => {
  const u = (update_id, type, text) => ({ update_id, message: { chat: { id: type === 'private' ? 9 : -9, type }, text } });

  it('picks the latest /start per group chat type and ignores private chats, other text and non-message updates', () => {
    const picked = pickGroupStartUpdates([
      u(1, 'private', '/start'),
      u(2, 'group', '/start'),
      u(3, 'group', 'halo'),
      u(4, 'group', '/start@SomeFixture_bot'),
      u(5, 'supergroup', '/start'),
      { update_id: 6, message: { chat: { id: -9, type: 'supergroup' }, migrate_from_chat_id: -9 } },
      { update_id: 7, my_chat_member: {} },
      u(8, 'channel', '/start')
    ]);
    expect(picked.group.update_id).toBe(4);
    expect(picked.supergroup.update_id).toBe(5);
  });

  it('returns null for a chat type that has no pending /start', () => {
    expect(pickGroupStartUpdates([u(2, 'group', '/start')])).toEqual({ group: u(2, 'group', '/start'), supergroup: null });
    expect(pickGroupStartUpdates([])).toEqual({ group: null, supergroup: null });
    expect(pickGroupStartUpdates(undefined)).toEqual({ group: null, supergroup: null });
  });
});

describe('constants', () => {
  it('maps the two chat types to the two owner-specified fixture file names', () => {
    expect(GROUP_FIXTURE_FILES).toEqual({ group: 'start-group.json', supergroup: 'start-supergroup.json' });
  });

  it('BOT_TOKEN_SHAPE matches a bot token shape and not an ordinary update', () => {
    expect(BOT_TOKEN_SHAPE.test('1234567890:' + 'A'.repeat(35))).toBe(true);
    expect(BOT_TOKEN_SHAPE.test(JSON.stringify(redactDeep(rawUpdate)))).toBe(false);
  });
});
