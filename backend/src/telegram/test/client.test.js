import { describe, it, expect } from 'vitest';
import { buildInlineKeyboard } from '../client.js';

// buildInlineKeyboard() is pure and bot-agnostic (touches no token, no
// network) — see its own header comment — so it gets direct unit coverage
// rather than being verified only through a live send, unlike the rest of
// this file's token-bearing methods.
describe('buildInlineKeyboard', () => {
  it('returns undefined for no buttons, so reply_markup is omitted entirely', () => {
    expect(buildInlineKeyboard([])).toBeUndefined();
    expect(buildInlineKeyboard(null)).toBeUndefined();
    expect(buildInlineKeyboard(undefined)).toBeUndefined();
  });

  it('builds a plain {text, url} button with no icon_custom_emoji_id key at all when none is stored', () => {
    const result = buildInlineKeyboard([{ text: 'Open', url: 'https://example.com' }]);
    expect(result).toEqual({ inline_keyboard: [[{ text: 'Open', url: 'https://example.com' }]] });
    expect('icon_custom_emoji_id' in result.inline_keyboard[0][0]).toBe(false);
  });

  // Prompt 0153 — icon_custom_emoji_id (Bot API 9.4).
  describe('icon_custom_emoji_id (prompt 0153)', () => {
    it('includes icon_custom_emoji_id when a button has one stored', () => {
      const result = buildInlineKeyboard([{ text: 'Open', url: 'https://example.com', iconCustomEmojiId: '5267500801240092311' }]);
      expect(result).toEqual({
        inline_keyboard: [[{ text: 'Open', url: 'https://example.com', icon_custom_emoji_id: '5267500801240092311' }]]
      });
    });

    it('mixes an iconed button and a plain one, one row each, in order', () => {
      const result = buildInlineKeyboard([
        { text: 'Iconed', url: 'https://a.com', iconCustomEmojiId: '111' },
        { text: 'Plain', url: 'https://b.com' }
      ]);
      expect(result).toEqual({
        inline_keyboard: [
          [{ text: 'Iconed', url: 'https://a.com', icon_custom_emoji_id: '111' }],
          [{ text: 'Plain', url: 'https://b.com' }]
        ]
      });
    });

    it('treats a null/empty iconCustomEmojiId the same as absent — no key added', () => {
      const resultNull = buildInlineKeyboard([{ text: 'a', url: 'https://x.com', iconCustomEmojiId: null }]);
      expect('icon_custom_emoji_id' in resultNull.inline_keyboard[0][0]).toBe(false);
      const resultEmpty = buildInlineKeyboard([{ text: 'a', url: 'https://x.com', iconCustomEmojiId: '' }]);
      expect('icon_custom_emoji_id' in resultEmpty.inline_keyboard[0][0]).toBe(false);
    });
  });
});
