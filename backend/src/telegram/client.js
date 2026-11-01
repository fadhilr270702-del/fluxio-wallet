/**
 * Minimal Telegram Bot API client, hand-rolled on native `fetch` — no
 * `node-telegram-bot-api`/`telegraf` dependency. Only a handful of methods
 * are needed (getMe, sendMessage, sendPhoto, sendVideo, uploadPhoto,
 * uploadVideo, getFile, downloadFile, getUpdates, getStickerSet,
 * getCustomEmojiStickers) against a plain HTTPS+JSON API, and Node ≥22.5
 * (this backend's pinned engine) has global `fetch` built in — see
 * backend/README.md for the full rationale (matches the repo's existing
 * "skip a dependency where a built-in suffices" pattern: bcryptjs over
 * bcrypt, node:sqlite over better-sqlite3).
 *
 * Prompt 0138 (dual-bot foundation) — this file used to expose these
 * methods as plain top-level functions, all reading one global
 * `config.telegram.botToken`. Now each bot (see botIds.js) needs its own
 * fully independent client, since a request/token is never shared between
 * them. `createTelegramClient(botToken)` builds one bot's own client, every
 * method closed over that one token; `getTelegramClient(botId)` is the
 * actual public entry point every caller now uses — it resolves a bot id to
 * its configured token via config.telegram.bots, returning `null` for a bot
 * with no token configured (the existing "no token = inactive, not fatal"
 * convention, just made per-bot instead of global), and caches the built
 * client per bot id for the life of the process (the token itself never
 * changes at runtime, so there's no reason to rebuild the closure per call).
 */
import { config } from '../config/env.js';

// Prompt 0166 — reads config.telegram.apiRoot (real Telegram by default,
// overridable to a dead/local address for live verification — see that
// config value's own comment for the safety gate) instead of a hardcoded
// constant. Resolved once at module load, same as before — this file has
// no other per-call reason to re-read config.
const API_ROOT = config.telegram.apiRoot;

export class TelegramApiError extends Error {
  constructor(errorCode, description, retryAfter) {
    super(description || `Telegram API error ${errorCode}`);
    this.errorCode = errorCode;
    this.retryAfter = retryAfter ?? null;
  }
}

