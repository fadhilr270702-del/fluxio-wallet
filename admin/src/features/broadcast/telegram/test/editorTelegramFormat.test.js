import { describe, it, expect } from 'vitest';
import {
  editorJsonToTelegramHtml,
  editorJsonToTelegramTitleHtml,
  isEditorTitleEmpty,
  isEditorDocEmpty,
  titleToEditorHtml,
  bodyToEditorHtml,
  editorPlainTextLength,
  splitPastedTextIntoLines
} from '../editorTelegramFormat.js';

function textPara(text) {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function premiumEmojiNode(id, fallback, marks) {
  return { type: 'premiumEmoji', attrs: { id, fallback }, ...(marks ? { marks } : {}) };
}

// Prompt 0146 — a genuinely empty TipTap paragraph (no content array at
// all, or an empty one) is what a real double-Enter keypress produces —
// verified live against the actual running editor before writing these.
function emptyPara() {
  return { type: 'paragraph' };
}

describe('editorJsonToTelegramHtml — empty-paragraph (blank line) handling', () => {
  it('joins ordinary paragraphs with a single newline (no gap) — unchanged baseline behavior', () => {
    const doc = { type: 'doc', content: [textPara('Line1'), textPara('Line2')] };
    expect(editorJsonToTelegramHtml(doc)).toBe('Line1\nLine2');
  });

  it('a single empty paragraph between two text paragraphs becomes one real blank line (\\n\\n)', () => {
    const doc = { type: 'doc', content: [textPara('Line1'), emptyPara(), textPara('Line2')] };
    expect(editorJsonToTelegramHtml(doc)).toBe('Line1\n\nLine2');
  });

  it('two consecutive empty paragraphs (a double blank line) stack correctly', () => {
    const doc = { type: 'doc', content: [textPara('Line1'), emptyPara(), emptyPara(), textPara('Line2')] };
    expect(editorJsonToTelegramHtml(doc)).toBe('Line1\n\n\nLine2');
  });

  it('an empty paragraph at the very start of the doc is preserved', () => {
    const doc = { type: 'doc', content: [emptyPara(), textPara('Line1')] };
    expect(editorJsonToTelegramHtml(doc)).toBe('\nLine1');
  });

  it('an empty paragraph at the very end of the doc is preserved', () => {
    const doc = { type: 'doc', content: [textPara('Line1'), emptyPara()] };
    expect(editorJsonToTelegramHtml(doc)).toBe('Line1\n');
  });

  it('a paragraph with an explicit empty content array behaves the same as one with no content key at all', () => {
    const doc = { type: 'doc', content: [textPara('Line1'), { type: 'paragraph', content: [] }, textPara('Line2')] };
    expect(editorJsonToTelegramHtml(doc)).toBe('Line1\n\nLine2');
  });
});

describe('bodyToEditorHtml — the reverse (load) direction, round-trip consistency', () => {
  it('round-trips a single blank line back into a genuinely empty <p></p>', () => {
    const html = bodyToEditorHtml('Line1\n\nLine2', 'html');
    expect(html).toBe('<p>Line1</p><p></p><p>Line2</p>');
  });

  it('round-trips a double blank line into two empty <p></p> tags', () => {
    const html = bodyToEditorHtml('Line1\n\n\nLine2', 'html');
    expect(html).toBe('<p>Line1</p><p></p><p></p><p>Line2</p>');
  });

  it('an ordinary (non-blank) newline produces no empty paragraph, matching the tight-join baseline', () => {
    const html = bodyToEditorHtml('Line1\nLine2', 'html');
    expect(html).toBe('<p>Line1</p><p>Line2</p>');
  });
});

describe('splitPastedTextIntoLines — the paste-path fix (prompt 0146 Bug 1)', () => {
  it('splits on a single newline, unlike a run of consecutive newlines collapsing to one break', () => {
    expect(splitPastedTextIntoLines('A\nB')).toEqual(['A', 'B']);
  });

  it('a blank line (\\n\\n) between two blocks produces an empty entry — the actual bug this fixes', () => {
    expect(splitPastedTextIntoLines('A\n\nB')).toEqual(['A', '', 'B']);
  });

  it('a double blank line produces two empty entries', () => {
    expect(splitPastedTextIntoLines('A\n\n\nB')).toEqual(['A', '', '', 'B']);
  });

  it('a leading blank line is preserved as an empty first entry', () => {
    expect(splitPastedTextIntoLines('\nA')).toEqual(['', 'A']);
  });

  it('a trailing blank line is preserved as an empty last entry', () => {
    expect(splitPastedTextIntoLines('A\n')).toEqual(['A', '']);
  });

  it('handles Windows-style CRLF line endings the same as bare LF', () => {
    expect(splitPastedTextIntoLines('A\r\n\r\nB')).toEqual(['A', '', 'B']);
  });

  it('handles a null/undefined input without throwing', () => {
    expect(splitPastedTextIntoLines(undefined)).toEqual(['']);
    expect(splitPastedTextIntoLines(null)).toEqual(['']);
  });
});

// Prompt 0149 — Title becomes a singleLine RichTextEditor, sharing this
// same doc<->HTML conversion module. These mirror the equivalent body
// tests above, but for the title-specific render/empty/load functions.
describe('editorJsonToTelegramTitleHtml', () => {
  it('renders a plain single-paragraph title unchanged', () => {
    const doc = { type: 'doc', content: [textPara('Big Sale')] };
    expect(editorJsonToTelegramTitleHtml(doc)).toBe('Big Sale');
  });

  it('renders stacked marks + a link + an emoji all in one title, nested/escaped correctly', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Before ' },
            {
              type: 'text',
              text: 'bold link',
              marks: [{ type: 'link', attrs: { href: 'https://example.com' } }, { type: 'bold' }]
            },
            { type: 'text', text: ' 🎉 after' }
          ]
        }
      ]
    };
    expect(editorJsonToTelegramTitleHtml(doc)).toBe('Before <b><a href="https://example.com">bold link</a></b> 🎉 after');
  });

  it('never produces a \\n even if the doc somehow has more than one paragraph (defensive — SingleLineGuard should prevent this upstream)', () => {
    const doc = { type: 'doc', content: [textPara('First'), textPara('Second')] };
    expect(editorJsonToTelegramTitleHtml(doc)).toBe('First Second');
    expect(editorJsonToTelegramTitleHtml(doc)).not.toMatch(/\n/);
  });

  it('trims incidental leading/trailing whitespace from the rendered result', () => {
    const doc = { type: 'doc', content: [textPara('  Padded  ')] };
    expect(editorJsonToTelegramTitleHtml(doc)).toBe('Padded');
  });
});

