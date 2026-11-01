/**
 * Protected admin endpoints for the /start welcome message (prompt 0136,
 * extended by 0137 with video support + content-version history). Every
 * handler here runs behind requireAuth (see routes/adminWelcomeRoutes.js),
 * so `req.admin` is always populated.
 *
 * File storage note (why this feature can't reuse the broadcast composer's
 * own image-upload flow verbatim): `uploadImage`/`uploadVideo` in
 * telegramBroadcastController.js deliberately never touch this server's
 * disk — they upload once to a private Telegram storage chat purely to get
 * back a reusable file_id, which is fine for a one-off broadcast but was
 * explicitly rejected for the welcome media: a file_id is scoped to the bot
 * that issued it, and the welcome media needs to keep working across the
 * planned swap to an official bot token (see prompt 0135's own investigation
 * and welcome.js's header comment). backend/uploads/ is gitignored, mutable
 * admin content, distinct from backend/assets/ (committed, static-only).
 *
 * Prompt 0138 (dual-bot foundation) — every endpoint here now resolves a
 * bot-context param via resolveBotId() (query for GET-shaped reads, body
 * for the PUT save; default 'test', 400 on an invalid value), since this
 * whole feature has no other row to derive a bot from until an admin's
 * first save creates one. getVersionMedia is the one exception, staying
 * by-id-only — it derives everything it needs from the version row itself,
 * per this prompt's own "derive from the row wherever possible" principle.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getWelcomeMessageRow, upsertWelcomeMessage } from '../db/repositories/welcomeMessageRepo.js';
import {
  insertWelcomeVersion,
  listWelcomeVersions,
  findWelcomeVersionById,
  pruneVersionsBeyond,
  listAllVersionImageFilenames
} from '../db/repositories/welcomeVersionsRepo.js';
import { recordAuditLog } from '../db/repositories/auditLogsRepo.js';
import {
  UPLOADS_DIR,
  isValidUploadedMediaFilename,
  mediaTypeForFilename,
  mimeTypeForFilename,
  saveUploadedMedia,
  deleteUploadedMedia,
  selectOrphanedFiles,
  migrateLegacyBannerIfNeeded,
  getEffectiveWelcomeConfig,
  WELCOME_MESSAGE_TEXT
} from '../telegram/welcome.js';
import { resolveBotId } from '../telegram/resolveBotId.js';
import { DEFAULT_BOT_ID, otherBotId } from '../telegram/botIds.js';
import { HttpError } from '../utils/httpError.js';

// Prompt 0137's own explicit retention decision — kept as a named constant
// rather than a magic number so update()'s own pruning call reads plainly.
const MAX_VERSIONS = 20;

const EXTENSION_TO_MIME_TYPE = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4' };

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_MIME_TYPE[ext] || 'application/octet-stream';
}

function toApiShape(row) {
  return {
    body: row.body,
    bodyFormat: row.body_format,
    imageFilename: row.image_filename,
    mediaType: row.media_type,
    buttons: JSON.parse(row.buttons || '[]'),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at
  };
}

function toVersionApiShape(row) {
  return {
    id: row.id,
    body: row.body,
    bodyFormat: row.body_format,
    imageFilename: row.image_filename,
    mediaType: row.media_type,
    buttons: JSON.parse(row.buttons || '[]'),
    updatedBy: row.updated_by,
    updatedByEmail: row.updated_by_email,
    createdAt: row.created_at
  };
}

/**
 * Returns the effective current config for the admin UI to load into the
 * form — a real saved row if one exists, or (see migrateLegacyBannerIfNeeded's
 * own comment) the untouched 0135 default with its legacy banner
 * transparently copied into the managed uploads/ directory on this very
 * call, so the response's own `imageFilename` is always a normal,
 * echo-back-safe managed filename — the client never needs to know or
 * care whether an image came from a real admin upload or the old
 * hardcoded asset.
 */
