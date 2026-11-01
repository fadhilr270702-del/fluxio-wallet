/**
 * Protected Telegram broadcast endpoints — every handler here runs behind
 * requireAuth (see routes/adminTelegramBroadcastRoutes.js), so `req.admin`
 * is always populated. Channel-target sends happen synchronously inline
 * (one message); subscriber-target sends snapshot the active subscriber
 * list into the durable queue and return immediately — see
 * backend/src/telegram/worker.js for the throttled drain.
 *
 * Prompt 0138 (dual-bot foundation) — endpoints with no existing row to
 * derive a bot from (status, list, create, upload-image, upload-video) now
 * take an explicit bot-context param, resolved via resolveBotId() (default
 * 'test', 400 on an invalid value). Endpoints that act on an EXISTING
 * broadcast by id (get, getMedia, cancel, deactivateRecurring, updateContent,
 * reschedule) deliberately do NOT take one — they derive `bot_id` straight
 * from the row they already loaded, per this prompt's own "derive from the
 * row wherever possible" principle, which sidesteps any client/server
 * bot-mismatch question entirely for those.
 *
 * Prompt 0141 (Stage C — server-side broadcast media): uploadImage/
 * uploadVideo now DO take a bot-context param, same resolveBotId()
 * contract as every other "no existing row" endpoint — the hardcoded-to-
 * 'test' era ended with this prompt (see broadcastMedia.js's own header for
 * the full design: bytes are saved server-side once, bot-agnostic, and a
 * given bot only ever uploads them to its own storage chat the first time
 * it actually needs to send them).
 */