describe('isEditorTitleEmpty', () => {
  it('is true for a doc with only an empty paragraph', () => {
    expect(isEditorTitleEmpty({ type: 'doc', content: [emptyPara()] })).toBe(true);
  });

  it('is true for whitespace-only text', () => {
    expect(isEditorTitleEmpty({ type: 'doc', content: [textPara('   ')] })).toBe(true);
  });

  it('is false once there is any visible text', () => {
    expect(isEditorTitleEmpty({ type: 'doc', content: [textPara('Hi')] })).toBe(false);
  });
});

describe('titleToEditorHtml — the reverse (load) direction for Title', () => {
  it('escapes a legacy plain title so literal < > survive as text, not markup', () => {
    expect(titleToEditorHtml('Sale <today>', 'plain')).toBe('<p>Sale &lt;today&gt;</p>');
  });

  it('passes an html-format title through untouched (already-safe markup)', () => {
    expect(titleToEditorHtml('<b>Big Sale</b>', 'html')).toBe('<p><b>Big Sale</b></p>');
  });

  it('defaults to plain (escaped) when no format is given, matching bodyToEditorHtml\'s own default', () => {
    expect(titleToEditorHtml('Sale <today>')).toBe('<p>Sale &lt;today&gt;</p>');
  });

  it('handles a missing/empty title without throwing', () => {
    expect(titleToEditorHtml(null, 'plain')).toBe('<p></p>');
    expect(titleToEditorHtml(undefined, 'html')).toBe('<p></p>');
  });
});

// Prompt 0153 — the premiumEmoji inline atom node's own serialization.
describe('premiumEmoji node serialization', () => {
  it('serializes a bare premiumEmoji node to <tg-emoji emoji-id="...">fallback</tg-emoji> in the body', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [premiumEmojiNode('12345', '⭐')] }] };
    expect(editorJsonToTelegramHtml(doc)).toBe('<tg-emoji emoji-id="12345">⭐</tg-emoji>');
  });

  it('serializes a premiumEmoji node in the title the same way', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [premiumEmojiNode('999', '🎉')] }] };
    expect(editorJsonToTelegramTitleHtml(doc)).toBe('<tg-emoji emoji-id="999">🎉</tg-emoji>');
  });

  it('renders a premium emoji in the middle of bold text plus a plain emoji plus a link, offsets aside — this is the exact shape the live verification sends', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'before ', marks: [{ type: 'bold' }] },
            premiumEmojiNode('111', '⭐'),
            { type: 'text', text: ' 🎉 ' },
            { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }
          ]
        }
      ]
    };
    expect(editorJsonToTelegramHtml(doc)).toBe(
      '<b>before </b><tg-emoji emoji-id="111">⭐</tg-emoji> 🎉 <a href="https://example.com">link</a>'
    );
  });

  it('wraps a premiumEmoji node carrying its own marks (e.g. selected and bolded) the same way a text run would', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [premiumEmojiNode('1', '⭐', [{ type: 'bold' }])] }]
    };
    expect(editorJsonToTelegramHtml(doc)).toBe('<b><tg-emoji emoji-id="1">⭐</tg-emoji></b>');
  });

  it('escapes a premiumEmoji id/fallback defensively (never trusted blindly, even though real values never contain markup characters)', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [premiumEmojiNode('1"><script>', '<evil>')] }]
    };
    // Escaped, not executed/broken out of the attribute — a defensive
    // property, not a case this app's own editor could ever produce for
    // real (a real id is always digits-only, a real fallback is always a
    // plain emoji character).
    expect(editorJsonToTelegramHtml(doc)).not.toContain('<script>');
    expect(editorJsonToTelegramHtml(doc)).toContain('&lt;evil&gt;');
  });

  it('counts a premiumEmoji node as exactly its fallback length in editorPlainTextLength', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'before ' }, premiumEmojiNode('1', '⭐'), { type: 'text', text: ' after' }] }]
    };
    // 'before ' (7) + '⭐' (1 UTF-16 unit) + ' after' (6) = 14
    expect(editorPlainTextLength(doc)).toBe(14);
  });

  it('counts a MULTI-UTF-16-UNIT fallback emoji at its real length, not 1', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [premiumEmojiNode('1', '🎉')] }] };
    expect(editorPlainTextLength(doc)).toBe(2); // 🎉 is a surrogate pair
  });

  it('a doc containing only a premiumEmoji node is NOT considered empty', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [premiumEmojiNode('1', '⭐')] }] };
    expect(isEditorDocEmpty(doc)).toBe(false);
  });
});
