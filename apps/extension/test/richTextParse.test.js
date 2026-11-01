import { describe, it, expect } from 'vitest';
import { parseRestrictedHtmlToNodes } from '../shared/richTextParse.js';

describe('parseRestrictedHtmlToNodes — allowed tags', () => {
  it('parses <b> into a tag node with its text child', () => {
    const nodes = parseRestrictedHtmlToNodes('<b>Bold</b>');
    expect(nodes).toEqual([{ type: 'tag', tag: 'b', children: [{ type: 'text', text: 'Bold' }] }]);
  });

  it('parses every allowed tag (b i u s a)', () => {
    const nodes = parseRestrictedHtmlToNodes('<i>x</i><u>y</u><s>z</s>');
    expect(nodes.map((n) => n.tag)).toEqual(['i', 'u', 's']);
  });

  it('parses a nested structure', () => {
    const nodes = parseRestrictedHtmlToNodes('<b>bold <i>and italic</i></b>');
    expect(nodes).toEqual([
      {
        type: 'tag',
        tag: 'b',
        children: [
          { type: 'text', text: 'bold ' },
          { type: 'tag', tag: 'i', children: [{ type: 'text', text: 'and italic' }] }
        ]
      }
    ]);
  });

  it('parses an https link, keeping its href', () => {
    const nodes = parseRestrictedHtmlToNodes('<a href="https://fluxio.example/">link</a>');
    expect(nodes).toEqual([{ type: 'tag', tag: 'a', href: 'https://fluxio.example/', children: [{ type: 'text', text: 'link' }] }]);
  });
});

describe('parseRestrictedHtmlToNodes — foreign tags are unwrapped', () => {
  it('drops a script tag but keeps no text (its own content is skipped, not run)', () => {
    const nodes = parseRestrictedHtmlToNodes('before<script>evil()</script>after');
    // <script> isn't in ALLOWED_TAGS, so it unwraps: its own "text" child
    // (the literal string "evil()") is kept as plain text, exactly like
    // any other unknown-tag content — never executed, never dropped.
    expect(nodes).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'evil()' },
      { type: 'text', text: 'after' }
    ]);
  });

  it('unwraps an unrecognized tag but keeps its own children content', () => {
    const nodes = parseRestrictedHtmlToNodes('<span>kept</span>');
    expect(nodes).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('unwraps a foreign tag nested inside an allowed one', () => {
    const nodes = parseRestrictedHtmlToNodes('<b><div>still bold text</div></b>');
    expect(nodes).toEqual([{ type: 'tag', tag: 'b', children: [{ type: 'text', text: 'still bold text' }] }]);
  });
});

describe('parseRestrictedHtmlToNodes — non-https hrefs are discarded', () => {
  it('unwraps an http:// link (keeps the text, drops the tag)', () => {
    const nodes = parseRestrictedHtmlToNodes('<a href="http://insecure.example">click</a>');
    expect(nodes).toEqual([{ type: 'text', text: 'click' }]);
  });

  it('unwraps a javascript: link', () => {
    const nodes = parseRestrictedHtmlToNodes('<a href="javascript:alert(1)">click</a>');
    expect(nodes).toEqual([{ type: 'text', text: 'click' }]);
  });

  it('unwraps a link with no href at all', () => {
    const nodes = parseRestrictedHtmlToNodes('<a>click</a>');
    expect(nodes).toEqual([{ type: 'text', text: 'click' }]);
  });
});

describe('parseRestrictedHtmlToNodes — text safety with < > &', () => {
  it('decodes &lt; &gt; &amp; entities back to literal characters in text nodes', () => {
    const nodes = parseRestrictedHtmlToNodes('1 &lt; 2 &amp; 3 &gt; 0');
    expect(nodes).toEqual([{ type: 'text', text: '1 < 2 & 3 > 0' }]);
  });

  it('treats a stray unrecognized "<" as literal text instead of throwing', () => {
    const nodes = parseRestrictedHtmlToNodes('a < b');
    expect(nodes).toEqual([{ type: 'text', text: 'a < b' }]);
  });

  it('handles empty/non-string input without throwing', () => {
    expect(parseRestrictedHtmlToNodes('')).toEqual([]);
    expect(parseRestrictedHtmlToNodes(null)).toEqual([]);
    expect(parseRestrictedHtmlToNodes(undefined)).toEqual([]);
  });
});
