import { describe, it, expect } from 'vitest';
import {
  captionLimitFor,
  buildBroadcastMessage,
  computeCaptionLength,
  stripToPlainText,
  plainTextLength,
  sanitizeTelegramHtml,
  degradeForChannel
} from '../formatting.js';

// Prompt 0136 — formatting.js's own pure functions (plainTextLength,
// computeCaptionLength, sanitizeTelegramHtml) predate this prompt and
// weren't asked to gain test coverage retroactively; captionLimitFor is
// the one new piece of logic this prompt adds here, so it's the one that
// gets a test file, matching this repo's "narrow, deliberately-scoped"
// testing philosophy from prompts 0134/0135.
describe('captionLimitFor', () => {
  it('returns Telegram\'s 1024 caption cap when an image is attached', () => {
    expect(captionLimitFor(true)).toBe(1024);
  });

  it('returns Telegram\'s 4096 plain-message cap when no image is attached', () => {
    expect(captionLimitFor(false)).toBe(4096);
  });
});

// Prompt 0149 — title becomes independently formattable from body, so the
// 4 genuine title_format x body_format combinations all need their own
// case: a broadcast can have an 'html' body from the original rich-text
// slice with a 'plain' title predating title formatting, or vice versa
// once only one field is re-saved through "Edit isi".
describe('buildBroadcastMessage — title_format x body_format matrix', () => {
  it('plain title + plain body: byte-identical to every pre-rich-text broadcast (no escaping, no parse_mode)', () => {
    const result = buildBroadcastMessage({
      title: 'Sale <today>', title_format: 'plain',
      body: 'Get it while it lasts & save 20%', body_format: 'plain'
    });
    expect(result).toEqual({
      text: 'Sale <today>\n\nGet it while it lasts & save 20%',
      parseMode: undefined
    });
  });

  it('plain title + html body: parse_mode HTML, title escaped (so its literal < > survive), body sanitized', () => {
    const result = buildBroadcastMessage({
      title: 'Sale <today>', title_format: 'plain',
      body: '<b>Get it now</b>', body_format: 'html'
    });
    expect(result.parseMode).toBe('HTML');
    expect(result.text).toBe('Sale &lt;today&gt;\n\n<b>Get it now</b>');
  });

  it('html title + plain body: parse_mode HTML, title sanitized, body escaped (so its literal < > survive)', () => {
    const result = buildBroadcastMessage({
      title: '<b>Big Sale</b>', title_format: 'html',
      body: 'See <details> below', body_format: 'plain'
    });
    expect(result.parseMode).toBe('HTML');
    expect(result.text).toBe('<b>Big Sale</b>\n\nSee &lt;details&gt; below');
  });

  it('html title + html body: parse_mode HTML, both sanitized', () => {
    const result = buildBroadcastMessage({
      title: '<b>Big Sale</b>', title_format: 'html',
      body: '<i>Get it now</i>', body_format: 'html'
    });
    expect(result.parseMode).toBe('HTML');
    expect(result.text).toBe('<b>Big Sale</b>\n\n<i>Get it now</i>');
  });

  it('an invalid-link <a> in an html title is defensively re-sanitized the same way body already is (href dropped, not the whole message rejected)', () => {
    // Confirmed against the real sanitizeTelegramHtml() directly, not
    // assumed: an invalid-scheme href is stripped by its own
    // allowedSchemes:['https'] option before transformTags ever runs, so
    // what survives is the <a> tag WITHOUT an href — not fully unwrapped
    // to plain text. (In the live app this exact shape is unreachable via
    // the normal save path — the zod schema rejects a create/update
    // request with an invalid link before it's ever stored — this only
    // exercises buildBroadcastMessage's own defensive re-sanitization at
    // send time, its documented "must never fail to send" contract.)
    const result = buildBroadcastMessage({
      title: '<a href="http://insecure.example">Click</a>', title_format: 'html',
      body: 'plain body', body_format: 'plain'
    });
    expect(result.text).toBe('<a>Click</a>\n\nplain body');
  });
});

describe('stripToPlainText', () => {
  it('returns an html value with tags stripped and entities decoded', () => {
    expect(stripToPlainText('<b>Hello</b> &amp; welcome', 'html')).toBe('Hello & welcome');
  });

  it('returns a plain value completely untouched, literal < > included', () => {
    expect(stripToPlainText('Hello <world>', 'plain')).toBe('Hello <world>');
  });

  it('treats a missing/undefined format the same as plain', () => {
    expect(stripToPlainText('Hello <world>', undefined)).toBe('Hello <world>');
  });
});

