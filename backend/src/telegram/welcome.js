/**
 * The /start welcome reply. Originally (prompt 0135) a hardcoded text
 * constant + a static committed banner image. Prompt 0136 made it
 * admin-editable (rich body + an uploaded image + inline buttons) from a
 * "Welcome" tab, backed by the singleton `welcome_message` row. Prompt 0137
 * adds video support (image OR video, mirroring the broadcast composer)
 * and a permanent content-version history (`welcome_versions`) — which is
 * also why uploaded files are no longer written into one shared, always-
 * overwritten slot: 0136's `welcome-image.<ext>` design meant an old
 * version's own file reference silently rotted the moment a newer save
 * replaced it. Every upload now gets its own permanent-until-pruned
 * filename (see saveUploadedMedia()).
 *
 * Prompt 0138 (dual-bot foundation) — everything here is now scoped by
 * botId ('test' | 'official', see botIds.js): the effective config, the
 * legacy-default fallback, and the uploaded-media filename itself (which
 * now embeds which bot it belongs to — see saveUploadedMedia()'s own
 * comment for why). Telegram calls go through getTelegramClient(botId)
 * instead of the old plain top-level sendMessage/uploadPhoto/uploadVideo
 * functions, since each bot now has its own independent client.
 *
 * Multipart photo/video upload from local bytes still isn't new here (see
 * the 0135 investigation this file's own history carries): a client's
 * `uploadPhoto()`/`uploadVideo()` already POST fresh multipart bytes per
 * call, no file_id needed, and 0136 extended them further with
 * `replyMarkup`/`parseMode` so a welcome send can also carry inline buttons
 * and rich-HTML formatting in the same request.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTelegramClient, buildInlineKeyboard } from './client.js';
import { sanitizeTelegramHtml } from './formatting.js';
import { getWelcomeMessageRow } from '../db/repositories/welcomeMessageRepo.js';
import { DEFAULT_BOT_ID } from './botIds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '../..');

/**
 * backend/src/telegram/welcome.js -> backend/assets/welcome-banner.png —
 * the prompt 0135 default image, still committed to git. Never written to
 * by anything in this file (assets/ stays static/committed-only, see its
 * own README) — only ever *read* here, and only until an admin's own first
 * save creates a real `welcome_message` row. Prompt 0138: this legacy asset
 * only ever applies to the trial bot ('test') — see
 * getEffectiveWelcomeConfig()'s own comment for why a brand-new bot like
 * 'official' has no equivalent legacy default to fall back to.
 */
export const LEGACY_WELCOME_BANNER_PATH = path.resolve(backendRoot, 'assets/welcome-banner.png');

/**
 * backend/uploads/ — prompt 0136's own new directory for admin-uploaded
 * files that must persist on the server filesystem (unlike the broadcast
 * composer's image/video uploads, which only ever pass through Telegram's
 * own storage via a file_id and are never written to this server's disk —
 * see welcomeController.js's own header comment for why THIS feature can't
 * use that same file_id approach). Gitignored (mutable admin content, not
 * source) — created on demand, not assumed to exist. Shared by both bots —
 * cross-bot isolation is enforced by the filename itself embedding a bot id
 * (see saveUploadedMedia()), not by a separate directory per bot.
 */
export const UPLOADS_DIR = path.resolve(backendRoot, 'uploads');

// The one filename 0136 ever produced, kept as a permanent, explicit
// exception in isValidUploadedMediaFilename() below — see
// migrateLegacyBannerIfNeeded()'s own comment for why this can't just be
// folded into the new per-upload UUID pattern. Prompt 0138: this legacy
// filename predates bot-scoping entirely and is only ever valid for the
// trial bot (see isValidUploadedMediaFilename()).
const LEGACY_MIGRATED_FILENAME = 'welcome-image.png';

// Prompt 0137 — every real upload gets its own permanent filename, never a
// fixed shared slot. Prompt 0138 adds a bot id segment
// (`welcome-media-<bot>-<uuid>.<ext>`) so a filename alone is enough to
// know which bot it belongs to — this is what makes it structurally
// impossible for bot A's pruning pass to ever reference, let alone delete,
// a file that belongs to bot B, even before considering the DB's own
// bot-scoped queries (see welcomeVersionsRepo.js). mp4 sits alongside the
// three image types 0136 supported.
const UPLOAD_FILENAME_PATTERN =
  /^welcome-media-(test|official)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|mp4)$/;
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

