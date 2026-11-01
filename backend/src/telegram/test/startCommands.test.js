/**
 * Prompt 0233 — pure helpers behind /start attribution and the /help reply.
 * Same direct unit-test treatment every other pure telegram helper gets
 * (shouldSendWelcome, isRecurringDue, ...). The behavioral end-to-end tests
 * (pollOnce against a REAL captured Update) live in startSource.test.js and
 * require the archived fixture.
 */
import { describe, it, expect } from 'vitest';
import { parseStartPayload, isHelpCommand, HELP_MESSAGE_TEXT, isUnknownPrivateMessage, AUTO_REPLY_TEXT } from '../startCommands.js';

describe('parseStartPayload', () => {
  it('extracts a valid deep-link payload', () => {
    expect(parseStartPayload('/start ads_2026_10_a')).toBe('ads_2026_10_a');
  });

  it('extracts the payload when the command carries the bot username', () => {
    expect(parseStartPayload('/start@PercobaanPanel_bot ads_2026_10_a')).toBe('ads_2026_10_a');
  });

  it('accepts hyphens and mixed case (the full Telegram deep-link charset)', () => {
    expect(parseStartPayload('/start Ads-2026-10-B')).toBe('Ads-2026-10-B');
  });

  it('returns null for a bare /start (organic)', () => {
    expect(parseStartPayload('/start')).toBe(null);
  });

  it('returns null for characters outside the deep-link charset', () => {
    expect(parseStartPayload('/start ads!bad')).toBe(null);
  });

  it('returns null for more than one payload word', () => {
    expect(parseStartPayload('/start ads_2026_10_a extra')).toBe(null);
  });

  it('returns null for a payload longer than 64 characters', () => {
    expect(parseStartPayload(`/start ${'a'.repeat(65)}`)).toBe(null);
  });

  it('accepts a payload of exactly 64 characters', () => {
    expect(parseStartPayload(`/start ${'a'.repeat(64)}`)).toBe('a'.repeat(64));
  });

  it('returns null for non-start text and non-strings', () => {
    expect(parseStartPayload('/starting ads_2026_10_a')).toBe(null);
    expect(parseStartPayload('hello')).toBe(null);
    expect(parseStartPayload(undefined)).toBe(null);
  });
});

describe('isHelpCommand', () => {
  it('matches /help and /help@BotUsername only', () => {
    expect(isHelpCommand('/help')).toBe(true);
    expect(isHelpCommand('/help@PercobaanPanel_bot')).toBe(true);
    expect(isHelpCommand('/helpme')).toBe(false);
    expect(isHelpCommand('/help now')).toBe(false);
    expect(isHelpCommand('/start')).toBe(false);
    expect(isHelpCommand(undefined)).toBe(false);
  });
});

describe('HELP_MESSAGE_TEXT', () => {
  it('is the exact owner-approved wording (plain text, no hyphen, no newline)', () => {
    expect(HELP_MESSAGE_TEXT).toBe(
      'Fluxio Wallet official bot. You receive product announcements here. Get the wallet at fluxiowallet.com. We will never DM you first or ask for your seed phrase.'
    );
    expect(HELP_MESSAGE_TEXT.includes('\n')).toBe(false);
    expect(HELP_MESSAGE_TEXT.includes('-')).toBe(false);
  });
});
// Prompt 0236 — klasifikasi pesan pribadi yang TIDAK dijawab /start maupun /help.
describe('isUnknownPrivateMessage', () => {
  const msg = (over = {}, chatOver = {}, fromOver = {}) => ({
    update_id: 1,
    message: { text: 'halo', chat: { id: 1, type: 'private', ...chatOver }, from: { id: 2, is_bot: false, ...fromOver }, ...over }
  });

  it('true untuk teks bebas, perintah asing, dan pesan tanpa teks (stiker/foto) di chat private', () => {
    expect(isUnknownPrivateMessage(msg())).toBe(true);
    expect(isUnknownPrivateMessage(msg({ text: '/settings' }))).toBe(true);
    expect(isUnknownPrivateMessage(msg({ text: undefined }))).toBe(true);
  });

  it('false untuk /start (termasuk berpayload), /help, grup/channel, pengirim bot, dan update tanpa message', () => {
    expect(isUnknownPrivateMessage(msg({ text: '/start' }))).toBe(false);
    expect(isUnknownPrivateMessage(msg({ text: '/start ads_2026_10_a' }))).toBe(false);
    expect(isUnknownPrivateMessage(msg({ text: '/help' }))).toBe(false);
    expect(isUnknownPrivateMessage(msg({}, { type: 'group' }))).toBe(false);
    expect(isUnknownPrivateMessage(msg({}, { type: 'channel' }))).toBe(false);
    expect(isUnknownPrivateMessage(msg({}, {}, { is_bot: true }))).toBe(false);
    expect(isUnknownPrivateMessage({ update_id: 1 })).toBe(false);
  });
});

describe('AUTO_REPLY_TEXT', () => {
  it('teks persis milik pemilik, tanpa tanda hubung dan tanpa baris baru', () => {
    expect(AUTO_REPLY_TEXT).toBe(
      'Thanks for your message. This bot only sends Fluxio announcements and does not read replies. For help, message @FluxioWallet or email fluxio.wallet@gmail.com. We will never DM you first or ask for your seed phrase.'
    );
    expect(AUTO_REPLY_TEXT.includes(String.fromCharCode(10))).toBe(false);
    expect(AUTO_REPLY_TEXT.split('@')[0].includes(String.fromCharCode(45))).toBe(false);
    expect(HELP_MESSAGE_TEXT === AUTO_REPLY_TEXT).toBe(false);
  });
});

