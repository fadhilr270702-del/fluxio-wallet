/**
 * Prompt 0163 — the generic core extracted out of
 * `telegram/formatting.js`'s own `sanitizeTelegramHtml()`/`stripToPlainText()`/
 * `plainTextLength()`. Those three were never actually Telegram-specific in
 * their logic (only in *location* and in `sanitizeTelegramHtml`'s own extra
 * `<tg-emoji>` allowance) — this is the shared base every rich-text field in
 * this backend restricts down to: `<b><i><u><s><a href="https://...">`, the
 * exact subset Announcements/Versions need now that they're gaining their
 * own `title_format`/`body_format`/`update_message_format` columns (see
 * migrations 0021/0022) but explicitly do NOT need `<tg-emoji>` — neither
 * feature is Telegram-bound, so premium custom emoji simply doesn't apply.
 *
 * `formatting.js` now builds `sanitizeTelegramHtml()` ON TOP of
 * `sanitizeRichHtml()` (passing `tg-emoji` in as an extra allowed
 * tag/attribute plus its own `exclusiveFilter`) and re-exports
 * `stripToPlainText`/`plainTextLength` unchanged — every existing import of
 * those two from `../telegram/formatting.js` keeps working with zero
 * changes, and `telegram/test/formatting.test.js`'s own 32 tests (unchanged)
 * are what prove this refactor is behavior-preserving for broadcasts.
 */
import sanitizeHtml from 'sanitize-html';

export const BASE_ALLOWED_TAGS = ['b', 'i', 'u', 's', 'a'];
export const BASE_ALLOWED_ATTRIBUTES = { a: ['href'] };

/**
 * Restricts arbitrary HTML down to `<b><i><u><s><a href="https://...">` by
 * default — invalid/non-https link URLs are stripped (their `<a>` becomes
 * plain unlinked text, `hadInvalidLink` set) rather than left as an unsafe
 * scheme, matching `sanitizeTelegramHtml`'s own pre-existing behavior
 * exactly (this IS that behavior, just relocated and made reusable).
 *
 * `extraAllowedTags`/`extraAllowedAttributes`/`extraExclusiveFilter` are the
 * ONLY way a caller can widen the whitelist — `telegram/formatting.js` uses
 * them to layer `<tg-emoji emoji-id="...">` support on top for broadcasts;
 * every other caller (Announcements, Versions) calls this with no options
 * at all and gets exactly the base 5-tag whitelist, no premium-emoji
 * awareness whatsoever.
 */
export function sanitizeRichHtml(rawHtml, { extraAllowedTags = [], extraAllowedAttributes = {}, extraExclusiveFilter } = {}) {
  let hadInvalidLink = false;
  const html = sanitizeHtml(rawHtml ?? '', {
    allowedTags: [...BASE_ALLOWED_TAGS, ...extraAllowedTags],
    allowedAttributes: { ...BASE_ALLOWED_ATTRIBUTES, ...extraAllowedAttributes },
    allowedSchemes: ['https'],
    transformTags: {
      a: (tagName, attribs) => {
        if (!attribs.href || !attribs.href.startsWith('https://')) {
          hadInvalidLink = true;
        }
        return { tagName, attribs: attribs.href ? { href: attribs.href } : {} };
      }
    },
    exclusiveFilter: extraExclusiveFilter || (() => false)
  });
  return { html, hadInvalidLink };
}

/**
 * Strips a value down to what a reader would actually see, GIVEN its own
 * format — for 'html' values, tags are stripped and the 3 basic entities
 * decoded (length caps are measured against the *parsed* text, not the raw
 * markup); 'plain' values are returned untouched. Regex tag-stripping is
 * safe here specifically because an 'html'-format value at this point is
 * already-sanitized, minimal-shape HTML (never arbitrary input) — this is a
 * measurement/extraction on trusted content, not a parse/sanitize step.
 */
export function stripToPlainText(value, format) {
  if (format !== 'html') return String(value ?? '');
  return String(value ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * The rendered length Telegram (or any other reader) will actually count.
 * JS string .length already counts UTF-16 code units, matching how Telegram
 * itself counts entity lengths, so no extra surrogate-pair-aware logic is
 * needed.
 */
export function plainTextLength(value, format) {
  return stripToPlainText(value, format).length;
}
