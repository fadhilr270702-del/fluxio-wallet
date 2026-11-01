/**
 * Message-text formatting for the WYSIWYG rich-text composer slice, plus
 * (as of the image- and video-upload slices) the media-source/caption-
 * length helpers those same broadcasts need.
 *
 * telegram_broadcasts.body_format (and, as of prompt 0149, title_format —
 * see migration 0019) each independently distinguish two kinds of value:
 *  - 'plain' (every broadcast created before the relevant slice, and
 *    forever unless explicitly re-saved through Compose): raw, unescaped
 *    plain text. Escaped via escapeHtmlText() whenever parse_mode:'HTML'
 *    ends up active for the OTHER field (see buildBroadcastMessage()'s own
 *    4-combination matrix below) — a 'plain' field is never itself the
 *    reason parse_mode turns on.
 *  - 'html' (composed/re-saved through the rich-text editor): pre-sanitized
 *    Telegram-safe HTML (only <b><i><u><s><a href> — the exact subset
 *    Telegram's parse_mode:'HTML' accepts). Forces parse_mode:'HTML' for
 *    the whole message.
 *
 * The client (ComposePage.jsx) only *proposes* titleFormat/title/bodyFormat/
 * body — this backend never trusts that claim. adminTelegramBroadcastRoutes.js
 * runs every 'html'-format title/body through sanitizeTelegramHtml() at
 * write time (create/updateContent), so whatever ends up stored is already
 * guaranteed safe; buildBroadcastMessage() defensively re-sanitizes at send
 * time too, since "the message must never fail to send over a formatting
 * bug" is the single most important property of this feature.
 */
import { sanitizeRichHtml, stripToPlainText, plainTextLength } from '../utils/richHtml.js';

// Prompt 0163 — stripToPlainText/plainTextLength were never actually
// Telegram-specific (they strip ANY html tags generically) and now live in
// the shared ../utils/richHtml.js module, reused as-is by Announcements'/
// Versions' own length validation. Re-exported here UNCHANGED so every
// existing `import { plainTextLength } from '../telegram/formatting.js'`
// (e.g. adminTelegramBroadcastRoutes.js) keeps working with zero changes —
// this file's own public API is otherwise untouched by that extraction.
export { stripToPlainText, plainTextLength };

// Prompt 0153 — the one HTML shape a registered premium custom emoji ever
// serializes to (see admin/src/features/broadcast/telegram/
// editorTelegramFormat.js's own tg-emoji rendering, and Telegram's own Bot
// API 9.4 syntax verified live in prompt 0151's spike): <tg-emoji
// emoji-id="ID">fallback</tg-emoji>. `emoji-id` must be exactly this
// digits-only shape — a real custom_emoji_id is always a plain integer
// string — so anything else (letters, punctuation, missing entirely) is
// never a real premium emoji reference and gets unwrapped to plain text
// instead of silently kept as a broken/spoofable tag.
const EMOJI_ID_PATTERN = /^[0-9]{1,32}$/;

/**
 * Restricts arbitrary HTML down to exactly Telegram's parse_mode:'HTML'
 * subset (as of prompt 0153, now including <tg-emoji emoji-id="...">).
 *
 * Prompt 0163 — now built ON TOP of ../utils/richHtml.js's own generic
 * sanitizeRichHtml() (the base <b><i><u><s><a href="https://..."> whitelist
 * Announcements/Versions also use, with no <tg-emoji> awareness at all —
 * this is the ONE place that extra tag gets layered in), rather than
 * duplicating the whole sanitize-html call here. Behavior is byte-for-byte
 * identical to before this refactor — same allowedTags set, same
 * allowedAttributes, same allowedSchemes, same link-validation transform,
 * same exclusiveFilter — proven by telegram/test/formatting.test.js's own
 * 32 tests running unchanged. A <tg-emoji> with a missing or
 * non-digits-only `emoji-id` is unwrapped instead (tag dropped, its own
 * fallback text kept) via `exclusiveFilter`'s `'excludeTag'` return —
 * `allowedAttributes` already strips any OTHER attribute on a `tg-emoji`
 * tag automatically (e.g. a stray `onclick`/`class`), with no extra code
 * needed for that half of the requirement.
 */
