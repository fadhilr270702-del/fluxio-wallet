/**
 * Prompt 0152 — the emoji-asset proxy: `GET /admin/emoji-assets/:botId/
 * :customEmojiId/thumb` (a static raster preview) and `.../file` (the real
 * animation — a gunzipped Lottie JSON for a TGS/animated emoji, raw bytes
 * for a WEBM/video one, raw bytes for a plain static custom emoji).
 *
 * THE SECURITY PROPERTY THIS FILE EXISTS FOR: a Telegram file-download URL
 * always embeds the bot's raw token (`api.telegram.org/file/bot<TOKEN>/...`
 * — see client.js's downloadFile()). That URL is constructed and fetched
 * ENTIRELY inside client.js and is never returned here in any form — not
 * in a JSON field, not as a redirect Location header, not interpolated
 * into an error message. Every failure path below uses a fixed, generic
 * message (mirroring telegramBroadcastController.js's own getMedia(),
 * which established this exact posture for the same two underlying calls,
 * getFile/downloadFile) — there is deliberately nothing here for a test or
 * a real response to leak, by construction, not by remembering to redact
 * it at each call site.
 *
 * Auth is the admin session cookie via requireAuth (see
 * routes/adminEmojiAssetsRoutes.js) — the exact same pattern already
 * established for broadcast/welcome media preview (never a bearer token,
 * never a signed URL): the frontend fetches this like any other admin API
 * call (`credentials:'include'`) and turns the response into a Blob, never
 * a plain `<img src>`/`<video src>` pointed straight at this URL.
 *
 * Disk cache (emojiAssetCache.js) is keyed by `file_unique_id`, storing the
 * exact bytes this endpoint would otherwise send — already gunzipped for a
 * TGS "file" response — so a cache hit skips both the Telegram round trip
 * AND the gunzip work, not just the network call.
 */
import zlib from 'node:zlib';
import { findEmojiByBotAndId } from '../db/repositories/telegramEmojiPacksRepo.js';
import { getTelegramClient } from '../telegram/client.js';
import { isValidBotId } from '../telegram/botIds.js';
import { readCachedEmojiAsset, writeCachedEmojiAsset } from '../telegram/emojiAssetCache.js';
import { HttpError } from '../utils/httpError.js';

// 1 year — these assets are immutable once fetched (a given custom_emoji_id
// always resolves to the same underlying file), unlike broadcast/welcome
// media previews (which back a mutable, editable row and stay at a much
// shorter max-age). `private` since this is still gated by an admin
// session, not a publicly cacheable resource.
const CACHE_CONTROL = 'private, max-age=31536000, immutable';

const EXTENSION_MIME = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webm': 'video/webm'
};

function mimeFromFilePath(filePath, fallback) {
  const match = /\.[a-z0-9]+$/i.exec(filePath || '');
  return (match && EXTENSION_MIME[match[0].toLowerCase()]) || fallback;
}

/**
 * Downloads `fileId` via `botId`'s own client and returns `{data, contentType}`
 * ready to send — already gunzipped when `treatAsLottie` is set (the "file"
 * of an animated emoji), otherwise raw bytes. Every failure here is a
 * fixed, generic HttpError — see this file's own header.
 */
async function downloadAndProcess(botId, fileId, { treatAsLottie, defaultMime }) {
  const client = getTelegramClient(botId);
  if (!client) {
    throw new HttpError(409, 'TELEGRAM_NOT_CONFIGURED', `No Telegram bot token is configured for bot '${botId}'.`);
  }

  let file;
  try {
    file = await client.getFile(fileId);
  } catch {
    throw new HttpError(502, 'TELEGRAM_GET_FILE_FAILED', 'Could not resolve this emoji asset from Telegram.');
  }

  let downloadRes;
  try {
    downloadRes = await client.downloadFile(file.file_path);
  } catch {
    throw new HttpError(502, 'TELEGRAM_DOWNLOAD_FAILED', 'Could not download this emoji asset from Telegram.');
  }

  const raw = Buffer.from(await downloadRes.arrayBuffer());

  if (treatAsLottie) {
    let json;
    try {
      json = zlib.gunzipSync(raw);
    } catch {
      throw new HttpError(502, 'EMOJI_ASSET_DECODE_FAILED', 'Could not decode this emoji\'s animation data.');
    }
    return { data: json, contentType: 'application/json' };
  }

  return { data: raw, contentType: mimeFromFilePath(file.file_path, defaultMime) };
}

async function serveAsset(req, res, kind) {
  const { botId, customEmojiId } = req.params;
  // Both branches use the SAME generic 404 — an unknown bot id and an
  // unknown custom_emoji_id are indistinguishable to the caller, which is
  // fine here (this is a lookup-by-id proxy, not a form with per-field
  // feedback a legitimate user needs).
  if (!isValidBotId(botId)) {
    throw new HttpError(404, 'EMOJI_NOT_FOUND', 'No such emoji asset.');
  }
  const emoji = findEmojiByBotAndId(botId, customEmojiId);
  if (!emoji) {
    throw new HttpError(404, 'EMOJI_NOT_FOUND', 'No such emoji asset.');
  }

  const isThumb = kind === 'thumb';
  const fileId = isThumb ? emoji.thumb_file_id : emoji.file_id;
  const fileUniqueId = isThumb ? emoji.thumb_file_unique_id : emoji.file_unique_id;
  if (!fileId || !fileUniqueId) {
    throw new HttpError(404, 'EMOJI_NOT_FOUND', 'No such emoji asset.');
  }

  const cached = readCachedEmojiAsset(fileUniqueId);
  if (cached) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.send(cached.data);
    return;
  }

  // Only a "file" (not "thumb") request for an animated (non-video) emoji
  // is TGS/gzipped Lottie JSON that needs decoding — a thumbnail is always
  // a plain static raster image, and a video emoji's "file" is WEBM
  // streamed as-is, per the base prompt's own explicit per-format rules.
  const treatAsLottie = !isThumb && emoji.is_animated && !emoji.is_video;
  const defaultMime = isThumb ? 'image/webp' : emoji.is_video ? 'video/webm' : 'image/webp';
  const { data, contentType } = await downloadAndProcess(botId, fileId, { treatAsLottie, defaultMime });

  writeCachedEmojiAsset(fileUniqueId, data, contentType);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', CACHE_CONTROL);
  res.send(data);
}

export function getThumb(req, res) {
  return serveAsset(req, res, 'thumb');
}

export function getFile(req, res) {
  return serveAsset(req, res, 'file');
}
