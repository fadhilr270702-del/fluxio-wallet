/**
 * Prompt 0167 — moved out of routes/adminTelegramBroadcastRoutes.js
 * verbatim (byte-for-byte, not rewritten) — the zod-schema section only;
 * the multer upload middleware/normalizers and the Router/route
 * declarations stay in the route file, since those aren't schemas and
 * multer's memoryStorage config has no bearing on the DB-import problem
 * this move fixes. Zero database dependency here — see
 * announcementSchemas.js's own header for why that property matters.
 */
import { z } from 'zod';
import { sanitizeTelegramHtml, computeCaptionLength, plainTextLength } from '../telegram/formatting.js';

// Same refine pattern as announcementSchemas.js's isoDateString.
const isoDateString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Must be a valid ISO-8601 date string.' });

// Telegram rejects the WHOLE message if any URL button is malformed, so
// this must be strict and run before a broadcast is ever saved/sent — not
// just a UX nicety in the composer.
//
// Prompt 0153 — iconCustomEmojiId is optional and, when present, must be
// exactly a real custom_emoji_id's own shape (digits only) — the same
// EMOJI_ID_PATTERN formatting.js's sanitizer enforces for a <tg-emoji> tag,
// duplicated here rather than imported since a zod `.regex()` needs its
// own RegExp literal and the two never need to change independently of
// each other in practice. Exported for direct unit testing (this route
// file has no other test coverage convention to break by doing so).
export const broadcastButtonSchema = z.object({
  text: z.string().trim().min(1, 'Button text is required.').max(64),
  url: z
    .string()
    .trim()
    .min(1, 'Button URL is required.')
    .url('Button URL must be a valid URL.')
    .refine((value) => value.startsWith('https://'), { message: 'Button URL must start with https://' }),
  iconCustomEmojiId: z
    .string()
    .trim()
    .regex(/^[0-9]{1,32}$/, 'Invalid premium emoji icon id.')
    .nullish()
});

// 'html' titles/bodies come from the rich-text composer (WYSIWYG slice) —
// the client only *proposes* titleFormat/bodyFormat; this transform is what
// actually guarantees whatever gets stored/sent is restricted to Telegram's
// parse_mode:'HTML' subset (<b><i><u><s><a href="https://...">), no matter
// what a client (browser or otherwise) actually sent. 'plain' fields pass
// through completely untouched — no HTML processing at all, preserving
// every prior slice's behavior byte-for-byte. One shared field definition
// for both title and body (prompt 0149) — identical shape, no reason for
// two separate enums.
const formatField = z.enum(['plain', 'html']).optional().default('plain');

function sanitizeHtmlBodyIfNeeded(data, ctx) {
  let result = data;
  // Prompt 0149 — title gets the exact same treatment body already had,
  // checked first so a bad link in the TITLE is reported against the
  // title field, not misattributed to body.
  if (result.titleFormat === 'html') {
    const { html, hadInvalidLink } = sanitizeTelegramHtml(result.title);
    if (hadInvalidLink) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'One of the links in the title has an invalid URL — it must start with https://.',
        path: ['title']
      });
      return z.NEVER;
    }
    result = { ...result, title: html };
  }
  if (result.bodyFormat === 'html') {
    const { html, hadInvalidLink } = sanitizeTelegramHtml(result.body);
    if (hadInvalidLink) {
      // Reject with a clear error rather than silently dropping the bad
      // link's href — same "don't silently correct" precedent as inline
      // buttons' URL validation.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'One of the links in the message has an invalid URL — it must start with https://.',
        path: ['body']
      });
      return z.NEVER;
    }
    result = { ...result, body: html };
  }
  return result;
}

// Prompt 0149 — title becomes a single-line rich-text field, so the raw
// string sent over the wire can now be longer than what a reader actually
// sees once tags are stripped (e.g. <b>...</b><a href="https://...">...</a>
// around a short visible title). `title`'s own `.max()` below is
// deliberately a loose sanity cap on the RAW string (guards against a
// pathological/malformed payload, not a real content limit); the REAL
// 200-character limit is enforced here, after sanitization, against the
// PLAIN-TEXT length a reader would actually see — matching how
// captionLengthOk below already measures the rendered length, not the raw
// markup, for the media-caption cap.
function titleLengthOk(data) {
  return plainTextLength(data.title, data.titleFormat) <= 200;
}
const TITLE_TOO_LONG_ISSUE = {
  message: 'Title must be at most 200 characters.',
  path: ['title']
};

