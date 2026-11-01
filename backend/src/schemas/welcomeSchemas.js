/**
 * Prompt 0167 — moved out of routes/adminWelcomeRoutes.js verbatim
 * (byte-for-byte, not rewritten) — the zod-schema section only; multer
 * upload middleware stays in the route file (see
 * telegramBroadcastSchemas.js's own header for the same note). Zero
 * database dependency here — see announcementSchemas.js's own header for
 * why that property matters.
 */
import { z } from 'zod';
import { sanitizeTelegramHtml, plainTextLength, captionLimitFor } from '../telegram/formatting.js';

// Same shape as telegramBroadcastSchemas.js's own broadcastButtonSchema —
// Telegram rejects the whole message over one malformed URL button, so
// this must be exactly as strict here. iconCustomEmojiId (prompt 0153) is
// the same optional digits-only field, duplicated for the same reason the
// rest of this schema already is. Exported for direct unit testing.
export const welcomeButtonSchema = z.object({
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

const bodyFormatField = z.enum(['plain', 'html']).default('plain');

function sanitizeHtmlBodyIfNeeded(data, ctx) {
  if (data.bodyFormat !== 'html') return data;
  const { html, hadInvalidLink } = sanitizeTelegramHtml(data.body);
  if (hadInvalidLink) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'One of the links in the message has an invalid URL — it must start with https://.',
      path: ['body']
    });
    return z.NEVER;
  }
  return { ...data, body: html };
}

// Prompt 0136's own explicit character-limit decision: 1024 with media
// attached (Telegram's own caption cap, identical rule and reasoning as
// telegramBroadcastSchemas.js's captionLengthOk — reused via the same
// plainTextLength() helper, not re-implemented), 4096 without (Telegram's
// own plain-message cap). This already generalizes to video with ZERO
// changes as of prompt 0137 — it was always keyed on "is any media
// attached" (Boolean(data.imageFilename)), never specifically "is it an
// image" — only the error wording below needed updating from
// image-specific to media-generic.
function captionLengthOk(data) {
  const limit = captionLimitFor(Boolean(data.imageFilename));
  return plainTextLength(data.body, data.bodyFormat) <= limit;
}
function captionTooLongIssue(data) {
  const limit = captionLimitFor(Boolean(data.imageFilename));
  return {
    message: data.imageFilename
      ? `With media attached, the message must be at most ${limit} characters — remove the media or shorten the text.`
      : `The message must be at most ${limit} characters.`,
    path: ['body']
  };
}

// Prompt 0141 — "Salin ke bot lain". Same deliberately-unvalidated `bot`
// shape as every other bot-context field in this codebase (resolveBotId()
// in the controller is what actually enforces it, distinguishing
// missing-vs-invalid the same way createBroadcastSchema's own `bot` field
// does).
export const copyToOtherBotSchema = z.object({ bot: z.string().trim().optional() });

export const updateWelcomeSchema = z
  .object({
    // Prompt 0138 (dual-bot foundation) — same deliberately-unvalidated
    // shape as telegramBroadcastSchemas.js's own createBroadcastSchema
    // `bot` field; the real enum check happens in the controller via
    // resolveBotId(), which is what produces the distinct INVALID_BOT_ID
    // error code this prompt's own verification requirement 4 asks for.
    bot: z.string().trim().optional(),
    body: z.string().trim().min(1, 'Message is required.'),
    bodyFormat: bodyFormatField,
    imageFilename: z.string().trim().min(1).nullable(),
    buttons: z.array(welcomeButtonSchema).max(10, 'At most 10 buttons.').default([])
  })
  .transform(sanitizeHtmlBodyIfNeeded)
  .superRefine((data, ctx) => {
    if (!captionLengthOk(data)) {
      const issue = captionTooLongIssue(data);
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: issue.path });
    }
  });