// Prompt 0153 — sanitizeTelegramHtml() gains <tg-emoji emoji-id="..."> to
// its whitelist. A digits-only id (a real custom_emoji_id's own shape) is
// kept with every OTHER attribute stripped; anything else is unwrapped to
// its own fallback text, same "never lose text, even when a wrapper isn't
// recognized" posture the rest of this sanitizer already has.
describe('sanitizeTelegramHtml — tg-emoji whitelist', () => {
  it('keeps a valid digits-only emoji-id, alongside existing marks', () => {
    const { html } = sanitizeTelegramHtml('<b>Bold</b> then <tg-emoji emoji-id="12345">⭐</tg-emoji> after');
    expect(html).toBe('<b>Bold</b> then <tg-emoji emoji-id="12345">⭐</tg-emoji> after');
  });

  it('unwraps a tg-emoji with a non-digits emoji-id, keeping the fallback text', () => {
    const { html } = sanitizeTelegramHtml('<tg-emoji emoji-id="abc123">⭐</tg-emoji>');
    expect(html).toBe('⭐');
  });

  it('unwraps a tg-emoji with no emoji-id at all', () => {
    const { html } = sanitizeTelegramHtml('<tg-emoji>⭐</tg-emoji>');
    expect(html).toBe('⭐');
  });

  it('unwraps a tg-emoji whose emoji-id is empty', () => {
    const { html } = sanitizeTelegramHtml('<tg-emoji emoji-id="">⭐</tg-emoji>');
    expect(html).toBe('⭐');
  });

  it('strips any other attribute on a valid tg-emoji tag, keeping only emoji-id', () => {
    const { html } = sanitizeTelegramHtml('<tg-emoji emoji-id="999" onclick="evil()" class="x" data-foo="bar">🪙</tg-emoji>');
    expect(html).toBe('<tg-emoji emoji-id="999">🪙</tg-emoji>');
  });

  it('rejects an emoji-id longer than 32 digits (never a real custom_emoji_id shape)', () => {
    const { html } = sanitizeTelegramHtml(`<tg-emoji emoji-id="${'1'.repeat(33)}">⭐</tg-emoji>`);
    expect(html).toBe('⭐');
  });

  it('accepts an emoji-id exactly 32 digits long', () => {
    const id = '1'.repeat(32);
    const { html } = sanitizeTelegramHtml(`<tg-emoji emoji-id="${id}">⭐</tg-emoji>`);
    expect(html).toBe(`<tg-emoji emoji-id="${id}">⭐</tg-emoji>`);
  });

  it('a tg-emoji nested inside bold keeps both, correctly nested', () => {
    const { html } = sanitizeTelegramHtml('<b>before <tg-emoji emoji-id="111">🎉</tg-emoji> after</b>');
    expect(html).toBe('<b>before <tg-emoji emoji-id="111">🎉</tg-emoji> after</b>');
  });

  it('does not affect existing link-validation behavior alongside a tg-emoji', () => {
    const { html, hadInvalidLink } = sanitizeTelegramHtml('<tg-emoji emoji-id="1">⭐</tg-emoji> <a href="http://insecure.example">bad</a>');
    expect(hadInvalidLink).toBe(true);
    expect(html).toBe('<tg-emoji emoji-id="1">⭐</tg-emoji> <a>bad</a>');
  });
});

// Prompt 0153 — plainTextLength/stripToPlainText need ZERO code changes for
// this: they already strip any `<tag>`/`</tag>` generically via regex, so a
// <tg-emoji emoji-id="...">fallback</tg-emoji> already measures as exactly
// its own fallback content, the same way <b>/<i>/etc. already do. These
// tests exist to prove that claim directly rather than leaving it assumed.
describe('plainTextLength/stripToPlainText — tg-emoji counts as its fallback (no code change needed)', () => {
  it('strips a tg-emoji tag down to its fallback text', () => {
    expect(stripToPlainText('<b>bold</b> then <tg-emoji emoji-id="123">⭐</tg-emoji> after', 'html')).toBe('bold then ⭐ after');
  });

  it('measures the length counting only the fallback, not the tag markup', () => {
    // 'bold then ' (10) + '⭐' (1 UTF-16 unit) + ' after' (6) = 17
    expect(plainTextLength('bold then <tg-emoji emoji-id="123">⭐</tg-emoji> after', 'html')).toBe(17);
  });

  it('counts a MULTI-UTF-16-UNIT fallback emoji at its real UTF-16 length, not 1', () => {
    // 🎉 is a surrogate pair — 2 UTF-16 code units, matching how Telegram
    // itself counts entity lengths (JS string .length, not code points).
    expect(plainTextLength('<tg-emoji emoji-id="1">🎉</tg-emoji>', 'html')).toBe(2);
  });
});