/**
 * A filename is only ever trusted here if it matches the generated-upload
 * pattern above AND its embedded bot id matches the bot context this call
 * is being made in, OR it's the one specific legacy filename
 * migrateLegacyBannerIfNeeded() can produce (valid only for the trial bot —
 * see that function's own comment). This is what makes it safe for the
 * admin PUT payload to echo a filename value straight back (see
 * welcomeController.js's update()): even a maliciously-crafted request can
 * never reference a path outside backend/uploads/, AND — as of prompt
 * 0138 — can never reference a file that belongs to the OTHER bot, since
 * anything not matching one of these two exact shapes for THIS bot is
 * rejected outright, and this function never does its own path resolution
 * from client input.
 */
export function isValidUploadedMediaFilename(filename, botId) {
  if (typeof filename !== 'string') return false;
  if (filename === LEGACY_MIGRATED_FILENAME) return botId === DEFAULT_BOT_ID;
  const match = UPLOAD_FILENAME_PATTERN.exec(filename);
  if (!match) return false;
  return match[1] === botId;
}

/**
 * Derives image vs. video purely from a filename's own extension — this is
 * what makes image/video mutual exclusivity structural rather than a
 * separate validation rule: there is only ever one `image_filename` value,
 * and it maps to exactly one media type, never both. Pure, no I/O, and
 * bot-agnostic (extension alone is enough — no botId needed here).
 */
export function mediaTypeForFilename(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.mp4') return 'video';
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp') return 'image';
  return null;
}

/**
 * The MIME type saveUploadedMedia() needs to pick the right file extension
 * — derived from an EXISTING file's own extension, the mirror image of
 * saveUploadedMedia's own ext-from-mimeType lookup. Exported (prompt 0141)
 * for welcomeController.js's own "Salin ke bot lain" copy: re-saving an
 * already-resolved image/video path under a NEW bot-scoped filename needs
 * to know its MIME type without re-deriving EXTENSION_TO_MIME_TYPE's own
 * private table a second time elsewhere.
 */
export function mimeTypeForFilename(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return EXTENSION_TO_MIME_TYPE[ext] || null;
}

/**
 * Writes a newly-uploaded image OR video into its own permanent file —
 * `welcome-media-<botId>-<uuid>.<ext>`, never reusing or overwriting a
 * previous upload's filename (prompt 0137's own fix for 0136's single-slot
 * rot — see this file's own header comment) and always embedding which bot
 * this upload belongs to (prompt 0138 — see UPLOAD_FILENAME_PATTERN's own
 * comment). Returns the new filename, which is what a version snapshot or
 * the active config stores.
 */
export function saveUploadedMedia(buffer, mimeType, botId) {
  const ext = MIME_TYPE_TO_EXTENSION[mimeType];
  if (!ext) {
    throw new Error(`Unsupported media mime type for welcome upload: ${mimeType}`);
  }
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const filename = `welcome-media-${botId}-${randomUUID()}${ext}`;
  writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return filename;
}

/** Deletes one uploaded media file, if it still exists — used only by pruning (see welcomeController.js's update()), never on a plain save/replace. */
export function deleteUploadedMedia(filename) {
  if (!filename) return;
  const target = path.join(UPLOADS_DIR, filename);
  if (existsSync(target)) unlinkSync(target);
}

/**
 * Given the set of filenames a pruning pass is about to delete (because
 * their own version rows were just removed for being older than the
 * retention limit) and the set of filenames still referenced by anything
 * surviving (the active config, plus every version row still left after
 * that same deletion), returns exactly the candidates that are safe to
 * actually delete from disk — i.e. referenced by NEITHER survivor.
 *
 * Pure — no I/O, no DB access, and bot-agnostic by design (unchanged since
 * prompt 0137): the caller is entirely responsible for scoping BOTH lists
 * to one bot before calling this (see welcomeController.js's update(), and
 * welcomeVersionsRepo.js's bot-scoped pruneVersionsBeyond()/
 * listAllVersionImageFilenames() as of prompt 0138) — this function itself
 * has no notion of "bot" at all, it just compares two filename sets. As
 * long as both lists come from the SAME bot's own scoped queries, a
 * filename belonging to a different bot can never even appear as a
 * candidate here in the first place.
 */
export function selectOrphanedFiles(candidateFilenames, stillReferencedFilenames) {
  const referenced = new Set(stillReferencedFilenames.filter(Boolean));
  const uniqueCandidates = [...new Set(candidateFilenames.filter(Boolean))];
  return uniqueCandidates.filter((filename) => !referenced.has(filename));
}