function createTelegramClient(botToken) {
  async function callTelegramApi(method, params, { timeoutMs = 15000 } = {}) {
    const res = await fetch(`${API_ROOT}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await res.json();
    if (!data.ok) {
      throw new TelegramApiError(data.error_code, data.description, data.parameters?.retry_after);
    }
    return data.result;
  }

  /** Verifies the bot token and returns the bot's own identity (username, id, ...). */
  function getMe() {
    return callTelegramApi('getMe');
  }

  /**
   * parseMode is undefined for every 'plain'-format broadcast (see
   * formatting.js's buildBroadcastMessage) — JSON.stringify drops an
   * undefined-valued property, so those calls are byte-identical to the
   * original "always plain text, no parse_mode" behavior. Only 'html'-format
   * broadcasts (the new rich-text composer) ever pass 'HTML' here.
   */
  function sendMessage(chatId, text, replyMarkup, parseMode) {
    return callTelegramApi('sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup, parse_mode: parseMode });
  }

  /** `photo` is whatever resolveBroadcastMedia() (formatting.js) decided to use — a reusable file_id (new broadcasts) or a public URL (legacy broadcasts, see the image-upload slice). */
  function sendPhoto(chatId, photo, caption, replyMarkup, parseMode) {
    return callTelegramApi('sendPhoto', {
      chat_id: chatId,
      photo,
      caption: caption || undefined,
      reply_markup: replyMarkup,
      parse_mode: parseMode
    });
  }

  /** `video` is always a reusable file_id (see the video-upload slice) — unlike photo, video never had a URL-based legacy path. */
  function sendVideo(chatId, video, caption, replyMarkup, parseMode) {
    return callTelegramApi('sendVideo', {
      chat_id: chatId,
      video,
      caption: caption || undefined,
      reply_markup: replyMarkup,
      parse_mode: parseMode
    });
  }

  /**
   * Shared multipart-upload core for both uploadPhoto/uploadVideo — a
   * fundamentally different request shape than callTelegramApi's JSON body
   * (so this doesn't reuse it). Node's native FormData/Blob (global since
   * Node 18) are enough here — no extra dependency needed for this
   * direction, matching this file's existing "native fetch, no bot-API
   * wrapper library" approach. Returns the full API response, from which the
   * caller extracts the reusable file_id (a photo's is nested in an array of
   * sizes; a video's is a single field directly on `result.video`).
   *
   * `caption`/`replyMarkup`/`parseMode` (prompt 0135, extended in 0136 for
   * inline buttons) are all optional — every pre-existing caller (the
   * broadcast composer's image/video upload flow) omits all three, since
   * those calls exist purely to get a file_id back, not to send a real
   * message. `reply_markup` has to be JSON.stringify'd here specifically —
   * unlike callTelegramApi's plain JSON body (where the whole object is
   * stringified once), multipart/form-data fields are all strings, so a
   * nested object needs its own explicit stringify before `form.append`.
   */
  async function uploadMediaToTelegram(method, fieldName, chatId, buffer, filename, mimeType, timeoutMs, { caption, replyMarkup, parseMode } = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(fieldName, new Blob([buffer], { type: mimeType }), filename);
    if (caption) form.append('caption', caption);
    if (parseMode) form.append('parse_mode', parseMode);
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    const res = await fetch(`${API_ROOT}/bot${botToken}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await res.json();
    if (!data.ok) {
      throw new TelegramApiError(data.error_code, data.description, data.parameters?.retry_after);
    }
    return data.result;
  }

  /** Longer than callTelegramApi's default 15s — this is an actual upload, not a small JSON call. */
  function uploadPhoto(chatId, buffer, filename, mimeType, options) {
    return uploadMediaToTelegram('sendPhoto', 'photo', chatId, buffer, filename, mimeType, 30000, options);
  }

  /** Longer timeout than uploadPhoto's — videos are up to 50MB vs. a photo's 10MB, meaningfully slower to transfer. */
  function uploadVideo(chatId, buffer, filename, mimeType, options) {
    return uploadMediaToTelegram('sendVideo', 'video', chatId, buffer, filename, mimeType, 120000, options);
  }

  /**
   * Resolves a file_id to a short-lived `file_path` (plus `file_size`), the
   * first step of the admin-media-proxy flow (prompt 0132 Revision 2 — see
   * telegramBroadcastController.js's getMedia() for the full pipeline and the
   * "never expose the download URL" requirement this and downloadFile()
   * below exist to satisfy). Does not download anything itself.
   */
  function getFile(fileId) {
    return callTelegramApi('getFile', { file_id: fileId });
  }

  /**
   * Downloads the actual file bytes for a resolved getFile() `file_path`,
   * entirely server-side. The download URL is
   * `https://api.telegram.org/file/bot<TOKEN>/<file_path>` — it embeds the
   * raw bot token exactly like every other call in this file, but unlike
   * those JSON-API calls, this one's *response* is the file's raw bytes, not
   * a small JSON envelope a caller might casually log or return outright.
   * This function is the ONLY place that URL is ever constructed or
   * fetched — it must never be returned to a caller, redirected to (a
   * redirect would hand the browser, and therefore its network panel and
   * history, the token-bearing URL directly), or logged; on failure this
   * throws a `TelegramApiError` with a fixed, generic message that never
   * includes the URL, so even an error log stays safe. The caller is
   * expected to stream `response.body` straight through to its own client —
   * see telegramBroadcastController.js's getMedia().
   */
  async function downloadFile(filePath, timeoutMs = 30000) {
    const res = await fetch(`${API_ROOT}/file/bot${botToken}/${filePath}`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      throw new TelegramApiError(res.status, 'Failed to download file from Telegram.');
    }
    return res;
  }

  /**
   * Long-polling read of new updates. timeoutSeconds is Telegram's own
   * long-poll window; the HTTP request timeout is given extra slack over it
   * so the client never aborts a request Telegram was about to legitimately
   * answer (see poller.js).
   */
  function getUpdates(offset, timeoutSeconds) {
    return callTelegramApi(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'my_chat_member'] },
      { timeoutMs: (timeoutSeconds + 5) * 1000 }
    );
  }

  /**
   * Prompt 0152 (premium emoji library) — reads a public custom-emoji
   * sticker set by its short name (the `NAME` in `t.me/addemoji/NAME`).
   * Read-only, cheap, and NOT Premium-gated on either side (verified
   * empirically in this prompt's own Step 0: the trial bot's token reads
   * the exact same public packs the official bot's does) — unlike actually
   * *sending* a `<tg-emoji>`, which prompt 0151's spike proved silently
   * degrades for a non-Premium bot owner. Throws TelegramApiError (pack
   * missing/private/rate-limited) same as every other method here.
   */
  function getStickerSet(name) {
    return callTelegramApi('getStickerSet', { name });
  }

  /**
   * Resolves up to 200 custom_emoji_ids back to their full Sticker objects
   * (file_id/file_unique_id/thumbnail/etc.) — see prompt 0151's own spike
   * evidence for a real captured example of the shape this returns.
   */
  function getCustomEmojiStickers(customEmojiIds) {
    return callTelegramApi('getCustomEmojiStickers', { custom_emoji_ids: customEmojiIds });
  }

  return {
    getMe,
    sendMessage,
    sendPhoto,
    sendVideo,
    uploadPhoto,
    uploadVideo,
    getFile,
    downloadFile,
    getUpdates,
    getStickerSet,
    getCustomEmojiStickers
  };
}

