import { describe, it, expect } from 'vitest';
import { parseRichHtmlToNodes } from '../richTextNodes.js';

// Prompt 0163 follow-up (consolidation) — merges the two previously-separate
// parser test suites (formattedTelegramText.test.js, tested since prompt
// 0153, and richTextParse.test.js, its short-lived hand-duplicated
// near-copy from earlier in this same prompt arc) into one, testing the
// single shared parser both FormattedTelegramText.jsx and
// FormattedRichText.jsx now build on. Overlapping cases from the two old
// files were de-duplicated rather than kept twice; every DISTINCT behavior
// either file covered is still exercised here exactly once.
describe('parseRichHtmlToNodes', () => {
  it('parses plain text with no tags into a single text node', () => {
    expect(parseRichHtmlToNodes('Hello world')).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('parses a single bold tag', () => {
    expect(parseRichHtmlToNodes('<b>Bold</b>')).toEqual([
      { type: 'tag', tag: 'b', children: [{ type: 'text', text: 'Bold' }] }
    ]);
  });

  it('parses stacked/nested marks (bold > italic > underline > strike)', () => {
    const result = parseRichHtmlToNodes('<b><i><u><s>All four</s></u></i></b>');
    expect(result).toEqual([
      {
        type: 'tag', tag: 'b', children: [
          { type: 'tag', tag: 'i', children: [
            { type: 'tag', tag: 'u', children: [
              { type: 'tag', tag: 's', children: [{ type: 'text', text: 'All four' }] }
            ] }
          ] }
        ]
      }
    ]);
  });

  it('parses a valid https link with its href preserved', () => {
    const result = parseRichHtmlToNodes('<a href="https://example.com/page">Click here</a>');
    expect(result).toEqual([
      { type: 'tag', tag: 'a', href: 'https://example.com/page', children: [{ type: 'text', text: 'Click here' }] }
    ]);
  });

  it('unwraps a link with a non-https href (keeps text, drops the tag)', () => {
    const result = parseRichHtmlToNodes('<a href="http://insecure.example">Click</a>');
    expect(result).toEqual([{ type: 'text', text: 'Click' }]);
  });

  // Named explicitly (not just covered incidentally by the generic
  // non-https case above) because these are the classic script-executing
  // URL schemes — the guard is a positive allowlist (`href.startsWith
  // ('https://')`), so neither of these was ever accepted, but the
  // security-relevant behavior deserves its own named proof rather than
  // relying on a reader to infer it from an unrelated http:// example.
  it('unwraps a javascript: href — never rendered as a clickable link', () => {
    const result = parseRichHtmlToNodes('<a href="javascript:alert(1)">Click</a>');
    expect(result).toEqual([{ type: 'text', text: 'Click' }]);
  });

  it('unwraps a data: href — never rendered as a clickable link', () => {
    const result = parseRichHtmlToNodes('<a href="data:text/html,<script>alert(1)</script>">Click</a>');
    expect(result).toEqual([{ type: 'text', text: 'Click' }]);
  });

  it('unwraps a link with no href at all', () => {
    const result = parseRichHtmlToNodes('<a>Click</a>');
    expect(result).toEqual([{ type: 'text', text: 'Click' }]);
  });

  it('unwraps an unrecognized tag but keeps its text content', () => {
    const result = parseRichHtmlToNodes('<script>alert(1)</script>plain');
    expect(result).toEqual([{ type: 'text', text: 'alert(1)' }, { type: 'text', text: 'plain' }]);
  });

  // Prompt 0163 follow-up — the exact regression a hand-duplicated second
  // parser implementation introduced (its own tag-name regex initially
  // didn't allow a hyphen, so a hyphenated tag fell through to
  // literal-text handling instead of being recognized and safely
  // unwrapped). This is the ONE parser now, so this case is the standing
  // regression test for that class of bug — a hyphenated tag OUTSIDE the
  // b/i/u/s/a whitelist (not tg-emoji itself, to isolate "hyphen support
  // in the tag-name regex" from "tg-emoji's own specific handling", which
  // has its own dedicated tests below) must still be recognized as A TAG
  // and unwrapped (keeping its text), never rendered as raw angle-bracket
  // text.
  it('recognizes a hyphenated tag name outside the whitelist as a real tag and unwraps it — never falls through to literal angle-bracket text', () => {
    const result = parseRichHtmlToNodes('<x-custom>wrapped</x-custom> plain');
    expect(result).toEqual([
      { type: 'text', text: 'wrapped' },
      { type: 'text', text: ' plain' }
    ]);
  });

  it('decodes the 3 basic HTML entities in text content', () => {
    expect(parseRichHtmlToNodes('&lt;tag&gt; &amp; text')).toEqual([{ type: 'text', text: '<tag> & text' }]);
  });

  it('parses mixed plain text and formatted runs, plus a native emoji character, in one string', () => {
    const result = parseRichHtmlToNodes('Before 🎉 <b>bold part</b> after');
    expect(result).toEqual([
      { type: 'text', text: 'Before 🎉 ' },
      { type: 'tag', tag: 'b', children: [{ type: 'text', text: 'bold part' }] },
      { type: 'text', text: ' after' }
    ]);
  });

  it('handles a bold link (nested tag combination actually used by the editor)', () => {
    const result = parseRichHtmlToNodes('<b><a href="https://example.com">Link text</a></b>');
    expect(result).toEqual([
      { type: 'tag', tag: 'b', children: [
        { type: 'tag', tag: 'a', href: 'https://example.com', children: [{ type: 'text', text: 'Link text' }] }
      ] }
    ]);
  });

  it('handles empty/null/undefined/non-string input without throwing', () => {
    expect(parseRichHtmlToNodes('')).toEqual([]);
    expect(parseRichHtmlToNodes(null)).toEqual([]);
    expect(parseRichHtmlToNodes(undefined)).toEqual([]);
    expect(parseRichHtmlToNodes(42)).toEqual([]);
  });

  // <tg-emoji emoji-id="...">fallback</tg-emoji> — the one tag both
  // FormattedTelegramText.jsx (renders a real premium-emoji asset) and
  // FormattedRichText.jsx (unwraps to plain fallback text — Announcements/
  // Versions have no premium-emoji concept) rely on this shared parser to
  // recognize identically; only the RENDERING layer differs per component,
  // never the parsing.
  describe('tg-emoji', () => {
    it('parses a tg-emoji with a valid digits-only id into its own leaf node', () => {
      expect(parseRichHtmlToNodes('<tg-emoji emoji-id="12345">⭐</tg-emoji>')).toEqual([
        { type: 'tg-emoji', emojiId: '12345', fallback: '⭐' }
      ]);
    });

    it('parses mixed text, bold, and a tg-emoji in one string', () => {
      const result = parseRichHtmlToNodes('Before <b>bold</b> then <tg-emoji emoji-id="999">🎉</tg-emoji> after');
      expect(result).toEqual([
        { type: 'text', text: 'Before ' },
        { type: 'tag', tag: 'b', children: [{ type: 'text', text: 'bold' }] },
        { type: 'text', text: ' then ' },
        { type: 'tg-emoji', emojiId: '999', fallback: '🎉' },
        { type: 'text', text: ' after' }
      ]);
    });

    it('unwraps a tg-emoji with a non-digits emoji-id to a plain text node carrying the fallback', () => {
      expect(parseRichHtmlToNodes('<tg-emoji emoji-id="abc">⭐</tg-emoji>')).toEqual([
        { type: 'text', text: '⭐' }
      ]);
    });

    it('unwraps a tg-emoji with no emoji-id at all', () => {
      expect(parseRichHtmlToNodes('<tg-emoji>⭐</tg-emoji>')).toEqual([{ type: 'text', text: '⭐' }]);
    });

    it('handles a tg-emoji nested inside bold', () => {
      expect(parseRichHtmlToNodes('<b>before <tg-emoji emoji-id="1">🎉</tg-emoji> after</b>')).toEqual([
        {
          type: 'tag',
          tag: 'b',
          children: [
            { type: 'text', text: 'before ' },
            { type: 'tg-emoji', emojiId: '1', fallback: '🎉' },
            { type: 'text', text: ' after' }
          ]
        }
      ]);
    });

    it('decodes HTML entities inside a tg-emoji fallback the same way plain text does', () => {
      expect(parseRichHtmlToNodes('<tg-emoji emoji-id="1">&amp;</tg-emoji>')).toEqual([
        { type: 'tg-emoji', emojiId: '1', fallback: '&' }
      ]);
    });
  });
});