export function get(req, res) {
  const botId = resolveBotId(req.query.bot);
  const row = getWelcomeMessageRow(botId);
  if (row) {
    return res.json({ welcome: toApiShape(row) });
  }
  // The legacy 0135 banner migration only ever applies to the trial bot —
  // see getEffectiveWelcomeConfig()'s own comment for why a brand-new bot
  // has no equivalent legacy asset to fall back to.
  const imageFilename = botId === DEFAULT_BOT_ID ? migrateLegacyBannerIfNeeded() : null;
  res.json({
    welcome: {
      body: WELCOME_MESSAGE_TEXT,
      bodyFormat: 'plain',
      imageFilename,
      mediaType: imageFilename ? 'image' : null,
      buttons: [],
      updatedBy: null,
      updatedAt: null
    }
  });
}

/**
 * Saves the whole config in one shot AND appends a permanent content-
 * version snapshot (prompt 0137) — every Save is now also a new history
 * entry, never overwriting a previous one. `imageFilename` is validated
 * against isValidUploadedMediaFilename() and, if non-null, checked to
 * actually exist in uploads/ — this is what makes it safe to trust a
 * client-echoed filename at all (see welcome.js's own comment on that
 * function); `mediaType` is derived server-side from the filename's own
 * extension, never trusted from the client, so it can never disagree with
 * the actual file.
 *
 * Unlike prompt 0136, a replaced/removed image is NOT deleted here — that
 * was 0136's own single-slot bug (deleting a file immediately on replace
 * meant an OLDER version pointing at that same file would silently break).
 * Cleanup now only ever happens via pruneVersionsBeyond() below, once a
 * version's own file is confirmed unreferenced by anything surviving.
 */
export function update(req, res) {
  const botId = resolveBotId(req.body.bot);
  const { body, bodyFormat, imageFilename, buttons } = req.body;

  let mediaType = null;
  if (imageFilename !== null) {
    if (!isValidUploadedMediaFilename(imageFilename, botId)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'imageFilename must be a filename produced by the upload endpoint for this bot.');
    }
    if (!existsSync(path.join(UPLOADS_DIR, imageFilename))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'That media file was not found — upload it again before saving.');
    }
    mediaType = mediaTypeForFilename(imageFilename);
  }

  const saved = upsertWelcomeMessage({ botId, body, bodyFormat, imageFilename, mediaType, buttons, updatedBy: req.admin.id });

  insertWelcomeVersion({ botId, body, bodyFormat, imageFilename, mediaType, buttons, updatedBy: req.admin.id });

  // Prune beyond the retention limit, then — and only then — decide which
  // of the just-deleted versions' own files are truly orphaned. Order
  // matters: listAllVersionImageFilenames() below must run AFTER
  // pruneVersionsBeyond() has already removed the old rows, or a version
  // about to be deleted would still count as "still referencing" its own
  // file and nothing would ever be cleaned up. The active config's own
  // (freshly-saved) filename is always included as a survivor too, since
  // pruning must never delete the file the poller is about to send.
  //
  // Honest failure-mode note: if the process crashes between
  // pruneVersionsBeyond() returning and the orphaned-file unlinkSync calls
  // finishing below, the DB rows for those old versions are already gone,
  // but one or more of their now-truly-unreferenced files can be left
  // behind on disk permanently — nothing will ever reconsider them, since
  // the only candidates this logic ever examines are versions it JUST
  // deleted in this same call. This is a small, accepted disk leak (at
  // most a handful of already-superseded media files, bounded by however
  // many saves land between backups/manual cleanup), not a data-integrity
  // problem — the active config and every surviving version's own media
  // stay fully correct either way, and no version's file is ever deleted
  // while anything could still legitimately need it.
  const deletedVersions = pruneVersionsBeyond(botId, MAX_VERSIONS);
  if (deletedVersions.length > 0) {
    const candidateFilenames = deletedVersions.map((v) => v.image_filename);
    const stillReferenced = [saved.image_filename, ...listAllVersionImageFilenames(botId)];
    const orphaned = selectOrphanedFiles(candidateFilenames, stillReferenced);
    orphaned.forEach(deleteUploadedMedia);
  }

  recordAuditLog({
    adminId: req.admin.id,
    action: 'welcome.update',
    targetType: 'welcome_message',
    metadata: { bot: botId, bodyFormat, buttonCount: (buttons || []).length, hasImage: Boolean(imageFilename), mediaType }
  });

  res.json({ welcome: toApiShape(saved) });
}

