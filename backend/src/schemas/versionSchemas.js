/**
 * Prompt 0167 — moved out of routes/adminVersionsRoutes.js verbatim
 * (byte-for-byte, not rewritten). Zero database dependency here — see
 * announcementSchemas.js's own header for why that property matters.
 */
import { z } from 'zod';
import { compareVersions } from '../utils/compareVersions.js';
import { sanitizeRichHtml, plainTextLength } from '../utils/richHtml.js';

const versionString = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+$/, 'Must be in X.Y.Z format.');

// Prompt 0163 — mirrors announcementSchemas.js's own formatField exactly.
// Deliberately NO <tg-emoji> allowance — versions aren't a Telegram
// concept either.
const formatField = z.enum(['plain', 'html']).optional().default('plain');

// Prompt 0163 — updateMessage becomes a multi-paragraph rich-text field
// (RichTextEditor, no premium emoji), so the raw string can now be longer
// than what a reader actually sees once tags are stripped. `.max(2000)`
// below is a loose sanity cap on the RAW string, not the real content
// limit; the REAL 500-character limit is enforced by updateMessageLengthOk,
// after sanitization, against the PLAIN-TEXT length a reader would
// actually see — same pattern as announcementSchemas.js's own
// titleLengthOk / telegramBroadcastSchemas.js's own titleLengthOk.
function updateMessageLengthOk(data) {
  if (!data.updateMessage) return true; // nullish — nothing to measure, matches the pre-existing optional-message behavior
  return plainTextLength(data.updateMessage, data.updateMessageFormat) <= 500;
}
const UPDATE_MESSAGE_TOO_LONG_ISSUE = { message: 'Update message must be at most 500 characters.', path: ['updateMessage'] };

/**
 * Sanitizes updateMessage whenever its own format is 'html' — same
 * transform-and-reject-on-invalid-link pattern as announcementSchemas.js's
 * own sanitizeHtmlFieldsIfNeeded, against the same generic
 * sanitizeRichHtml() (no <tg-emoji>).
 */
function sanitizeUpdateMessageIfNeeded(data, ctx) {
  if (data.updateMessageFormat !== 'html' || !data.updateMessage) return data;
  const { html, hadInvalidLink } = sanitizeRichHtml(data.updateMessage);
  if (hadInvalidLink) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'One of the links in the update message has an invalid URL — it must start with https://.',
      path: ['updateMessage']
    });
    return z.NEVER;
  }
  return { ...data, updateMessage: html };
}

export const updateVersionSchema = z
  .object({
    latestVersion: versionString,
    minSupportedVersion: versionString,
    updateMessage: z.string().trim().max(2000).nullish(),
    updateMessageFormat: formatField
  })
  // A real footgun to catch at write time — an admin accidentally swapping
  // the two fields would otherwise force-update everyone below a "minimum"
  // that's actually higher than the "latest" version.
  .refine((data) => compareVersions(data.latestVersion, data.minSupportedVersion) >= 0, {
    message: 'latestVersion must be greater than or equal to minSupportedVersion.',
    path: ['latestVersion']
  })
  .transform(sanitizeUpdateMessageIfNeeded)
  .refine(updateMessageLengthOk, UPDATE_MESSAGE_TOO_LONG_ISSUE);
