import { describe, it, expect } from 'vitest';
import { sanitizeRichHtml, stripToPlainText, plainTextLength } from '../richHtml.js';

// Prompt 0163 — the generic core extracted out of telegram/formatting.js's
// own sanitizeTelegramHtml()/stripToPlainText()/plainTextLength(); those
// three functions' own existing coverage (telegram/test/formatting.test.js,
// unchanged) is what proves the extraction didn't alter broadcast
// behavior. These tests exercise the shared module directly, with NO
// <tg-emoji> extras — the exact shape Announcements/Versions actually use.
describe('sanitizeRichHtml — base whitelist, no extras', () => {
  it('keeps every allowed tag: b, i, u, s, a href="https://..."', () => {
    const { html } = sanitizeRichHtml('<b>bold</b> <i>italic</i> <u>underline</u> <s>strike</s> <a href="https://example.com">link</a>');
    expect(html).toBe('<b>bold</b> <i>italic</i> <u>underline</u> <s>strike</s> <a href="https://example.com">link</a>');
  });

  it('strips a tag outside the whitelist, keeping its text content', () => {
    // sanitize-html special-cases <script> (removes the whole subtree,
    // content included, since script content is inherently dangerous) —
    // <p>/<div>/etc. are the ordinary "unwrap, keep text" case this test
    // means to exercise.
    const { html } = sanitizeRichHtml('<div>unwrapped</div>plain <p>paragraph</p>');
    expect(html).toBe('unwrappedplain paragraph');
  });

  it('removes a <script> tag AND its content entirely (sanitize-html\'s own dangerous-tag special case, not unwrap-keep-text)', () => {
    const { html } = sanitizeRichHtml('<script>evil()</script>plain text');
    expect(html).toBe('plain text');
  });

  it('never allows <tg-emoji> through — it is not in the base whitelist at all', () => {
    const { html } = sanitizeRichHtml('<tg-emoji emoji-id="123">⭐</tg-emoji>');
    expect(html).toBe('⭐');
  });

  it('strips a non-https link scheme, marking hadInvalidLink', () => {
    const { html, hadInvalidLink } = sanitizeRichHtml('<a href="http://insecure.example">bad</a>');
    expect(hadInvalidLink).toBe(true);
    expect(html).toBe('<a>bad</a>');
  });

  it('strips a link with no href at all, marking hadInvalidLink', () => {
    const { html, hadInvalidLink } = sanitizeRichHtml('<a>no href</a>');
    expect(hadInvalidLink).toBe(true);
    expect(html).toBe('<a>no href</a>');
  });

  it('a valid https link does not mark hadInvalidLink', () => {
    const { hadInvalidLink } = sanitizeRichHtml('<a href="https://example.com">ok</a>');
    expect(hadInvalidLink).toBe(false);
  });

  it('strips any other attribute on an allowed tag (e.g. onclick, style)', () => {
    const { html } = sanitizeRichHtml('<b onclick="evil()" style="color:red">bold</b>');
    expect(html).toBe('<b>bold</b>');
  });

  it('handles null/undefined input as empty', () => {
    expect(sanitizeRichHtml(null).html).toBe('');
    expect(sanitizeRichHtml(undefined).html).toBe('');
  });
});

describe('sanitizeRichHtml — extra tags/attributes (the exact mechanism telegram/formatting.js layers <tg-emoji> on top with)', () => {
  it('allows an extra tag only when explicitly passed in', () => {
    const { html } = sanitizeRichHtml('<x-test foo="bar">content</x-test>', {
      extraAllowedTags: ['x-test'],
      extraAllowedAttributes: { 'x-test': ['foo'] }
    });
    expect(html).toBe('<x-test foo="bar">content</x-test>');
  });

  it('an extraExclusiveFilter returning \'excludeTag\' drops just the tag, keeping its content — the exact mechanism sanitizeTelegramHtml uses for an invalid tg-emoji', () => {
    const { html } = sanitizeRichHtml('<x-test foo="reject">content</x-test>', {
      extraAllowedTags: ['x-test'],
      extraAllowedAttributes: { 'x-test': ['foo'] },
      extraExclusiveFilter: (frame) => (frame.tag === 'x-test' && frame.attribs.foo === 'reject' ? 'excludeTag' : false)
    });
    expect(html).toBe('content');
  });
});

describe('stripToPlainText / plainTextLength — reused unchanged from formatting.js, re-verified from the new location', () => {
  it('strips tags and decodes entities for an html value', () => {
    expect(stripToPlainText('<b>Hello</b> &amp; welcome', 'html')).toBe('Hello & welcome');
  });

  it('returns a plain value completely untouched, literal < > included', () => {
    expect(stripToPlainText('Hello <world>', 'plain')).toBe('Hello <world>');
  });

  it('treats a missing/undefined format the same as plain', () => {
    expect(stripToPlainText('Hello <world>', undefined)).toBe('Hello <world>');
  });

  it('plainTextLength measures the stripped length, not the raw markup length', () => {
    expect(plainTextLength('<b>bold</b> text', 'html')).toBe(9); // "bold text"
  });
});