/**
 * Copies the legacy 0135 default banner into the managed uploads/
 * directory, under its own fixed, permanently-recognized filename — called
 * once, the first time an admin opens the Welcome tab for the TRIAL bot
 * with no saved row yet (see welcomeController.js's get() — this is never
 * called for any other bot, since there's no equivalent legacy asset for
 * one). This means the rest of the system (the client's own "echo the
 * current filename back on save" contract, isValidUploadedMediaFilename's
 * check) never needs a special case for "it's actually the old hardcoded
 * asset, not a real upload" — by the time an admin's first PUT happens, the
 * image already looks like an ordinary managed file. Deliberately NOT given
 * a fresh UUID filename like a real upload would get: this only ever runs
 * before any `welcome_message` row exists for the trial bot, so there's no
 * version history yet to make idempotency trackable any other way — a
 * fixed, explicitly-allowlisted name (see isValidUploadedMediaFilename) is
 * what keeps this a one-time copy instead of a new orphaned duplicate every
 * time an admin opens the tab without saving. Idempotent: a no-op if the
 * target file already exists. Returns the new filename, or null if there's
 * no legacy banner to copy.
 */
export function migrateLegacyBannerIfNeeded() {
  if (!existsSync(LEGACY_WELCOME_BANNER_PATH)) return null;
  const target = path.join(UPLOADS_DIR, LEGACY_MIGRATED_FILENAME);
  if (!existsSync(target)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
    copyFileSync(LEGACY_WELCOME_BANNER_PATH, target);
  }
  return LEGACY_MIGRATED_FILENAME;
}

/**
 * The absolute last-resort fallback (prompt 0136's own explicit
 * requirement, reconfirmed unchanged by prompt 0137's own verification): if
 * the saved config is ever unreadable/corrupted for any reason, THIS is
 * what still goes out rather than nothing at all. Kept verbatim from
 * prompt 0135 rather than deleted — see getEffectiveWelcomeConfig()'s catch
 * block below, the only remaining place this constant is used. Bot-agnostic
 * by design — the same fallback text serves every bot equally, since it's
 * a last resort with no per-bot content to draw from anyway.
 */
export const WELCOME_MESSAGE_TEXT =
  // Prompt 0207 (owner text W1): aligned with the store listing's fee
  // sentence — no "forever"/"Free transfers" claim, no "-" inside
  // sentences, no "&" (owner's public-text rules). This is only the
  // REPO FALLBACK — the live Welcome is managed by the owner through
  // the admin panel and wins whenever one is configured.
  "Welcome to Fluxio Wallet!\n\n" +
  'Non custodial crypto wallet for Solana and EVM. Fluxio adds no fee on transfers. You only pay the network fee, nothing extra to us.\n\n' +
  "You're now subscribed to official announcements and updates.";

/**
 * Resolves what should actually be sent right now for a given bot — read
 * fresh on every call (never cached), so an admin's edit takes effect on
 * the very next /start with no server restart. Three tiers, in order:
 *
 *  1. A real saved `welcome_message` row for THIS bot — the normal case
 *     once any admin has ever saved through the Welcome tab in that bot's
 *     own context.
 *  2. No row yet: for the trial bot ONLY, the untouched 0135 default (the
 *     same constant text, plus the legacy banner image if it's still
 *     present on disk) — prompt 0138's own explicit design decision: a
 *     brand-new bot (e.g. 'official') has no equivalent legacy asset, so
 *     its own "no row yet" default is the bare constant text with no media
 *     at all, never the trial bot's old banner.
 *  3. The row exists but is somehow unreadable/malformed (e.g. corrupted
 *     buttons JSON) — caught here specifically so a broken config can
 *     never take the whole welcome reply down; degrades to the bare
 *     WELCOME_MESSAGE_TEXT constant, no media, no buttons.
 */
export function getEffectiveWelcomeConfig(botId) {
  try {
    const row = getWelcomeMessageRow(botId);
    if (row) {
      return {
        body: row.body,
        bodyFormat: row.body_format,
        imagePath: row.image_filename ? path.join(UPLOADS_DIR, row.image_filename) : null,
        mediaType: row.media_type,
        buttons: JSON.parse(row.buttons || '[]')
      };
    }
    if (botId === DEFAULT_BOT_ID) {
      const hasLegacyBanner = existsSync(LEGACY_WELCOME_BANNER_PATH);
      return {
        body: WELCOME_MESSAGE_TEXT,
        bodyFormat: 'plain',
        imagePath: hasLegacyBanner ? LEGACY_WELCOME_BANNER_PATH : null,
        mediaType: hasLegacyBanner ? 'image' : null,
        buttons: []
      };
    }
    return { body: WELCOME_MESSAGE_TEXT, bodyFormat: 'plain', imagePath: null, mediaType: null, buttons: [] };
  } catch (err) {
    console.error(`[telegram] welcome config unreadable for bot '${botId}', falling back to the built-in default text:`, err.message);
    return { body: WELCOME_MESSAGE_TEXT, bodyFormat: 'plain', imagePath: null, mediaType: null, buttons: [] };
  }
}