// Telegram's own caption cap when media (image or video) is attached — see
// formatting.js's computeCaptionLength for how this is measured (the
// *rendered* length of BOTH title and body, each by its own format, tags/
// entities already accounted for). Only relevant once mediaFileId/mediaUrl
// is known, so this runs as a whole-object check after both fields have
// already been sanitized into their final form. The 1024 limit is
// identical for sendPhoto and sendVideo captions, so this doesn't need to
// branch on mediaType at all.
function captionLengthOk(data) {
  // Prompt 0141 — mediaServerFilename added: a cross-bot "Salin ke form"
  // copy genuinely has media attached (real bytes on disk, about to be
  // sent) even while mediaFileId is still blank (resolved lazily, per bot,
  // at actual send time — see broadcastMedia.js). Without this, such a
  // broadcast would wrongly get the 4096-char no-media limit here while
  // still actually being sent with media, only to have Telegram itself
  // reject the real send with an oversized-caption error instead of this
  // endpoint catching it up front.
  const hasMedia = Boolean(data.mediaFileId || data.mediaServerFilename || data.mediaUrl);
  if (!hasMedia) return true;
  return computeCaptionLength(data.title, data.titleFormat, data.body, data.bodyFormat) <= 1024;
}
const CAPTION_TOO_LONG_ISSUE = {
  message: 'With an image or video attached, the title + message combined must be at most 1024 characters — remove the media or shorten the text.',
  path: ['body']
};

// mediaType disambiguates what mediaFileId actually is (video-upload
// slice) — a client that omits it but sets mediaFileId/mediaUrl anyway
// (e.g. an older composer build, or a direct API call) defaults to
// 'image', the only thing that ever existed before video did. This keeps
// every stored row's mediaType unambiguous without forcing every caller to
// always pass it explicitly.
function inferMediaTypeIfNeeded(data) {
  if (data.mediaType) return data;
  if (data.mediaFileId || data.mediaServerFilename || data.mediaUrl) return { ...data, mediaType: 'image' };
  return data;
}

