/**
 * Prompt 0163 follow-up (consolidation) — the SINGLE pure parser now shared
 * by both renderers that need it: `FormattedTelegramText.jsx` (broadcast/
 * Welcome titles — recognizes `tg-emoji`, resolves a botId to render a real
 * premium-emoji asset) and `FormattedRichText.jsx` (Announcements/Versions —
 * treats a `tg-emoji` node as its own fallback text, no botId concept at
 * all). Previously two independent implementations (`formattedTelegramText.js`
 * here, `richTextParse.js` a hand-duplicated near-copy in
 * `admin/src/components/`) — that duplication already caused one real,
 * test-caught regression (the second copy's tag-name regex initially didn't
 * allow a hyphen, so a `<tg-emoji>` tag fell through to raw-text handling
 * instead of being safely unwrapped — see this module's own test file for
 * the case that would have caught it). One parser, two thin renderers on
 * top, eliminates that drift risk structurally rather than documenting it
 * as an accepted trade-off.
 *
 * This file's own parsing logic is copied byte-for-byte from
 * `admin/src/features/broadcast/telegram/formattedTelegramText.js`'s own
 * `parseTelegramHtmlToNodes` (tested since prompt 0153, including the
 * `tg-emoji` handling prompt 0161/0162's own botId-threading work depends
 * on) — not rewritten. Only the export name changed (`parseRichHtmlToNodes`,
 * matching this module's own now-broader, non-Telegram-specific identity)
 * and this header comment. That old file, and
 * `admin/src/components/richTextParse.js` (its own short-lived hand-written
 * near-duplicate from earlier in this same prompt arc), are both deleted —
 * `FormattedTelegramText.jsx`/`FormattedRichText.jsx` import directly from
 * here now; neither had more than its own one renderer + one test file as a
 * consumer, so no re-export shim was needed the way `editorTelegramFormat.js`
 * (8 real consumers) needed one when it moved in this same prompt.
 *
 * Parses HTML restricted to `<b><i><u><s><a href="https://...">` plus
 * `<tg-emoji emoji-id="...">fallback</tg-emoji>` (the exact union of
 * backend/src/telegram/formatting.js's `sanitizeTelegramHtml()` whitelist
 * and backend/src/utils/richHtml.js's generic `sanitizeRichHtml()` whitelist
 * — a caller whose own backend never produces `<tg-emoji>` in the first
 * place, like Announcements/Versions, simply never encounters that node
 * type in practice; the parser itself doesn't need to know or care which
 * caller it is) into a tree of plain, framework-agnostic node objects —
 * never dangerouslySetInnerHTML, and never DOMParser/innerHTML either.
 *
 * Deliberately a small, hand-written recursive-descent parser for exactly
 * this known, narrow grammar, NOT built on the browser's own DOMParser:
 * this input is already guaranteed to be sanitizeTelegramHtml()'s/
 * sanitizeRichHtml()'s own minimal, well-formed output (written
 * server-side, re-fetched from the admin API — never arbitrary user input
 * at PARSE time here, even though the ultimate source was once
 * user-submitted), so a small, explicit, fully-auditable parser for
 * exactly this grammar is both simpler to trust than relying on a
 * browser's own HTML-parsing quirks (a class of bug real HTML sanitizers
 * have had to guard against historically — mutation XSS via parser
 * round-trip surprises) AND keeps this genuinely unit-testable in a plain
 * Node environment with zero new dependencies (a DOMParser-based version
 * would need `jsdom`/`happy-dom` installed just to run its own tests,
 * neither of which exists anywhere in this monorepo).
 *
 * This is still the LAST line of defense before rendering, never assuming
 * its input is already safe just because it came from this app's own
 * database: any tag not in ALLOWED_TAGS is unwrapped (dropped, but its own
 * text content kept, matching both sanitizers' own "never lose text, even
 * when a wrapper isn't recognized" behavior) rather than trusted, and an
 * `<a>` with a missing/non-https href is unwrapped the same way
 * transformTags.a effectively does for a link scheme it rejects.
 */
const ALLOWED_TAGS = new Set(['b', 'i', 'u', 's', 'a']);

// A real custom_emoji_id is always exactly this shape (see
// backend/src/telegram/formatting.js's own EMOJI_ID_PATTERN, which this
// mirrors); anything else is never a real premium-emoji reference.
const EMOJI_ID_PATTERN = /^[0-9]{1,32}$/;

function decodeEntities(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Returns an array of nodes: `{ type: 'text', text }`,
 * `{ type: 'tag', tag: 'b'|'i'|'u'|'s'|'a', href?, children }`, or
 * `{ type: 'tg-emoji', emojiId, fallback }` — a leaf node, never a wrapper
 * with children, since a premium emoji's own content is always just its
 * plain fallback text. `html` being `null`/`undefined`/non-string is
 * treated as empty input rather than throwing — this function must never
 * be the reason a title/body fails to render.
 */
export function parseRichHtmlToNodes(html) {
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
        // Tag names allow a hyphen (tg-emoji) alongside the existing
        // alphanumeric-only tags — both open and close patterns below.
        const closeMatch = /^<\/([a-zA-Z0-9-]+)>/.exec(input.slice(pos));
        if (closeMatch) {
          flushText();
          pos += closeMatch[0].length;
          if (closeMatch[1].toLowerCase() === stopTag) return nodes;
          // A close tag that doesn't match what this call is waiting for —
          // skip it defensively rather than throwing (a formatting quirk
          // should never break rendering entirely).
          continue;
        }
        const openMatch = /^<([a-zA-Z0-9-]+)((?:\s+[a-zA-Z0-9-]+="[^"]*")*)\s*>/.exec(input.slice(pos));
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
              // Missing/non-https href — unwrap, matching the sanitizers'
              // own rejection behavior for this exact case.
              nodes.push(...children);
            }
          } else if (tagName === 'tg-emoji') {
            const children = parseChildren('tg-emoji');
            const idMatch = /emoji-id="([^"]*)"/.exec(attrsRaw);
            const emojiId = idMatch ? idMatch[1] : '';
            // The fallback is always plain text content (the same
            // guarantee sanitizeTelegramHtml's own whitelist enforces
            // server-side) — flatten whatever child text nodes exist back
            // into one string rather than assuming a single text child.
            const fallback = children.map((c) => (c.type === 'text' ? c.text : '')).join('');
            if (EMOJI_ID_PATTERN.test(emojiId)) {
              nodes.push({ type: 'tg-emoji', emojiId, fallback });
            } else {
              // Invalid/missing emoji-id — unwrap to plain fallback text,
              // matching sanitizeTelegramHtml's own exclusiveFilter rule.
              nodes.push({ type: 'text', text: fallback });
            }
          } else if (ALLOWED_TAGS.has(tagName)) {
            nodes.push({ type: 'tag', tag: tagName, children: parseChildren(tagName) });
          } else {
            // Unknown tag — unwrap: keep its own children's content, drop
            // the tag itself, rather than trusting or discarding text.
            nodes.push(...parseChildren(tagName));
          }
          continue;
        }
        // A lone '<' that isn't a recognized open/close tag — shouldn't
        // happen for well-formed sanitized input, but treated as literal
        // text rather than thrown on.
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