/**
 * Plain vs. Telegram-HTML text — the same branch buildBroadcastMessage()
 * (formatting.js) uses, minus the `title + '\n\n' + body` concatenation
 * (the welcome message has no separate title field — see this prompt's own
 * archive for why that's a deliberate, permanent decision, not a gap).
 * Pure — no I/O — so it's directly unit-testable.
 */
export function buildWelcomeMessage(cfg) {
  if (cfg.bodyFormat === 'html') {
    const { html } = sanitizeTelegramHtml(cfg.body);
    return { text: html, parseMode: 'HTML' };
  }
  return { text: cfg.body, parseMode: undefined };
}

/**
 * Decides whether THIS particular /start update should trigger a welcome
 * send, given the subscriber's own last-welcomed update_id (null/undefined
 * if never welcomed). Pure — unchanged from prompt 0135, see that prompt's
 * own archive for the full reasoning (strictly greater-than, keyed on
 * Telegram's own monotonic update_id, not a permanent per-chat flag).
 * Bot-agnostic on its own — the subscriber row passed in by the caller is
 * already resolved for one specific bot (see telegramSubscribersRepo.js's
 * bot-scoped upsertFromStart), so dedup is already per-(bot, chat) by
 * construction before this function is ever reached.
 */
export function shouldSendWelcome(lastWelcomedUpdateId, incomingUpdateId) {
  if (lastWelcomedUpdateId == null) return true;
  return incomingUpdateId > lastWelcomedUpdateId;
}

/**
 * Decides which send mode a resolved config should use — pure (the actual
 * `existsSync` check happens in the caller, which passes the boolean
 * result in, so this itself does no I/O and is directly unit-testable).
 * `true` means "send as media" (photo or video, per `mediaType`); `false`
 * means "send as plain text" — either because there's no media configured
 * at all, or because the file it points at has gone missing (prompt 0137's
 * own explicit "config points at media but the file is gone" requirement:
 * this degrades to text, never throws, never blocks the send).
 */
export function shouldSendAsMedia(imagePath, mediaType, fileExists) {
  return Boolean(imagePath && mediaType && fileExists);
}

/**
 * Sends the welcome for a given bot — reads that bot's own effective config
 * fresh, then a photo or video (+ caption + inline buttons) if it resolves
 * to an existing media file, else caption-only text (+ buttons). Never
 * catches its own errors — that's the poller's job (see poller.js's own
 * try/catch around this call), matching prompt 0135's original contract
 * exactly. Throws synchronously if this bot has no Telegram client
 * configured at all — should never actually happen in practice, since the
 * poller only ever calls this for a bot it already confirmed has a token
 * (see poller.js's own startTelegramPoller()), but guarded explicitly
 * rather than letting a null client fail with a confusing "not a function".
 *
 * Prompt 0140 — now RETURNS the Telegram API's own response (previously
 * discarded), so the caller can log the real `message_id` on success —
 * closing the "a completed send is silent" observability gap this
 * prompt's own incident archive identified (nothing anywhere logs a
 * successful send, only failures, which made a real production incident
 * impossible to reconstruct from logs afterward).
 */
export async function sendWelcomeMessage(chatId, botId) {
  const client = getTelegramClient(botId);
  if (!client) {
    throw new Error(`Telegram bot '${botId}' has no token configured — cannot send a welcome message.`);
  }

  const cfg = getEffectiveWelcomeConfig(botId);
  const { text, parseMode } = buildWelcomeMessage(cfg);
  const replyMarkup = buildInlineKeyboard(cfg.buttons);
  const fileExists = Boolean(cfg.imagePath) && existsSync(cfg.imagePath);

  if (shouldSendAsMedia(cfg.imagePath, cfg.mediaType, fileExists)) {
    const ext = path.extname(cfg.imagePath).toLowerCase();
    const mimeType = EXTENSION_TO_MIME_TYPE[ext] || 'application/octet-stream';
    const buffer = readFileSync(cfg.imagePath);
    const filename = path.basename(cfg.imagePath);
    if (cfg.mediaType === 'video') {
      return client.uploadVideo(chatId, buffer, filename, mimeType, { caption: text, replyMarkup, parseMode });
    }
    return client.uploadPhoto(chatId, buffer, filename, mimeType, { caption: text, replyMarkup, parseMode });
  }
  return client.sendMessage(chatId, text, replyMarkup, parseMode);
}
