/**
 * Server-side broadcast media storage + per-bot file_id resolution (prompt
 * 0141, Stage C of the dual-bot arc). Before this prompt, a broadcast's
 * image/video only ever existed as Telegram's own file_id — the raw bytes
 * were uploaded once (to the 'test' bot's own storage chat, hardcoded) and
 * discarded the instant the request ended (see the old uploadImage/
 * uploadVideo comments in telegramBroadcastController.js). That made the
 * media fundamentally single-bot: a file_id is scoped to the bot that
 * issued it (prompt 0135's own investigation), so 'official' could never
 * reuse anything 'test' uploaded, and vice versa.
 *
 * This file keeps the actual bytes on this server's own disk — reusing
 * `backend/uploads/` (already gitignored, already exists for
 * welcome.js's own per-bot media) rather than a new directory — under a
 * deliberately BOT-AGNOSTIC filename (`broadcast-media-<uuid>.<ext>`, no
 * bot segment, unlike welcome.js's `welcome-media-<bot>-<uuid>.<ext>`):
 * broadcast media is the same underlying content shared across bots by
 * design (the whole point of this prompt is reusing one upload's bytes for
 * both bots), whereas welcome media is deliberately separate content per
 * bot. `ensureBroadcastMediaFileId()` is the other half — given a server
 * file and which bot needs to actually send it, uploads the bytes to that
 * bot's own storage chat AT MOST ONCE ever (cached in
 * `telegram_broadcast_media_file_ids`), regardless of how many broadcast
 * rows across however many bots end up referencing that same server file
 * via "Salin ke form".
 *
 * Storage policy (explicit, not an oversight): broadcast media files are
 * kept FOREVER for now, mirroring how broadcast history itself is
 * permanent — this is an internal tool, and the growth is a deliberate,
 * accepted trade-off rather than an unbounded leak nobody noticed. Unlike
 * welcome.js's `welcome_versions` (a bounded 20-row retention window with
 * real pruning), there is no retention limit or pruning pass here. If disk
 * usage ever becomes a real problem, a by-age pruning pass (e.g. "no
 * broadcast referencing this file is newer than N months") is the natural
 * follow-up — this file's own header is where that future decision should
 * start, should it ever become necessary.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getTelegramClient } from './client.js';
import { config } from '../config/env.js';
import {
  findBroadcastMediaFileId,
  saveBroadcastMediaFileId
} from '../db/repositories/broadcastMediaFileIdsRepo.js';
import { UPLOADS_DIR } from './welcome.js';

// Deliberately no bot segment (see this file's own header comment) — the
// UUID alone is enough to make every upload's filename unique; validated
// with the same explicit "reject anything else, never resolve a client-
// supplied filename ourselves" posture welcome.js's own
// isValidUploadedMediaFilename() established.
const SERVER_FILENAME_PATTERN =
  /^broadcast-media-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|mp4)$/;

const EXTENSION_TO_MIME_TYPE = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4'
};
const MIME_TYPE_TO_EXTENSION = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4'
};

/** True only for a filename this module itself could have produced — see saveServerMedia(). Never trust a client-echoed filename beyond this check (same reasoning as welcome.js's own equivalent). */
export function isValidServerMediaFilename(filename) {
  return typeof filename === 'string' && SERVER_FILENAME_PATTERN.test(filename);
}

/** Derives image vs. video purely from a filename's own extension — mirrors welcome.js's mediaTypeForFilename(), duplicated rather than imported since the two modules' filename patterns are intentionally different shapes. */
export function mediaTypeForServerFilename(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.mp4') return 'video';
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp') return 'image';
  return null;
}

/**
 * The pure gate every real send/immediate-send path checks before ever
 * calling ensureBroadcastMediaFileId() — true only when a broadcast has a
 * real server file but this bot's own file_id for it hasn't been resolved
 * yet (a cross-bot "Salin ke form" copy that has never been sent via THIS
 * bot before). False whenever media_file_id is already set (the common
 * case — nothing to do) OR there's no server file at all (no media, or a
 * legacy pre-0141 row with only a bare mediaUrl/mediaFileId to fall back
 * on, neither of which this mechanism touches). Extracted as its own pure
 * function — unlike the actual resolution step, which is inherently I/O
 * (a cache read, and maybe a real Telegram upload) — specifically so this
 * one decision has direct unit coverage; see worker.js's
 * resolveMediaForSend() and telegramBroadcastController.js's create() for
 * the two callers.
 */