/**
 * Uploads a new image, giving it its own permanent filename (see
 * saveUploadedMedia()'s own comment — no more single-slot overwrite) and
 * returns it. The client includes that filename in the next
 * PUT /admin/welcome to actually apply it — same upload-then-reference
 * pattern as the broadcast composer.
 */
export function uploadImage(req, res) {
  const botId = resolveBotId(req.query.bot);
  if (!req.file) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'No image file was uploaded.');
  }
  const filename = saveUploadedMedia(req.file.buffer, req.file.mimetype, botId);
  res.json({ imageFilename: filename });
}

/** Same shape as uploadImage — mirrors the broadcast composer's own separate image/video upload endpoints (prompt 0137, mutually exclusive with an image at save time via the single image_filename column). */
export function uploadVideo(req, res) {
  const botId = resolveBotId(req.query.bot);
  if (!req.file) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'No video file was uploaded.');
  }
  const filename = saveUploadedMedia(req.file.buffer, req.file.mimetype, botId);
  res.json({ imageFilename: filename });
}

/**
 * Streams the currently-configured welcome media (image or video) back to
 * an authenticated admin, for the Welcome tab's own preview — same
 * "authenticated proxy, never a bare static URL" requirement prompt 0132
 * Revision 2 set for broadcast media previews, just reading from this
 * server's own disk instead of proxying from Telegram. Reuses
 * getEffectiveWelcomeConfig() (the exact same resolution the poller itself
 * uses at send time) rather than re-deriving "which media is active" here.
 */
export function getMedia(req, res) {
  const botId = resolveBotId(req.query.bot);
  const cfg = getEffectiveWelcomeConfig(botId);
  if (!cfg.imagePath || !existsSync(cfg.imagePath)) {
    throw new HttpError(404, 'NO_MEDIA', 'No welcome media is currently configured.');
  }
  res.setHeader('Content-Type', contentTypeForPath(cfg.imagePath));
  res.setHeader('Cache-Control', 'private, max-age=60'); // short — an admin who just replaced the media should see the new one soon
  res.send(readFileSync(cfg.imagePath));
}

/** The full content-version history (prompt 0137) for this bot, newest first — capped at MAX_VERSIONS by pruneVersionsBeyond(), so this never needs its own pagination. */
export function listVersions(req, res) {
  const botId = resolveBotId(req.query.bot);
  res.json({ versions: listWelcomeVersions(botId).map(toVersionApiShape) });
}

/**
 * Streams a SPECIFIC historical version's own media file — distinct from
 * getMedia() above, which always serves the *active* config's media. This
 * is what proves prompt 0137's own single-slot fix actually works: an old
 * version's "Lihat" (View) modal must keep showing what was really
 * attached back when that version was saved, not whatever happens to be
 * active now.
 */
export function getVersionMedia(req, res) {
  const version = findWelcomeVersionById(req.params.id);
  if (!version) {
    throw new HttpError(404, 'NOT_FOUND', 'Version not found.');
  }
  const filePath = version.image_filename ? path.join(UPLOADS_DIR, version.image_filename) : null;
  if (!filePath || !existsSync(filePath)) {
    throw new HttpError(404, 'NO_MEDIA', 'This version has no media, or its file is no longer available.');
  }
  res.setHeader('Content-Type', contentTypeForPath(filePath));
  // A historical version's own media never changes once saved — safe to
  // cache longer than the active-config preview above.
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(readFileSync(filePath));
}