export function sanitizeTelegramHtml(rawHtml) {
  return sanitizeRichHtml(rawHtml, {
    extraAllowedTags: ['tg-emoji'],
    extraAllowedAttributes: { 'tg-emoji': ['emoji-id'] },
    extraExclusiveFilter: (frame) =>
      frame.tag === 'tg-emoji' && !EMOJI_ID_PATTERN.test(frame.attribs['emoji-id'] || '') ? 'excludeTag' : false
  });
}

/**
 * HTML-escapes a plain string (order matters: & first, or a literal & in
 * the input would get double-escaped once < / > are replaced). Used for a
 * 'plain'-format title or body whenever parse_mode:'HTML' ends up active
 * for the message overall (because the OTHER field is 'html') — a title
 * containing a literal < or > must never be allowed to break Telegram's
 * HTML parser just because the body next to it happens to be formatted.
 */
export function escapeHtmlText(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Renders one field (title OR body) to what should actually be concatenated
 * into the final message text, GIVEN that parse_mode:'HTML' is already
 * decided for the whole message (see buildBroadcastMessage below — the
 * decision of whether parse_mode is HTML at all is made once, from BOTH
 * fields' formats together, not per-field). 'html' fields are re-sanitized
 * defensively at send time, exactly like the body-only version of this used
 * to; 'plain' fields are escaped whenever the overall message is HTML
 * (never left raw next to real markup, which would let a literal `<`/`>` in
 * an old plain title/body be misread as a tag), and passed through
 * completely untouched when the whole message isn't HTML at all (the
 * byte-for-byte legacy behavior every pre-rich-text broadcast depends on).
 */
function renderField(value, format, htmlModeActive) {
  if (format === 'html') {
    const { html } = sanitizeTelegramHtml(value);
    return html;
  }
  return htmlModeActive ? escapeHtmlText(value) : String(value ?? '');
}

/**
 * The one function every send call-site uses to decide what text/parse_mode
 * to actually send — replaces the old `${title}\n\n${body}` template
 * literal. Handles all 4 title_format x body_format combinations honestly
 * (prompt 0149) — a broadcast can genuinely have an 'html' body from the
 * original rich-text-composer slice with a 'plain' title from before title
 * formatting existed, or vice versa once an admin re-saves just one field
 * through "Edit isi" without touching the other. parse_mode is 'HTML' the
 * moment EITHER field is 'html' — Telegram has no way to apply parse_mode
 * to only half a message, so as soon as one field needs it, the other must
 * be correctly escaped to survive being sent alongside real markup (see
 * renderField's own comment). When NEITHER field is 'html', this is
 * byte-identical to every prior slice's behavior (no escaping, no
 * parse_mode) — the backward-compatibility guarantee this whole feature
 * depends on.
 */
export function buildBroadcastMessage(broadcast) {
  const htmlModeActive = broadcast.title_format === 'html' || broadcast.body_format === 'html';
  const title = renderField(broadcast.title, broadcast.title_format, htmlModeActive);
  const body = renderField(broadcast.body, broadcast.body_format, htmlModeActive);
  return { text: `${title}\n\n${body}`, parseMode: htmlModeActive ? 'HTML' : undefined };
}

// Matches sanitizeTelegramHtml's own already-sanitized output shape —
// deliberately non-greedy on the inner text and requiring a digits-only id,
// so this only ever matches a genuine tg-emoji tag this codebase itself
// could have produced, never a lookalike string that happened to survive
// into already-trusted content.
const TG_EMOJI_TAG_PATTERN = /<tg-emoji emoji-id="[0-9]{1,32}">([\s\S]*?)<\/tg-emoji>/g;

/**
 * Prompt 0153 — explicit, per-target degradation for a channel send.
 * Telegram's own Bot API 9.4 changelog scopes custom-emoji rendering to
 * "private, group and supergroup chats" only — channels are excluded
 * outright, and prompt 0151's spike never tested a channel (no private
 * test channel was available), so this deliberately does NOT rely on
 * whatever Telegram would silently do with a `<tg-emoji>`/
 * `icon_custom_emoji_id` sent to a channel (the spike's own proven silent-
 * degradation behavior was only confirmed for a non-Premium BOT OWNER, a
 * different condition entirely) — it strips both forms of premium-emoji
 * content before the message/keyboard ever leaves this process for a
 * channel target. A private-chat/subscriber/welcome send is NEVER passed
 * through this function — prompt 0151's own negative test already proved
 * the trial bot degrades those on its own, and the official bot is
 * expected to render them for real there.
 *
 * Pure and unit-tested on its own — `text` is whatever
 * buildBroadcastMessage()/buildWelcomeMessage() already produced,
 * `replyMarkup` is whatever buildInlineKeyboard() already produced (or
 * undefined, if there are no buttons at all).
 */
export function degradeForChannel({ text, replyMarkup }) {
  const degradedText = String(text ?? '').replace(TG_EMOJI_TAG_PATTERN, '$1');
  if (!replyMarkup) return { text: degradedText, replyMarkup };
  const degradedReplyMarkup = {
    ...replyMarkup,
    inline_keyboard: replyMarkup.inline_keyboard.map((row) =>
      row.map(({ icon_custom_emoji_id, ...rest }) => rest)
    )
  };
  return { text: degradedText, replyMarkup: degradedReplyMarkup };
}

/**
 * What to actually send a broadcast's media as — the file_id/media_url/
 * media_type compatibility bridge spanning the image- and video-upload
 * slices. media_file_id is shared by both image and video file_ids (see
 * migration 0012); media_type disambiguates which one it is. Every
 * broadcast that had media before media_type existed was backfilled to
 * 'image' by that same migration, so this is a reliable discriminator for
 * every row, not just new ones — an 'image'-typed row resolves identically
 * to the pre-video-slice resolvePhotoSource() logic (file_id, falling back
 * to the legacy media_url), which is what keeps every old broadcast sending
 * unchanged.
 */
export function resolveBroadcastMedia(broadcast) {
  if (!broadcast.media_type) return { type: null, source: null };
  if (broadcast.media_type === 'video') return { type: 'video', source: broadcast.media_file_id || null };
  return { type: 'image', source: broadcast.media_file_id || broadcast.media_url || null };
}

/**
 * title's plain length + the '\n\n' separator + the body's plain length —
 * matches buildBroadcastMessage's own concatenation. Both fields measured
 * by their OWN format independently (prompt 0149) — a title and body can
 * disagree on format (see buildBroadcastMessage's own comment on the 4
 * genuine combinations), and each one's rendered/visible length only ever
 * depends on its own format, never the other field's.
 */
export function computeCaptionLength(title, titleFormat, body, bodyFormat) {
  return plainTextLength(title, titleFormat) + 2 + plainTextLength(body, bodyFormat);
}

/**
 * Telegram's own hard character cap for a message — 1024 when it's a
 * photo/video *caption* (media is attached), 4096 for a plain text message
 * (prompt 0136, the welcome message's own limit — a broadcast's title
 * already helps keep it well under 4096 in practice, so no broadcast has
 * ever needed this distinguished from the 1024 caption case, but the
 * welcome message has no title to bound it, so both limits are real here).
 * Pure — no I/O, so it's trivially unit-testable on its own.
 */
export function captionLimitFor(hasImage) {
  return hasImage ? 1024 : 4096;
}