// Prompt 0153 — degradeForChannel() is the explicit, unit-tested per-target
// safeguard for a channel send (see its own header for why this doesn't
// rely on Telegram's own undocumented channel behavior).
describe('degradeForChannel', () => {
  it('replaces a tg-emoji tag with its plain fallback text', () => {
    const result = degradeForChannel({ text: 'Hello <tg-emoji emoji-id="123">⭐</tg-emoji> world', replyMarkup: undefined });
    expect(result.text).toBe('Hello ⭐ world');
  });

  it('leaves surrounding marks (bold/link/etc.) completely untouched', () => {
    const result = degradeForChannel({
      text: '<b>Bold</b> then <tg-emoji emoji-id="1">🎉</tg-emoji> then <a href="https://example.com">link</a>',
      replyMarkup: undefined
    });
    expect(result.text).toBe('<b>Bold</b> then 🎉 then <a href="https://example.com">link</a>');
  });

  it('degrades multiple tg-emoji occurrences in one message', () => {
    const result = degradeForChannel({
      text: '<tg-emoji emoji-id="1">🎉</tg-emoji> and <tg-emoji emoji-id="2">🔥</tg-emoji>',
      replyMarkup: undefined
    });
    expect(result.text).toBe('🎉 and 🔥');
  });

  it('leaves text with no tg-emoji at all completely unchanged', () => {
    const result = degradeForChannel({ text: '<b>Plain bold text</b>', replyMarkup: undefined });
    expect(result.text).toBe('<b>Plain bold text</b>');
  });

  it('strips icon_custom_emoji_id from every button, keeping text/url', () => {
    const replyMarkup = {
      inline_keyboard: [
        [{ text: 'Open', url: 'https://example.com', icon_custom_emoji_id: '999' }],
        [{ text: 'Plain', url: 'https://example.com/2' }]
      ]
    };
    const result = degradeForChannel({ text: 'hi', replyMarkup });
    expect(result.replyMarkup).toEqual({
      inline_keyboard: [
        [{ text: 'Open', url: 'https://example.com' }],
        [{ text: 'Plain', url: 'https://example.com/2' }]
      ]
    });
  });

  it('passes through undefined replyMarkup (no buttons) unchanged', () => {
    const result = degradeForChannel({ text: 'hi', replyMarkup: undefined });
    expect(result.replyMarkup).toBeUndefined();
  });

  it('never mutates the original replyMarkup object', () => {
    const original = { inline_keyboard: [[{ text: 'a', url: 'https://x.com', icon_custom_emoji_id: '1' }]] };
    const snapshot = JSON.parse(JSON.stringify(original));
    degradeForChannel({ text: 'hi', replyMarkup: original });
    expect(original).toEqual(snapshot);
  });
});

describe('computeCaptionLength — title and body measured independently by their own format', () => {
  it('plain title + plain body: raw lengths, +2 for the separator', () => {
    // 'Hi' (2) + 2 + 'there' (5) = 9
    expect(computeCaptionLength('Hi', 'plain', 'there', 'plain')).toBe(9);
  });

  it('html title measured by its PLAIN-TEXT length, not its raw markup length', () => {
    // '<b>Hi</b>' plain-texts to 'Hi' (2), + 2 + 'there' (5) = 9 — identical
    // to the plain-title case above despite the raw string being much longer.
    expect(computeCaptionLength('<b>Hi</b>', 'html', 'there', 'plain')).toBe(9);
    expect(plainTextLength('<b>Hi</b>', 'html')).toBe(2);
  });

  it('html title + html body, both measured by plain-text length', () => {
    // '<b>Hi</b>' -> 'Hi' (2) + 2 + '<i>there</i>' -> 'there' (5) = 9
    expect(computeCaptionLength('<b>Hi</b>', 'html', '<i>there</i>', 'html')).toBe(9);
  });
});