/**
 * "Salin ke bot lain" (prompt 0141, Stage C's welcome half) — copies the
 * CURRENTLY ACTIVE bot's real effective welcome config (body + buttons +
 * media) into the OTHER bot, through the exact same save mechanism a
 * normal admin Save uses (upsertWelcomeMessage + insertWelcomeVersion +
 * recordAuditLog + the same beyond-retention pruning update() already
 * does) — so this is indistinguishable in the DB/audit trail from the
 * target bot's own admin manually pasting the same content in and saving.
 * Direction is always "from whichever bot is active -> the one other bot"
 * (resolveBotId(req.body.bot) is the SOURCE; there are only ever two bots,
 * so the target is never chosen explicitly — see botIds.js's own
 * otherBotId()).
 *
 * Media is genuinely COPIED to a brand-new file under the target bot's own
 * bot-scoped filename (welcome.js's saveUploadedMedia(..., targetBotId)),
 * never shared/referenced by path — welcome media pruning (prompt 0137,
 * narrowed per-bot in 0138) assumes exclusive per-bot ownership of every
 * file it might delete; two bots' rows pointing at the SAME physical file
 * would make one bot's routine pruning pass able to delete a file the
 * OTHER bot's still-active config depends on. This is the opposite
 * decision from broadcast media (prompt 0141's own OTHER half, Stage C):
 * that media is deliberately bot-AGNOSTIC/shared by design, because
 * welcome content is deliberately separate content per bot while broadcast
 * media is the same underlying bytes reused across bots — see
 * broadcastMedia.js's own header for that contrast spelled out.
 *
 * Uses getEffectiveWelcomeConfig() (not the raw row) as the source, so
 * this also works correctly if the source bot has no saved row yet (the
 * trial bot's own legacy default, or a brand-new bot's bare constant
 * text) — whatever a real /start would actually send right now is exactly
 * what gets copied, never something else.
 */
export function copyToOtherBot(req, res) {
  const sourceBotId = resolveBotId(req.body.bot);
  const targetBotId = otherBotId(sourceBotId);

  const source = getEffectiveWelcomeConfig(sourceBotId);

  let imageFilename = null;
  let mediaType = null;
  if (source.imagePath && existsSync(source.imagePath)) {
    const mimeType = mimeTypeForFilename(source.imagePath);
    if (mimeType) {
      const buffer = readFileSync(source.imagePath);
      imageFilename = saveUploadedMedia(buffer, mimeType, targetBotId);
      mediaType = mediaTypeForFilename(imageFilename);
    }
    // A resolved imagePath with an unrecognized extension (shouldn't
    // happen — every path getEffectiveWelcomeConfig can return is either
    // an uploads/ file this app itself wrote, or the committed legacy
    // banner, both always .png/.jpg/.jpeg/.webp/.mp4) degrades to no
    // media rather than throwing, same "never let a body-only edit crash
    // over a media problem" posture the rest of this feature already has.
  }

  const saved = upsertWelcomeMessage({
    botId: targetBotId,
    body: source.body,
    bodyFormat: source.bodyFormat,
    imageFilename,
    mediaType,
    buttons: source.buttons,
    updatedBy: req.admin.id
  });

  insertWelcomeVersion({
    botId: targetBotId,
    body: source.body,
    bodyFormat: source.bodyFormat,
    imageFilename,
    mediaType,
    buttons: source.buttons,
    updatedBy: req.admin.id
  });

  // Same pruning step update() already runs after every save — a copy is
  // just another kind of save, and shouldn't grow the target bot's own
  // version history retention any differently.
  const deletedVersions = pruneVersionsBeyond(targetBotId, MAX_VERSIONS);
  if (deletedVersions.length > 0) {
    const candidateFilenames = deletedVersions.map((v) => v.image_filename);
    const stillReferenced = [saved.image_filename, ...listAllVersionImageFilenames(targetBotId)];
    const orphaned = selectOrphanedFiles(candidateFilenames, stillReferenced);
    orphaned.forEach(deleteUploadedMedia);
  }

  recordAuditLog({
    adminId: req.admin.id,
    action: 'welcome.update',
    targetType: 'welcome_message',
    metadata: {
      bot: targetBotId,
      bodyFormat: source.bodyFormat,
      buttonCount: source.buttons.length,
      hasImage: Boolean(imageFilename),
      mediaType,
      copiedFrom: sourceBotId
    }
  });

  res.json({ welcome: toApiShape(saved) });
}