import {
  createBroadcast,
  findBroadcastById,
  listBroadcasts,
  setStatus,
  markChannelSendResult,
  transitionFromScheduled,
  updateScheduledContent,
  updateScheduledTime,
  findActiveRecurringBroadcast,
  transitionFromRecurring,
  replaceActiveRecurringAndCreate,
  updateMediaFileId
} from '../db/repositories/telegramBroadcastsRepo.js';
import { findLastFinishedRound } from '../db/repositories/telegramRecurringRoundsRepo.js';
import { computeRecurringDue } from '../telegram/recurringSchedule.js';
import { listActiveSubscribers, countActiveSubscribers } from '../db/repositories/telegramSubscribersRepo.js';
import { bulkInsertPending, listFailedForBroadcast } from '../db/repositories/telegramRecipientsRepo.js';
import { recordAuditLog } from '../db/repositories/auditLogsRepo.js';
import { getTelegramClient, buildInlineKeyboard, TelegramApiError } from '../telegram/client.js';
import { buildBroadcastMessage, resolveBroadcastMedia, stripToPlainText, degradeForChannel } from '../telegram/formatting.js';
import { resolveBotId } from '../telegram/resolveBotId.js';
import {
  isValidServerMediaFilename,
  saveServerMedia,
  ensureBroadcastMediaFileId,
  needsMediaResolution,
  BroadcastMediaError
} from '../telegram/broadcastMedia.js';
import { UPLOADS_DIR } from '../telegram/welcome.js';
import { HttpError } from '../utils/httpError.js';
import { Readable } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function toApiShape(row) {
  return {
    id: row.id,
    bot: row.bot_id,
    title: row.title,
    titleFormat: row.title_format,
    body: row.body,
    mediaUrl: row.media_url,
    mediaFileId: row.media_file_id,
    // Prompt 0141 — the bot-agnostic server file this broadcast's media was
    // actually uploaded from, if any (null for every legacy pre-0141 row,
    // and for a row with no media at all). This is what "Salin ke form"
    // now carries forward cross-bot instead of the bot-scoped file_id — see
    // composeRecentCards.js's own broadcastToComposeFields().
    mediaServerFilename: row.media_server_filename,
    mediaType: row.media_type,
    bodyFormat: row.body_format,
    targetType: row.target_type,
    targetChannelId: row.target_channel_id,
    status: row.status,
    scheduledAt: row.scheduled_at,
    totalCount: row.total_count,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    buttons: JSON.parse(row.buttons || '[]'),
    errorMessage: row.error_message,
    // Prompt 0134 — isRecurring is a PERMANENT marker (see the migration's
    // own comment): stays true even after deactivation, so the frontend can
    // still render "this was an auto-broadcast" once status has moved on to
    // 'completed'. recurringLastSentAt is null until the first successful
    // round.
    isRecurring: Boolean(row.is_recurring),
    recurringLastSentAt: row.recurring_last_sent_at,
    // Prompt 0164 — per-broadcast recurring cadence (was a fixed global
    // env value). recurringStartsAt is null until either explicitly chosen
    // at activation ("Mulai pada jam tertentu") or backfilled with the
    // real first-round send time (see recordRecurringSend's own comment).
    recurringIntervalHours: row.recurring_interval_hours,
    recurringStartsAt: row.recurring_starts_at,
    // Prompt 0166 — the MOST RECENT successful round's own delivered/failed
    // counts (both null until a round has actually completed since this
    // column existed — see the migration's own comment). Deliberately not
    // the same thing as the top-level failedCount above, which recurring
    // never writes at all (see recordRecurringSend's own comment).
    recurringLastRoundSentCount: row.recurring_last_round_sent_count,
    recurringLastRoundFailedCount: row.recurring_last_round_failed_count,
    // Prompt 0234 (P4) — the schedule made VISIBLE: the next due slot for a
    // still-active recurring broadcast (the same anchor arithmetic the
    // worker itself runs), and the most recent FINISHED round's own
    // start/finish/counts from telegram_recurring_rounds so History can
    // show a real duration. All null for non-recurring rows.
    recurringNextRoundAt: recurringNextRoundAt(row),
    recurringLastRound: recurringLastRoundShape(row),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Next due slot ISO for an ACTIVE recurring broadcast, else null (P4). */
function recurringNextRoundAt(row) {
  if (row.status !== 'recurring') return null;
  const intervalMs = (row.recurring_interval_hours || 1) * 60 * 60 * 1000;
  const { due, anchorForThisRound } = computeRecurringDue(row.recurring_last_sent_at, row.recurring_starts_at, intervalMs);
  // When already due, the "next round" is effectively now — report the slot
  // being served (or now for a no-anchor legacy row) rather than null.
  if (due) return anchorForThisRound ?? new Date().toISOString();
  return anchorForThisRound;
}

/** Most recent finished round's shape for History (P4), or null. */
function recurringLastRoundShape(row) {
  if (!row.is_recurring) return null;
  const round = findLastFinishedRound(row.id);
  if (!round) return null;
  return {
    roundNo: round.round_no,
    startedAt: round.started_at,
    finishedAt: round.finished_at,
    sentCount: round.sent_count,
    failedCount: round.failed_count
  };
}

function toFailedRecipientShape(row) {
  return { id: row.id, chatId: row.chat_id, errorMessage: row.error_message, createdAt: row.created_at };
}

function requireExisting(id) {
  const row = findBroadcastById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Broadcast not found.');
  return row;
}

/**
 * Prompt 0141 — a broadcast's mediaServerFilename is a value the client
 * genuinely echoes back (from an earlier upload response, or a copied
 * broadcast's own toApiShape() output), the same trust boundary
 * welcomeController.js's own update() already has to cross for
 * imageFilename. Same two-part guard: the filename must match the exact
 * shape this server itself could have produced (never resolve a raw
 * client string into a filesystem path without that check first), AND the
 * file it names must still actually exist on disk — a stale reference
 * (the file was somehow removed) fails loudly here rather than silently
 * creating a broadcast whose media resolves to nothing at send time.
 */
function validateMediaServerFilename(mediaServerFilename) {
  if (mediaServerFilename === null || mediaServerFilename === undefined) return;
  if (!isValidServerMediaFilename(mediaServerFilename)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'mediaServerFilename must be a filename produced by the upload endpoint.');
  }
  if (!existsSync(path.join(UPLOADS_DIR, mediaServerFilename))) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'That media file was not found — upload it again before saving.');
  }
}

/**
 * Bot connectivity + live active-subscriber count — powers the composer UI.
 * Also reports the (at most one) currently-active recurring broadcast, if
 * any (prompt 0134) — reusing this existing status endpoint the Compose
 * page already fetches on mount, rather than adding a whole new one just
 * for this one extra field.
 */
export async function status(req, res) {
  const botId = resolveBotId(req.query.bot);
  const client = getTelegramClient(botId);
  const botConfigured = Boolean(client);
  let botConnected = false;
  let botUsername = null;

  if (client) {
    try {
      const me = await client.getMe();
      botConnected = true;
      botUsername = me.username;
    } catch {
      botConnected = false;
    }
  }

  const activeRecurring = findActiveRecurringBroadcast(botId);
  res.json({
    bot: botId,
    botConfigured,
    botConnected,
    botUsername,
    activeSubscriberCount: countActiveSubscribers(botId),
    activeRecurringBroadcast: activeRecurring
      ? { id: activeRecurring.id, title: activeRecurring.title, titleFormat: activeRecurring.title_format }
      : null
  });
}