export function needsMediaResolution(broadcast) {
  return Boolean(!broadcast.media_file_id && broadcast.media_server_filename);
}

/** Writes a newly-uploaded image or video to its own permanent, bot-agnostic filename. Returns the new filename. */
export function saveServerMedia(buffer, mimeType) {
  const ext = MIME_TYPE_TO_EXTENSION[mimeType];
  if (!ext) {
    throw new Error(`Unsupported media mime type for broadcast upload: ${mimeType}`);
  }
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const filename = `broadcast-media-${randomUUID()}${ext}`;
  writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return filename;
}

/**
 * A structured error `ensureBroadcastMediaFileId()` throws for the two
 * "can't even try" cases (no client / no storage chat) — carries a stable
 * `.code` so an HTTP caller (telegramBroadcastController.js's uploadImage/
 * uploadVideo) can map it to the exact same 409 codes this endpoint always
 * returned, while a non-HTTP caller (worker.js's send paths) can keep
 * using `.message` exactly like every other thrown error it already
 * catches — no new error-handling shape needed there.
 */
export class BroadcastMediaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BroadcastMediaError';
    this.code = code;
  }
}

/**
 * Resolves — and if needed, produces — the file_id this specific bot needs
 * to actually send this specific server-stored file. Three tiers:
 *
 *  1. Already cached (this exact server file has been uploaded to this
 *     exact bot's storage chat before, by ANY broadcast row that ever
 *     referenced it) — return the cached file_id, no Telegram call at all.
 *  2. Not cached yet — upload the actual bytes to this bot's own storage
 *     chat once, cache the result, return the new file_id. This is the
 *     "efisien, bukan upload per chat" requirement: called once per
 *     (server file, bot) pair total, never once per recipient.
 *  3. This bot has no client configured, or no storage chat configured —
 *     throws a BroadcastMediaError with a stable `.code`, never silently
 *     returns null (a caller that got this far already has real media to
 *     send and needs to know sending is impossible, not that there's
 *     simply nothing to send).
 *
 * Every caller (telegramBroadcastController.js's upload endpoints and
 * create()'s immediate-channel branch, worker.js's three send paths) calls
 * this immediately before formatting.js's resolveBroadcastMedia() — see
 * this file's own header for why that's the minimal hook point.
 */
export async function ensureBroadcastMediaFileId(botId, mediaFilename, mediaType) {
  const cached = findBroadcastMediaFileId(mediaFilename, botId);
  if (cached) return cached;

  const client = getTelegramClient(botId);
  if (!client) {
    throw new BroadcastMediaError('TELEGRAM_NOT_CONFIGURED', `No Telegram bot token is configured for bot '${botId}'.`);
  }
  const storageChatId = config.telegram.bots[botId]?.storageChatId;
  if (!storageChatId) {
    throw new BroadcastMediaError(
      'TELEGRAM_STORAGE_NOT_CONFIGURED',
      `No Telegram storage chat is configured for bot '${botId}' — media upload/send is disabled until it is.`
    );
  }

  const buffer = readFileSync(path.join(UPLOADS_DIR, mediaFilename));
  const mimeType = EXTENSION_TO_MIME_TYPE[path.extname(mediaFilename).toLowerCase()] || 'application/octet-stream';

  let fileId;
  if (mediaType === 'video') {
    const result = await client.uploadVideo(storageChatId, buffer, mediaFilename, mimeType);
    fileId = result.video.file_id;
  } else {
    const result = await client.uploadPhoto(storageChatId, buffer, mediaFilename, mimeType);
    fileId = result.photo[result.photo.length - 1].file_id;
  }

  saveBroadcastMediaFileId(mediaFilename, botId, fileId);
  // Same observability convention prompt 0140 established for every real
  // send path — this IS a real, billable Telegram API call (just an
  // upload, not a send to a subscriber), so it gets the same one-line
  // success log the incident that prompt fixed was built around.
  console.log(`[telegram] broadcast media uploaded: bot=${botId} file=${mediaFilename} file_id=${fileId}`);
  return fileId;
}
