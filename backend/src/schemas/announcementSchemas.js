/**
 * Prompt 0167 — moved out of routes/adminAnnouncementsRoutes.js verbatim
 * (byte-for-byte, not rewritten). This module has zero database dependency
 * — no import here reaches db/client.js, directly or transitively — so a
 * test that only needs these schemas (schema.safeParse()) never has to
 * import the route file, and therefore never accidentally pulls in the
 * controller -> repo -> db/client.js chain that used to open a real
 * DatabaseSync connection to the actual dev database as a pure import side
 * effect. See db/client.js's own header and prompt/0167's archive for the
 * full incident this restructuring fixes.
 */
import { z } from 'zod';
import { sanitizeRichHtml, plainTextLength } from '../utils/richHtml.js';

// Prompt 0172 — 'mobile' added alongside the project's pre-existing
// web/extension/all vocabulary (migration 0025 widens the matching
// target_platform CHECK constraint the same way; publicAnnouncementsController.js's
// own VALID_PLATFORMS set gets the same addition). Named once and reused by
// both createSchema/updateSchema below, closing the one-value-in-two-places
// duplication that already existed before this prompt.
const TARGET_PLATFORM_VALUES = ['web', 'extension', 'mobile', 'all'];

const isoDateString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Must be a valid ISO-8601 date string.' });

// Prompt 0163 — mirrors adminTelegramBroadcastRoutes.js's own `formatField`
// exactly (same shape, same reasoning): the client only *proposes*
// titleFormat/bodyFormat, this backend never trusts that claim as-is — see
// sanitizeHtmlFieldsIfNeeded below, which re-sanitizes every 'html'-format
// value through sanitizeRichHtml() at write time regardless of what a
// client actually sent. Deliberately NO <tg-emoji> allowance anywhere in
// this file — announcements aren't a Telegram concept, so premium custom
// emoji simply doesn't apply (see CLAUDE.md's own note on this distinction,
// and richHtml.js's own header).
const formatField = z.enum(['plain', 'html']).optional().default('plain');

// Prompt 0163 — title becomes a single-line rich-text field (RichTextEditor
// singleLine, no premium emoji), so the raw string sent over the wire can
// now be longer than what a reader actually sees once tags are stripped
// (e.g. <b>...</b><a href="https://...">...</a> around a short visible
// title) — same reasoning as adminTelegramBroadcastRoutes.js's own
// titleLengthOk. `.max(1000)` below is a loose sanity cap on the RAW
// string, not a real content limit; the REAL 200-character limit is
// enforced by titleLengthOk, after sanitization, against the PLAIN-TEXT
// length a reader would actually see.
function titleLengthOk(data) {
  return plainTextLength(data.title, data.titleFormat) <= 200;
}
const TITLE_TOO_LONG_ISSUE = { message: 'Title must be at most 200 characters.', path: ['title'] };

/**
 * Sanitizes title/body whenever their own format is 'html' — same
 * transform-and-reject-on-invalid-link pattern as
 * adminTelegramBroadcastRoutes.js's own sanitizeHtmlBodyIfNeeded, just
 * against the generic sanitizeRichHtml() (no <tg-emoji> allowance) instead
 * of sanitizeTelegramHtml(). A 'plain'-format field passes through
 * completely untouched — no HTML processing at all.
 */
function sanitizeHtmlFieldsIfNeeded(data, ctx) {
  let result = data;
  if (result.titleFormat === 'html') {
    const { html, hadInvalidLink } = sanitizeRichHtml(result.title);
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
    const { html, hadInvalidLink } = sanitizeRichHtml(result.body);
    if (hadInvalidLink) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'One of the links in the body has an invalid URL — it must start with https://.',
        path: ['body']
      });
      return z.NEVER;
    }
    result = { ...result, body: html };
  }
  return result;
}

export const createSchema = z
  .object({
    title: z.string().trim().min(1).max(1000),
    titleFormat: formatField,
    body: z.string().trim().min(1),
    bodyFormat: formatField,
    level: z.enum(['info', 'warning', 'critical']).default('info'),
    targetPlatform: z.enum(TARGET_PLATFORM_VALUES).default('all'),
    startsAt: isoDateString.nullish(),
    endsAt: isoDateString.nullish()
  })
  .transform(sanitizeHtmlFieldsIfNeeded)
  .refine(titleLengthOk, TITLE_TOO_LONG_ISSUE);

// Same as createSchema but every field optional — a PUT may touch just one
// field. Built from the same base object (not createSchema itself, which is
// already a ZodEffects after .transform()/.refine() and has no .partial()
// method) so titleFormat/bodyFormat default to 'plain' independently here
// too, then goes through the identical sanitize+length pipeline.
export const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(1000),
    titleFormat: formatField,
    body: z.string().trim().min(1),
    bodyFormat: formatField,
    level: z.enum(['info', 'warning', 'critical']).default('info'),
    targetPlatform: z.enum(TARGET_PLATFORM_VALUES).default('all'),
    startsAt: isoDateString.nullish(),
    endsAt: isoDateString.nullish()
  })
  .partial()
  .transform(sanitizeHtmlFieldsIfNeeded)
  .refine((data) => data.title === undefined || titleLengthOk(data), TITLE_TOO_LONG_ISSUE);