export function list(req, res) {
  const botId = resolveBotId(req.query.bot);
  const { status: statusFilter, limit, offset } = req.query;
  const rows = listBroadcasts({
    botId,
    status: statusFilter,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined
  });
  res.json({ broadcasts: rows.map(toApiShape) });
}

export function get(req, res) {
  const row = requireExisting(req.params.id);
  const failedRecipients = row.target_type === 'subscribers' ? listFailedForBroadcast(row.id) : [];
  res.json({ broadcast: toApiShape(row), failedRecipients: failedRecipients.map(toFailedRecipientShape) });
}

// A broadcast's own recorded media_type maps to a fixed, deterministic
// Content-Type rather than trusting whatever header Telegram's file-download
// response happens to send back (which can be a generic
// application/octet-stream) — Telegram normalizes every photo sent via
// sendPhoto to JPEG server-side (re-encoded, EXIF-stripped) regardless of
// the original upload format, so 'image/jpeg' is accurate for every image
// this app could ever have sent, not a guess; sendVideo never re-encodes,
// and this app only ever accepts video/mp4 at upload time (see the video
// multer instance in adminTelegramBroadcastRoutes.js), so 'video/mp4' is
// equally exact.
const CONTENT_TYPE_BY_MEDIA_TYPE = { image: 'image/jpeg', video: 'video/mp4' };

// Telegram Bot API's own hard limit for downloading a file via getFile +
// the /file/bot<TOKEN>/<path> endpoint is 20 MB — a platform limit, not
// something this app configures (this is smaller than the 50 MB video
// *upload* cap elsewhere in this file, which uses a different, non-getFile
// upload path — a video near the upload cap simply can't be fetched back
// through this admin-preview endpoint, and never was going to be, no
// matter what this backend does).
const MAX_TELEGRAM_DOWNLOADABLE_BYTES = 20 * 1024 * 1024;

/**
 * Streams a broadcast's own Telegram-hosted media (image/video) back to an
 * authenticated admin — added in prompt 0132 Revision 2 so the "View
 * broadcast" modal can show the real image/video instead of just a badge.
 * requireAuth (mounted once for this whole router) is what makes this
 * safe to expose at all; nothing here trusts the client beyond that.
 *
 * Pipeline: look up the broadcast -> require a real mediaFileId OR a real
 * mediaServerFilename (legacy mediaUrl-only broadcasts 404 here, same as
 * one with no media at all — there's no Telegram file and no server file
 * behind a bare URL to fetch) -> getFile() to resolve a short-lived
 * file_path (and check its reported size against the 20 MB Bot-API download
 * cap up front, before attempting an oversized download that would only
 * fail) -> downloadFile() to fetch the actual bytes -> stream them straight
 * to this response with a fixed, media_type-derived Content-Type (see
 * CONTENT_TYPE_BY_MEDIA_TYPE above).
 *
 * Prompt 0141 — a broadcast can now have a real server file with NO
 * media_file_id yet (a still-`scheduled`/`recurring` row copied cross-bot
 * via "Salin ke form": the file_id for its own bot is only ever resolved
 * lazily, at actual send time — see broadcastMedia.js's own header). Rather
 * than 404 this admin preview for that entirely normal, temporary window,
 * this serves the server file straight off disk instead of going through
 * Telegram at all — same bytes, no file_id needed to look at them.
 *
 * KERAS (per prompt 0132 Revision 2's own explicit requirement): the bot
 * token and the Telegram file-download URL that embeds it must never reach
 * this endpoint's own response, a redirect Location header, or any log
 * line at info level or above — this is a full server-side proxy, not a
 * redirect to Telegram's own URL. `getFile`/`downloadFile` (telegram/
 * client.js) are themselves written so neither ever surfaces that URL in
 * a thrown error's message; every catch block below constructs its own
 * fixed, safe message rather than forwarding a caught error's raw text
 * (Node's fetch can occasionally embed request details in a nested `cause`
 * for network-level failures) into anything user- or log-visible.
 */