const clientCache = new Map();

/**
 * The one public entry point every caller now uses instead of importing
 * plain functions directly. Returns `null` for a bot with no token
 * configured — every call site is expected to handle that the same way the
 * pre-0138 code handled a missing global botToken (a clean "not configured"
 * error or a skipped poller/worker start, never a crash). Cached per bot id
 * (not re-resolved from config on every call) since config is loaded once
 * and frozen at process start.
 */
export function getTelegramClient(botId) {
  if (!clientCache.has(botId)) {
    const botToken = config.telegram.bots[botId]?.botToken ?? null;
    clientCache.set(botId, botToken ? createTelegramClient(botToken) : null);
  }
  return clientCache.get(botId);
}

/**
 * Converts a broadcast's stored button list ({text, url, iconCustomEmojiId?}[])
 * into Telegram's InlineKeyboardMarkup shape — one button per row (see
 * CLAUDE.md's inline URL buttons slice for why one-per-row was chosen).
 * Returns undefined (not an empty keyboard) when there are no buttons, so
 * JSON.stringify simply omits reply_markup and existing no-button sends are
 * byte-for-byte unchanged. Pure and bot-agnostic — stays a plain top-level
 * export, unlike everything else in this file, since it touches no token
 * and no network.
 *
 * Prompt 0153 — `icon_custom_emoji_id` (Bot API 9.4) is only ever included
 * when a button actually has one stored; a button with none gets a plain
 * `{text, url}` object, byte-identical to every pre-0153 button. This
 * function has no opinion on whether the icon should actually be sent for
 * a given target (a channel needs it stripped — see formatting.js's own
 * degradeForChannel(), applied by the caller AFTER this function runs, not
 * here — this stays the single "build what's stored" step for every
 * target).
 */
export function buildInlineKeyboard(buttons) {
  if (!buttons || buttons.length === 0) return undefined;
  return {
    inline_keyboard: buttons.map((b) => [
      { text: b.text, url: b.url, ...(b.iconCustomEmojiId ? { icon_custom_emoji_id: b.iconCustomEmojiId } : {}) }
    ])
  };
}