export const createBroadcastSchema = z
  .object({
    // Prompt 0138 (dual-bot foundation) — a plain optional string, not
    // z.enum(['test','official']): the actual "is this a real bot id"
    // check happens in the controller via resolveBotId(), which returns
    // its own distinct INVALID_BOT_ID error code instead of zod's generic
    // VALIDATION_ERROR wording. Left unvalidated here on purpose so both
    // failure paths (missing vs. invalid) produce exactly the response
    // requirement 4 (0138's own verification list) asks for.
    bot: z.string().trim().optional(),
    // Prompt 0149 — .max(1000) here is a loose sanity cap on the RAW string
    // (which can now carry real markup around a title, e.g.
    // <b>...</b><a href="https://...">...</a>), not the real content limit
    // — see titleLengthOk's own comment for where the actual 200-visible-
    // character rule is enforced, after sanitization.
    title: z.string().trim().min(1).max(1000),
    titleFormat: formatField,
    body: z.string().trim().min(1),
    mediaUrl: z.string().trim().url().nullish(),
    mediaFileId: z.string().trim().min(1).nullish(),
    // Prompt 0141 — the bot-agnostic server file this media actually lives
    // at (see broadcastMedia.js). Re-validated for real in the controller
    // (validateMediaServerFilename()) against the exact filename shape
    // this server itself could have produced, AND that the file still
    // exists on disk — this schema only checks basic shape (a non-empty
    // string), same "shape here, real check in the controller" split
    // `bot` above already uses.
    mediaServerFilename: z.string().trim().min(1).nullish(),
    // Prompt 0134 addendum — was `.optional()` (accepts a missing key, but
    // NOT an explicit `null`), inconsistent with its sibling fields above,
    // which both already use `.nullish()`. ComposePage.jsx's real submit
    // payload always sends `mediaType: fields.mediaType || null` — a
    // literal `null`, not an omitted key, whenever no media is attached —
    // so this rejected every real medialess broadcast a browser ever sent
    // through this route with `400 mediaType: Expected 'image' | 'video',
    // received null`. Pre-existing (unrelated to 0134's own recurring
    // changes; this field predates them) and never caught before because
    // every prior Compose verification in this repo's history used either
    // a live `curl` call (which simply omits the key rather than sending
    // `null`) or a mocked fetch response — this addendum's own real
    // browser-driven Puppeteer run was the first time this exact code path
    // was ever actually exercised end-to-end.
    mediaType: z.enum(['image', 'video']).nullish(),
    targetType: z.enum(['channel', 'subscribers']),
    targetChannelId: z.string().trim().min(1).nullish(),
    scheduledAt: isoDateString.nullish(),
    // Prompt 0134 — mutually exclusive with scheduledAt (a broadcast is
    // either a one-time send/schedule, or a recurring one, never both; see
    // the refine below). Server-side single-active-recurring enforcement
    // lives in the controller (findActiveRecurringBroadcast()), not here —
    // this schema only validates shape, not cross-row state.
    recurring: z.boolean().optional().default(false),
    // Prompt 0164 — per-broadcast recurring cadence (was a single fixed
    // global env value shared by every recurring broadcast). Both fields
    // are only ever MEANINGFUL when recurring is true (see the refines
    // below, which reject the inconsistent case of recurringStartsAt set
    // on a non-recurring request outright, same "don't silently ignore a
    // nonsensical combination" precedent as the scheduledAt+recurring
    // refine just above) — the controller/repo layer harmlessly ignores
    // both for a non-recurring create either way.
    recurringIntervalHours: z.number().int().min(1).max(24).optional().default(1),
    // recurringStartsAt null/omitted = "Mulai sekarang" (due immediately —
    // see recurringSchedule.js's own computeRecurringDue()); set = "Mulai
    // pada jam tertentu". Same isoDateString shape as scheduledAt.
    recurringStartsAt: isoDateString.nullish(),
    // Prompt 0234 (P1) — only meaningful when recurring is true (refine
    // below rejects the inconsistent combination, same precedent as
    // recurringStartsAt): atomically deactivates the currently active
    // recurring broadcast and activates this one in its place, instead of
    // the plain 409 RECURRING_ALREADY_ACTIVE.
    replaceActiveRecurring: z.boolean().optional().default(false),
    buttons: z.array(broadcastButtonSchema).max(10, 'At most 10 buttons.').optional().default([]),
    bodyFormat: formatField
  })
  .refine((data) => data.targetType !== 'channel' || Boolean(data.targetChannelId), {
    message: 'targetChannelId is required when targetType is "channel".',
    path: ['targetChannelId']
  })
  .refine((data) => !data.scheduledAt || Date.parse(data.scheduledAt) > Date.now(), {
    message: 'scheduledAt must be in the future.',
    path: ['scheduledAt']
  })
  .refine((data) => !(data.recurring && data.scheduledAt), {
    message: 'A broadcast cannot be both scheduled and recurring.',
    path: ['recurring']
  })
  .refine((data) => data.recurring || !data.recurringStartsAt, {
    message: 'recurringStartsAt only applies when recurring is true.',
    path: ['recurringStartsAt']
  })
  .refine((data) => data.recurring || !data.replaceActiveRecurring, {
    message: 'replaceActiveRecurring only applies when recurring is true.',
    path: ['replaceActiveRecurring']
  })
  // Same "must be in the future" rule as scheduledAt's own refine above —
  // no separate tolerance window, matching that exact existing rule.
  .refine((data) => !data.recurring || !data.recurringStartsAt || Date.parse(data.recurringStartsAt) > Date.now(), {
    message: 'recurringStartsAt must be in the future.',
    path: ['recurringStartsAt']
  })
  .transform(sanitizeHtmlBodyIfNeeded)
  .transform(inferMediaTypeIfNeeded)
  .refine(titleLengthOk, TITLE_TOO_LONG_ISSUE)
  .refine(captionLengthOk, CAPTION_TOO_LONG_ISSUE);

// Content-only edit (title/titleFormat/body/mediaUrl/mediaFileId/
// mediaServerFilename/mediaType/buttons/bodyFormat) — never target/
// schedule, see telegramBroadcastController.js's updateContent().
export const updateContentSchema = z
  .object({
    title: z.string().trim().min(1).max(1000),
    titleFormat: formatField,
    body: z.string().trim().min(1),
    mediaUrl: z.string().trim().url().nullish(),
    mediaFileId: z.string().trim().min(1).nullish(),
    mediaServerFilename: z.string().trim().min(1).nullish(),
    // Same fix, same reason as createBroadcastSchema's own mediaType field
    // above — updateContent's real caller (ComposePage.jsx's edit-mode
    // submit) sends the exact same `fields.mediaType || null` shape.
    mediaType: z.enum(['image', 'video']).nullish(),
    buttons: z.array(broadcastButtonSchema).max(10, 'At most 10 buttons.').optional().default([]),
    bodyFormat: formatField
  })
  .transform(sanitizeHtmlBodyIfNeeded)
  .transform(inferMediaTypeIfNeeded)
  .refine(titleLengthOk, TITLE_TOO_LONG_ISSUE)
  .refine(captionLengthOk, CAPTION_TOO_LONG_ISSUE);

// scheduled_at-only edit — same "must be in the future" rule as
// createBroadcastSchema's own refine, duplicated rather than shared since
// the two schemas' shapes don't otherwise overlap.
export const rescheduleSchema = z
  .object({ scheduledAt: isoDateString })
  .refine((data) => Date.parse(data.scheduledAt) > Date.now(), {
    message: 'scheduledAt must be in the future.',
    path: ['scheduledAt']
  });