export async function getMedia(req, res) {
  const broadcast = requireExisting(req.params.id);
  if (!broadcast.media_file_id) {
    // Prompt 0141 — no file_id yet (nothing has actually sent this bot's
    // own copy of the media through Telegram), but the real bytes might
    // still be sitting on this server's own disk — serve those directly
    // rather than 404ing a broadcast that genuinely does have media.
    if (broadcast.media_server_filename) {
      const serverPath = path.join(UPLOADS_DIR, broadcast.media_server_filename);
      if (!existsSync(serverPath)) {
        throw new HttpError(404, 'NO_MEDIA', 'This broadcast\'s media file is no longer available on this server.');
      }
      res.setHeader('Content-Type', CONTENT_TYPE_BY_MEDIA_TYPE[broadcast.media_type] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(readFileSync(serverPath));
      return;
    }
    throw new HttpError(404, 'NO_MEDIA', 'This broadcast has no media file to fetch.');
  }
  // Resolved from the broadcast's OWN bot_id, never a client-supplied
  // param — a media_file_id is only ever meaningful against the bot that
  // originally issued it (see prompt 0135's own investigation).
  const client = getTelegramClient(broadcast.bot_id);

  let file;
  try {
    file = await client.getFile(broadcast.media_file_id);
  } catch {
    // Deliberately not forwarding the caught error's own message here —
    // unlike the upload endpoints above (whose TelegramApiError messages
    // are safe, Telegram-authored descriptions with no secret in them),
    // getFile's failure mode most commonly means an expired/unknown
    // file_id, and there's no need to relay Telegram's exact wording to
    // the client either way.
    throw new HttpError(502, 'TELEGRAM_GET_FILE_FAILED', 'Could not resolve this file from Telegram — it may have expired.');
  }

  if (file.file_size && file.file_size > MAX_TELEGRAM_DOWNLOADABLE_BYTES) {
    throw new HttpError(
      413,
      'FILE_TOO_LARGE',
      'This file is larger than the Telegram Bot API\'s 20 MB download limit and cannot be previewed here.'
    );
  }

  let downloadRes;
  try {
    downloadRes = await client.downloadFile(file.file_path);
  } catch {
    throw new HttpError(502, 'TELEGRAM_DOWNLOAD_FAILED', 'Could not download this file from Telegram.');
  }

  res.setHeader('Content-Type', CONTENT_TYPE_BY_MEDIA_TYPE[broadcast.media_type] || 'application/octet-stream');
  // Private (this admin's own session cookie already gates the request) —
  // caching the bytes themselves (never the token-bearing source URL,
  // which never leaves this server) just avoids re-fetching on every
  // modal reopen within one browsing session.
  res.setHeader('Cache-Control', 'private, max-age=3600');

  const nodeStream = Readable.fromWeb(downloadRes.body);
  nodeStream.on('error', () => {
    // Streaming failures can happen after headers/some bytes are already
    // sent, when a clean HttpError response is no longer possible — logged
    // with a fixed, generic message only (no interpolation of the
    // underlying error), then the connection is simply torn down.
    console.error('[telegram media] stream interrupted while proxying a broadcast media file.');
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  nodeStream.pipe(res);
}

export async function create(req, res) {
  const botId = resolveBotId(req.body.bot);
  const client = getTelegramClient(botId);
  if (!client) {
    throw new HttpError(409, 'TELEGRAM_NOT_CONFIGURED', `No Telegram bot token is configured for bot '${botId}'.`);
  }

  const { title, titleFormat, body, mediaUrl, mediaFileId, mediaServerFilename, mediaType, targetType, targetChannelId, scheduledAt, buttons, bodyFormat, recurring, recurringIntervalHours, recurringStartsAt, replaceActiveRecurring } = req.body;
  validateMediaServerFilename(mediaServerFilename);

  // Prompt 0134's own two-way guard: at most one recurring broadcast may be
  // active at a time — narrowed in prompt 0138 to PER BOT (see
  // telegramBroadcastsRepo.js's own comment), enforced here rather than
  // trusted from the client. Two distinct error codes for two distinct
  // situations, per that prompt's own explicit design — activating a
  // SECOND recurring broadcast for the SAME bot is a different failure
  // than trying to send/schedule an ORDINARY broadcast on that bot while
  // one is already running, and the frontend shows different copy for
  // each.
  const activeRecurring = findActiveRecurringBroadcast(botId);
  if (activeRecurring) {
    // Prompt 0149 — interpolated into a plain-text error message, so this
    // must be the rendered plain-text title, never raw HTML markup (an
    // 'html'-format title would otherwise show its own <b>/<a> tags
    // literally in this error banner).
    const activeRecurringTitle = stripToPlainText(activeRecurring.title, activeRecurring.title_format);
    // Prompt 0234 (P1) — an explicit replace request falls through to the
    // recurring branch below, which deactivates the old one and creates
    // this one in a single transaction. Anything else keeps the exact
    // pre-0234 409s.
    if (!(recurring && replaceActiveRecurring)) {
      if (recurring) {
        throw new HttpError(
          409,
          'RECURRING_ALREADY_ACTIVE',
          `Only one recurring broadcast can be active at a time — "${activeRecurringTitle}" is already running.`
        );
      }
      throw new HttpError(
        409,
        'BLOCKED_BY_ACTIVE_RECURRING',
        `A recurring broadcast ("${activeRecurringTitle}") is currently active — deactivate it before sending another broadcast.`
      );
    }
  }

  if (recurring) {
    // Prompt 0134 Revision 1 — this used to ALSO send the first round
    // synchronously, right here, on top of creating the row. That was a
    // real bug, caught via the user's own manual testing and reproduced
    // with real Telegram message_ids in this prompt's own archive: the
    // synchronous send is an awaited network call (hundreds of ms, longer
    // for a photo/video), and the row is already visible as
    // `status='recurring'` with `recurring_last_sent_at` still NULL the
    // entire time it's in flight. The worker's own tick runs independently
    // on its own 1-second timer (see worker.js's startBroadcastWorker) —
    // if a tick landed during that window, processDueRecurring() read the
    // same NULL timestamp, concluded the broadcast was "already due" (a
    // NULL timestamp is deliberately treated as due, for restart-catch-up
    // — see that function's own comment), and fired a SECOND real send
    // via the exact same sendRecurringRound(), racing the first. Two
    // messages went out for one activation click.
    //
    // Fixed at the root by removing the synchronous send here entirely,
    // rather than trying to close the race window some other way (e.g.
    // stamping recurring_last_sent_at eagerly at insert time was
    // considered and rejected — it would need extra logic to distinguish
    // "eagerly stamped, send still pending" from "a round genuinely
    // failed and should be retried immediately", an asymmetry this
    // simpler fix avoids entirely). Now there is exactly ONE code path
    // that ever calls sendRecurringRound for ANY round of a recurring
    // broadcast, including the first: processDueRecurring()'s own tick.
    // A NULL recurring_last_sent_at is "due right now", so the very next
    // tick (at most workerTickMs — 1 second by default — after this
    // request returns) sends it, no special-casing needed, and no second
    // caller exists to race against. This also already matches the
    // frontend's own success copy below ComposePage.jsx's handleSubmit,
    // "first send is on its way" — never claimed to be "already sent" —
    // and RecentBroadcastCards' recurringProgressLabel() already renders
    // "Sent 0× — first send in progress" for exactly this brief window.
    const createArgs = {
      botId,
      title,
      titleFormat,
      body,
      mediaUrl,
      mediaFileId,
      mediaServerFilename,
      mediaType,
      targetType,
      targetChannelId: targetType === 'channel' ? targetChannelId : null,
      totalCount: 0, // unused for a recurring broadcast — sent_count means "rounds", not "recipients"
      createdBy: req.admin.id,
      buttons,
      bodyFormat,
      recurring: true,
      recurringIntervalHours,
      recurringStartsAt
    };
    // Prompt 0234 (P1) — replace path: old deactivated + new created in ONE
    // transaction (see replaceActiveRecurringAndCreate); the old one's
    // possibly in-flight round stops itself within the worker's own
    // status-recheck bound.
    const broadcast =
      activeRecurring && replaceActiveRecurring
        ? replaceActiveRecurringAndCreate(activeRecurring.id, createArgs)
        : createBroadcast(createArgs);
    recordAuditLog({
      adminId: req.admin.id,
      action: 'broadcast.telegram.recurring_activate',
      targetType: 'telegram_broadcast',
      targetId: broadcast.id,
      // Prompt 0149 — the audit log's own metadata must record the
      // reader-visible plain text, never a title's raw HTML markup (this
      // metadata column has no rendering path of its own — see this
      // prompt's own archive for why storing raw markup here would be a
      // real, if currently-unrendered, latent leak of unescaped HTML).
      // Prompt 0164 — recurringIntervalHours/recurringStartsAt added
      // alongside the existing fields (the chosen cadence, same "who/what/
      // when" audit-log spirit as everything else recorded here).
      metadata: {
        bot: botId,
        deliveryTarget: targetType,
        title: stripToPlainText(title, titleFormat),
        recurringIntervalHours,
        recurringStartsAt: recurringStartsAt ?? null,
        // Prompt 0234 (P1) — which broadcast this activation replaced, when
        // the admin chose the replace option (null for a plain activation).
        replacedBroadcastId: activeRecurring && replaceActiveRecurring ? activeRecurring.id : null
      }
    });
    return res.status(201).json({ broadcast: toApiShape(findBroadcastById(broadcast.id)) });
  }

  if (scheduledAt) {
    // Scheduled path: create the row and return immediately, no send
    // attempted here — backend/src/telegram/worker.js's
    // activateDueScheduled() picks it up once scheduled_at arrives (see
    // there for the activation-time subscriber snapshot + race-safety
    // reasoning shared with the cancel endpoint below). buttons/bodyFormat/
    // mediaFileId/mediaType are persisted now so the worker can rebuild
    // reply_markup/parse_mode/media later.
    const broadcast = createBroadcast({
      botId,
      title,
      titleFormat,
      body,
      mediaUrl,
      mediaFileId,
      mediaServerFilename,
      mediaType,
      targetType,
      targetChannelId: targetType === 'channel' ? targetChannelId : null,
      // A channel-target recipient count is known upfront (always 1); a
      // subscribers-target count isn't knowable until the active list is
      // snapshotted at activation time, so it starts at 0 — the History/
      // Detail views treat a 0 total on a 'scheduled' row as "recipients
      // determined at send time" rather than a stale count.
      totalCount: targetType === 'channel' ? 1 : 0,
      createdBy: req.admin.id,
      scheduledAt,
      buttons,
      bodyFormat
    });
    recordAuditLog({
      adminId: req.admin.id,
      action: 'broadcast.telegram.schedule',
      targetType: 'telegram_broadcast',
      targetId: broadcast.id,
      metadata: { bot: botId, deliveryTarget: targetType, title: stripToPlainText(title, titleFormat), scheduledAt }
    });
    return res.status(201).json({ broadcast: toApiShape(broadcast) });
  }

  if (targetType === 'channel') {
    // createdBy is always stamped from the session, never trusted from the request body.
    const broadcast = createBroadcast({
      botId,
      title,
      titleFormat,
      body,
      mediaUrl,
      mediaFileId,
      mediaServerFilename,
      mediaType,
      targetType,
      targetChannelId,
      totalCount: 1,
      createdBy: req.admin.id,
      buttons,
      bodyFormat
    });
    recordAuditLog({
      adminId: req.admin.id,
      action: 'broadcast.telegram.send',
      targetType: 'telegram_broadcast',
      targetId: broadcast.id,
      metadata: { bot: botId, deliveryTarget: targetType, title: stripToPlainText(title, titleFormat) }
    });
    // Prompt 0141 — an immediate channel send is synchronous, so any
    // still-unresolved file_id for THIS bot must be resolved right here,
    // before the actual send call below, not lazily by a later worker
    // tick (there is no later tick for this path). A no-op if the row
    // already has its own media_file_id (the common case: this endpoint's
    // own uploadImage/uploadVideo already resolves it eagerly for whichever
    // bot is doing the uploading — see those handlers below) — this only
    // ever does real work for a broadcast whose media came from a
    // cross-bot "Salin ke form" copy that has never been sent via THIS bot
    // before.
    if (needsMediaResolution(broadcast)) {
      try {
        const fileId = await ensureBroadcastMediaFileId(botId, broadcast.media_server_filename, broadcast.media_type);
        updateMediaFileId(broadcast.id, fileId);
        broadcast.media_file_id = fileId;
      } catch (err) {
        const message = err instanceof BroadcastMediaError ? err.message : 'Could not prepare this broadcast\'s media for sending.';
        const updated = markChannelSendResult(broadcast.id, { success: false, errorMessage: message });
        return res.status(201).json({ broadcast: toApiShape(updated) });
      }
    }
    const built = buildBroadcastMessage(broadcast);
    const { parseMode } = built;
    // Prompt 0153 — a channel target never gets premium-emoji content, per
    // Telegram's own Bot API 9.4 changelog (custom emoji is scoped to
    // private/group/supergroup chats only) — degraded explicitly here
    // rather than relying on however Telegram might silently handle it,
    // since prompt 0151's spike never actually tested a channel. See
    // formatting.js's own degradeForChannel() header for the full reasoning.
    const { text, replyMarkup } = degradeForChannel({ text: built.text, replyMarkup: buildInlineKeyboard(buttons) });
    const media = resolveBroadcastMedia(broadcast);
    try {
      let result;
      if (media.type === 'video') {
        result = await client.sendVideo(targetChannelId, media.source, text, replyMarkup, parseMode);
      } else if (media.type === 'image') {
        result = await client.sendPhoto(targetChannelId, media.source, text, replyMarkup, parseMode);
      } else {
        result = await client.sendMessage(targetChannelId, text, replyMarkup, parseMode);
      }
      // Prompt 0140 — closes the "a completed send is silent" gap for the
      // one send path that used to have zero success-path logging at all.
      console.log(`[telegram] broadcast sent: bot=${botId} chat=${targetChannelId} message_id=${result.message_id} path=immediate-channel broadcast=${broadcast.id}`);
      const updated = markChannelSendResult(broadcast.id, { success: true });
      return res.status(201).json({ broadcast: toApiShape(updated) });
    } catch (err) {
      const updated = markChannelSendResult(broadcast.id, { success: false, errorMessage: err.message });
      return res.status(201).json({ broadcast: toApiShape(updated) });
    }
  }

  // targetType === 'subscribers': snapshot who's active right now into the queue.
  const subscribers = listActiveSubscribers(botId);
  const broadcast = createBroadcast({
    botId,
    title,
    titleFormat,
    body,
    mediaUrl,
    mediaFileId,
    mediaServerFilename,
    mediaType,
    targetType,
    targetChannelId: null,
    totalCount: subscribers.length,
    createdBy: req.admin.id,
    buttons,
    bodyFormat
  });
  recordAuditLog({
    adminId: req.admin.id,
    action: 'broadcast.telegram.send',
    targetType: 'telegram_broadcast',
    targetId: broadcast.id,
    metadata: { bot: botId, deliveryTarget: targetType, title: stripToPlainText(title, titleFormat) }
  });

  if (subscribers.length === 0) {
    // Nothing to send — resolve immediately rather than sit as "queued" forever.
    const updated = setStatus(broadcast.id, 'completed');
    return res.status(201).json({ broadcast: toApiShape(updated) });
  }

  bulkInsertPending(broadcast.id, subscribers);
  res.status(201).json({ broadcast: toApiShape(broadcast) });
}

/**
 * Cancel a still-`scheduled` broadcast. Never trusts client-sent
 * assumptions about status — transitionFromScheduled re-checks the row's
 * *current* status atomically at the moment this runs, so a broadcast that
 * has already been claimed by the worker (or canceled by another request)
 * is rejected with the real current status, not silently overridden.
 */
export function cancel(req, res) {
  const existing = requireExisting(req.params.id);
  const didCancel = transitionFromScheduled(existing.id, 'canceled');
  if (!didCancel) {
    const current = findBroadcastById(existing.id);
    throw new HttpError(
      409,
      'CANNOT_CANCEL',
      `Cannot cancel — broadcast is already '${current.status}', not 'scheduled'.`
    );
  }
  recordAuditLog({
    adminId: req.admin.id,
    action: 'broadcast.telegram.cancel',
    targetType: 'telegram_broadcast',
    targetId: existing.id,
    metadata: { bot: existing.bot_id, title: stripToPlainText(existing.title, existing.title_format) }
  });
  res.json({ broadcast: toApiShape(findBroadcastById(existing.id)) });
}

/**
 * Deactivates a still-`recurring` broadcast — moves it to 'completed' so it
 * settles into History with a final sent_count/recurring_last_sent_at
 * rather than disappearing or staying in a permanent "active" state.
 * is_recurring itself is NEVER reset (see the migration's own comment) —
 * this only flips status, so the row still reads as "an auto-broadcast,
 * now deactivated" afterward, not indistinguishable from an ordinary send.
 * Same race-safety shape as cancel() above: transitionFromRecurring
 * re-checks the row's *current* status atomically, so a worker tick that's
 * mid-round at the exact same instant can't be silently undone — whichever
 * side's UPDATE actually matches the row first wins.
 */
export function deactivateRecurring(req, res) {
  const existing = requireExisting(req.params.id);
  const didDeactivate = transitionFromRecurring(existing.id, 'completed');
  if (!didDeactivate) {
    const current = findBroadcastById(existing.id);
    throw new HttpError(
      409,
      'CANNOT_DEACTIVATE',
      `Cannot deactivate — broadcast is already '${current.status}', not 'recurring'.`
    );
  }
  recordAuditLog({
    adminId: req.admin.id,
    action: 'broadcast.telegram.recurring_deactivate',
    targetType: 'telegram_broadcast',
    targetId: existing.id,
    metadata: { bot: existing.bot_id, title: stripToPlainText(existing.title, existing.title_format), sentCount: existing.sent_count }
  });
  res.json({ broadcast: toApiShape(findBroadcastById(existing.id)) });
}

/**
 * Edits a still-`scheduled` OR still-`recurring` broadcast's message
 * content (title/body/media/buttons — never target or schedule). The
 * `recurring` case is a deliberate exception per prompt 0134's own design:
 * editing an active recurring broadcast's content is intentionally allowed
 * (its next hourly round picks up the new content) — this is the SAME
 * behavior 'scheduled' already had, just extended rather than blocked, not
 * a new carve-out invented for this feature. Same race-safety shape as
 * cancel(): updateScheduledContent's `WHERE status IN ('scheduled',
 * 'recurring')` re-checks the row's *current* status atomically at the
 * moment this runs, so a broadcast the worker has already started sending
 * (or already deactivated) can never be silently rewritten.
 */
export function updateContent(req, res) {
  const existing = requireExisting(req.params.id);
  const { title, titleFormat, body, mediaUrl, mediaFileId, mediaServerFilename, mediaType, buttons, bodyFormat } = req.body;
  validateMediaServerFilename(mediaServerFilename);
  const didUpdate = updateScheduledContent(existing.id, { title, titleFormat, body, mediaUrl, mediaFileId, mediaServerFilename, mediaType, buttons, bodyFormat });
  if (!didUpdate) {
    const current = findBroadcastById(existing.id);
    throw new HttpError(
      409,
      'CANNOT_EDIT',
      `Cannot edit — broadcast is already '${current.status}', not 'scheduled' or 'recurring'.`
    );
  }
  recordAuditLog({
    adminId: req.admin.id,
    action: 'broadcast.telegram.update',
    targetType: 'telegram_broadcast',
    targetId: existing.id,
    metadata: { bot: existing.bot_id, title: stripToPlainText(title, titleFormat) }
  });
  res.json({ broadcast: toApiShape(findBroadcastById(existing.id)) });
}

/**
 * Changes only a still-`scheduled` broadcast's scheduled_at — message
 * content is left untouched. Same atomic race guard as updateContent/cancel.
 */
export function reschedule(req, res) {
  const existing = requireExisting(req.params.id);
  const { scheduledAt } = req.body;
  const didUpdate = updateScheduledTime(existing.id, scheduledAt);
  if (!didUpdate) {
    const current = findBroadcastById(existing.id);
    throw new HttpError(
      409,
      'CANNOT_RESCHEDULE',
      `Cannot reschedule — broadcast is already '${current.status}', not 'scheduled'.`
    );
  }
  recordAuditLog({
    adminId: req.admin.id,
    action: 'broadcast.telegram.reschedule',
    targetType: 'telegram_broadcast',
    targetId: existing.id,
    metadata: { bot: existing.bot_id, scheduledAt }
  });
  res.json({ broadcast: toApiShape(findBroadcastById(existing.id)) });
}

/**
 * Turns a BroadcastMediaError's stable `.code` into this endpoint's own
 * long-standing HTTP error shape — both uploadImage and uploadVideo used
 * to hand-check "is there a client" / "is there a storage chat" inline
 * before this prompt; that logic now lives once, in
 * ensureBroadcastMediaFileId() (broadcastMedia.js), and this is just the
 * HTTP-specific translation of what it can throw.
 */
function throwAsHttpError(err) {
  if (err instanceof BroadcastMediaError) {
    throw new HttpError(409, err.code, err.message);
  }
  if (err instanceof TelegramApiError) {
    throw new HttpError(502, 'TELEGRAM_UPLOAD_FAILED', `Telegram rejected the file: ${err.message}`);
  }
  throw err;
}

/**
 * Saves an admin-selected image to this server's own disk FIRST (see
 * broadcastMedia.js's own header for why: the bytes need to outlive this
 * one request so a LATER "Salin ke form" into the other bot can reuse
 * them), then uploads it once to the resolved bot's storage chat to get
 * back a reusable file_id — same two-step "save, then upload for a
 * file_id" order the base prompt's own design calls for. Takes the largest
 * PhotoSize (Telegram returns the array smallest-to-largest) as the id to
 * reuse for every actual send later.
 *
 * Prompt 0141 (Stage C): `bot` is now a real resolveBotId() param, not
 * hardcoded to 'test' — see this file's own header comment. Which bot to
 * upload to is the CURRENT compose context in create mode, or the
 * broadcast's OWN bot in edit mode (see ComposePage.jsx's own
 * `effectiveMediaBotId` for the client-side half of that rule) — this
 * endpoint itself doesn't need to know which case it is, it just uploads
 * to whatever bot it's told.
 */
export async function uploadImage(req, res) {
  const botId = resolveBotId(req.query.bot);
  if (!req.file) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'No image file was uploaded.');
  }
  const mediaServerFilename = saveServerMedia(req.file.buffer, req.file.mimetype);
  try {
    const fileId = await ensureBroadcastMediaFileId(botId, mediaServerFilename, 'image');
    res.json({ fileId, mediaServerFilename });
  } catch (err) {
    throwAsHttpError(err);
  }
}

/** Same shape as uploadImage, for MP4 video (video-upload slice) — see that function's own comment. */
export async function uploadVideo(req, res) {
  const botId = resolveBotId(req.query.bot);
  if (!req.file) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'No video file was uploaded.');
  }
  const mediaServerFilename = saveServerMedia(req.file.buffer, req.file.mimetype);
  try {
    const fileId = await ensureBroadcastMediaFileId(botId, mediaServerFilename, 'video');
    res.json({ fileId, mediaServerFilename });
  } catch (err) {
    throwAsHttpError(err);
  }
}
