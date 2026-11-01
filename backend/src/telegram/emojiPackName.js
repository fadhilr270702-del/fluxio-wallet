/**
 * Prompt 0152 — parses whatever an admin pastes into the "Register" field
 * (a bare pack name, or a full `t.me/addemoji/NAME` link in any of its
 * common shapes) down to just the pack name Telegram's own getStickerSet
 * expects, applying the same strict `^[A-Za-z0-9_]{1,64}$` allowlist either
 * way. Pure and dependency-free on purpose — this is exactly the kind of
 * fiddly-by-hand string logic (URL shapes, hostile input) worth its own
 * direct unit tests rather than only being exercised indirectly through an
 * HTTP call.
 *
 * Deliberately a strict allowlist, not a blocklist — a name containing a
 * path-traversal sequence (`../../etc/passwd`), whitespace, or any other
 * character outside `[A-Za-z0-9_]` is rejected outright rather than
 * "cleaned up" and silently accepted, since this value later becomes a
 * literal `getStickerSet` parameter and (once registered) a normal
 * cross-request identifier for that pack's own rows.
 */
const VALID_PACK_NAME = /^[A-Za-z0-9_]{1,64}$/;

// Accepts http(s)://, or no scheme at all, t.me or telegram.me, with or
// without "addemoji"/"addstickers" — Telegram serves both add-emoji and
// add-sticker links through the same t.me path shape, and a pack name
// pasted from either kind of link should parse the same way. Stops at the
// first '/', '?', or '#' so a trailing query string or path segment never
// leaks into the extracted name.
const ADD_LINK_PATTERN = /^(?:https?:\/\/)?(?:t|telegram)\.me\/(?:add(?:emoji|stickers)\/)?([^/?#]+)/i;

/**
 * Returns the extracted, validated pack name, or `null` for anything that
 * doesn't resolve to one — never a best-effort partial match. `null` means
 * "reject this input outright", not "try harder to parse it".
 */
export function parseEmojiPackName(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;

  const linkMatch = trimmed.match(ADD_LINK_PATTERN);
  const candidate = linkMatch ? linkMatch[1] : trimmed;

  return VALID_PACK_NAME.test(candidate) ? candidate : null;
}
