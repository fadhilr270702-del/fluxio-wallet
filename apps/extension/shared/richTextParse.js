/**
 * Prompt 0170 — the notifications inbox's restricted HTML parser. Parses
 * HTML restricted to `<b><i><u><s><a href="https://...">` — the exact
 * whitelist backend/src/utils/richHtml.js's `sanitizeRichHtml()` produces
 * for an announcement's `'html'`-format title/body (see
 * publicAnnouncementsController.js's own `sanitizeForPublic()`, which
 * re-sanitizes with that same function at read time, defensively, before
 * this parser ever sees the string) — into a tree of plain,
 * framework-agnostic node objects. This is the LAST line of defense
 * before rendering: never assumes its input is already safe just because
 * it came from this extension's own backend fetch.
 *
 * Deliberately adapted from admin/src/components/richTextNodes.js's own
 * `parseRichHtmlToNodes` (same hand-written recursive-descent approach,
 * same reasoning for not using DOMParser — see that file's own header
 * comment for the full "why a hand-written parser, not DOMParser"
 * rationale, which applies identically here) rather than imported
 * directly: apps/extension and admin/ are separate packages with no
 * cross-app import convention anywhere in this monorepo (see CLAUDE.md),
 * and apps/extension's unbundled pages can't resolve a bare package
 * import at all without a bundler. This copy drops the admin version's
 * `<tg-emoji>` handling entirely — announcements are never Telegram
 * content, and sanitizeRichHtml()'s own server-side whitelist (this
 * parser's one and only input contract) never produces that tag, so
 * there's nothing here that would ever need to recognize it.
 *
 * Deliberately free of any DOM/`chrome.*` reference — this is what makes
 * it plain-Vitest testable (see test/richTextParse.test.js); the actual
 * DOM-building step lives separately in shared/renderRestrictedHtml.js,
 * which this file is never allowed to import (that one uses `document`,
 * unavailable in a service worker — this one must stay usable from
 * anywhere, including a future test run under Node).
 */
const ALLOWED_TAGS = new Set(['b', 'i', 'u', 's', 'a']);

function decodeEntities(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Returns an array of nodes: `{ type: 'text', text }` or
 * `{ type: 'tag', tag: 'b'|'i'|'u'|'s'|'a', href?, children }`. `html`
 * being `null`/`undefined`/non-string is treated as empty input rather
 * than throwing — this function must never be the reason a notification
 * fails to render.
 */
export function parseRestrictedHtmlToNodes(html) {
  const input = typeof html === 'string' ? html : '';
  let pos = 0;

  function parseChildren(stopTag) {
    const nodes = [];
    let textBuffer = '';
    function flushText() {
      if (textBuffer) {
        nodes.push({ type: 'text', text: decodeEntities(textBuffer) });
        textBuffer = '';
      }
    }
    while (pos < input.length) {
      if (input[pos] === '<') {
        const closeMatch = /^<\/([a-zA-Z0-9]+)>/.exec(input.slice(pos));
        if (closeMatch) {
          flushText();
          pos += closeMatch[0].length;
          if (closeMatch[1].toLowerCase() === stopTag) return nodes;
          // A close tag that doesn't match what this call is waiting for
          // — skip it defensively rather than throwing (a formatting
          // quirk should never break rendering entirely).
          continue;
        }
        const openMatch = /^<([a-zA-Z0-9]+)((?:\s+[a-zA-Z0-9]+="[^"]*")*)\s*>/.exec(input.slice(pos));
        if (openMatch) {
          flushText();
          const tagName = openMatch[1].toLowerCase();
          const attrsRaw = openMatch[2];
          pos += openMatch[0].length;
          if (tagName === 'a') {
            const children = parseChildren('a');
            const hrefMatch = /href="([^"]*)"/.exec(attrsRaw);
            const href = hrefMatch ? decodeEntities(hrefMatch[1]) : '';
            if (href && href.startsWith('https://')) {
              nodes.push({ type: 'tag', tag: 'a', href, children });
            } else {
              // Missing/non-https href — unwrap, matching sanitizeRichHtml()'s
              // own rejection behavior for this exact case: never lose the
              // text content, just drop the untrusted wrapper.
              nodes.push(...children);
            }
          } else if (ALLOWED_TAGS.has(tagName)) {
            nodes.push({ type: 'tag', tag: tagName, children: parseChildren(tagName) });
          } else {
            // Unknown/foreign tag — unwrap: keep its own children's
            // content, drop the tag itself.
            nodes.push(...parseChildren(tagName));
          }
          continue;
        }
        // A lone '<' that isn't a recognized open/close tag — treated as
        // literal text rather than thrown on, so a stray character can
        // never break rendering.
        textBuffer += input[pos];
        pos += 1;
        continue;
      }
      textBuffer += input[pos];
      pos += 1;
    }
    flushText();
    return nodes;
  }

  return parseChildren(null);
}
