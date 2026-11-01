/**
 * Pure helpers for the two commands the bot answers (prompt 0233):
 * /start (with an optional deep-link payload, used for ad attribution)
 * and /help (a single plain-text reply). No I/O here — poller.js does the
 * sending; keeping these pure follows the same testability convention as
 * welcome.js's shouldSendWelcome()/buildWelcomeMessage().
 */

/**
 * The exact owner-specified shape for a /start message that may carry a
 * deep-link payload: "/start", optionally "@BotUsername" (Telegram appends
 * it in group contexts), optionally one payload of 1 to 64 characters from
 * Telegram's own deep-link charset (a to z, A to Z, 0 to 9, _ and -).
 * Anything outside this shape (extra words, characters outside the
 * charset, over-long payloads) yields NO payload — the welcome reply still
 * goes out (poller.js's trigger stays startsWith('/start'), unchanged),
 * only the attribution is dropped.
 */
export const START_PAYLOAD_PATTERN = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/;

/** Returns the /start deep-link payload, or null when there is none or the text does not match the strict shape above. */
export function parseStartPayload(text) {
  if (typeof text !== 'string') return null;
  const match = START_PAYLOAD_PATTERN.exec(text);
  return match?.[1] ?? null;
}

/** "/help" or "/help@BotUsername", nothing else — "/helpme" etc. stays unanswered, same as before this prompt. */
const HELP_COMMAND_PATTERN = /^\/help(?:@\w+)?$/;

export function isHelpCommand(text) {
  return typeof text === 'string' && HELP_COMMAND_PATTERN.test(text);
}

/**
 * The /help reply — one plain text message, no buttons, no parse mode
 * (nothing to escape in a fixed non-user-supplied string, same reasoning
 * as the plain-format welcome). Exact owner wording, prompt 0233 fase 2.
 */
export const HELP_MESSAGE_TEXT =
  'Fluxio Wallet official bot. You receive product announcements here. ' +
  'Get the wallet at fluxiowallet.com. We will never DM you first or ask for your seed phrase.';

/**
 * Prompt 0236 — the auto reply for any OTHER private message (free text,
 * stickers/media with no text, unknown commands like /settings). Born from
 * a real BotFather Status Alert ("Too few replies to incoming private
 * messages, conversion 0%", 30 Oktober 2026): the bot used to ignore
 * everything that was not /start or /help. One plain text message, no
 * buttons, exact owner wording — no hyphen, no newline.
 */
export const AUTO_REPLY_TEXT =
  'Thanks for your message. This bot only sends Fluxio announcements and does not read replies. ' +
  'For help, message @FluxioWallet or email fluxio.wallet@gmail.com. ' +
  'We will never DM you first or ask for your seed phrase.';

/** Anti spam: at most one auto reply per chat per this window (poller keeps the per chat timestamps). */
export const AUTO_REPLY_WINDOW_MS = 10 * 60 * 1000;

/**
 * True only for a PRIVATE message from a human that neither the /start
 * branch nor the /help branch will answer — the poller replies to exactly
 * these with AUTO_REPLY_TEXT. Deliberately conservative on every gate:
 *  - chat.type must be 'private' (the poller also receives group messages,
 *    subject to the bot's privacy mode — an auto reply must never land in
 *    a group/channel);
 *  - from must exist and not be a bot;
 *  - anything the welcome branch's own trigger shape catches
 *    (text startsWith '/start' — mirrored exactly, so classification can
 *    never disagree with the poller's branch order) and /help are excluded;
 *  - a message with NO text at all (sticker, photo, voice) counts as
 *    unknown and gets the reply.
 */
export function isUnknownPrivateMessage(update) {
  const message = update?.message;
  if (!message || message.chat?.type !== 'private') return false;
  if (!message.from || message.from.is_bot) return false;
  const text = message.text;
  if (typeof text === 'string' && text.startsWith('/start')) return false;
  if (isHelpCommand(text)) return false;
  return true;
}
