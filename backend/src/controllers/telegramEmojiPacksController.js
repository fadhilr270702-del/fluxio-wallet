/**
 * Prompt 0152 — CRUD for the premium-emoji library (register/list/refresh/
 * remove a pack + list its emoji). Every handler here runs behind
 * requireAuth (see routes/adminEmojiPacksRoutes.js) with no extra role gate
 * — same access level as every other broadcast-area setting (Compose,
 * History, Welcome), not superadmin-only.
 *
 * This is Round 1 of 2 (see this prompt's own header) — nothing here sends
 * a `<tg-emoji>` anywhere or touches the composer; it only builds the
 * library that Round 2 (prompt 0153) will read from.
 */
import {
  findPackByBotAndName,
  findPackById,
  listPacksForBot,
  listEmojisForPack,
  findEmojiByBotAndId,
  upsertPackWithEmojis,
  deletePack
} from '../db/repositories/telegramEmojiPacksRepo.js';
import { recordAuditLog } from '../db/repositories/auditLogsRepo.js';
import { getTelegramClient, TelegramApiError } from '../telegram/client.js';
import { resolveBotId } from '../telegram/resolveBotId.js';
import { isValidBotId } from '../telegram/botIds.js';
import { parseEmojiPackName } from '../telegram/emojiPackName.js';
import { HttpError } from '../utils/httpError.js';

/** Maps a raw getStickerSet() Sticker into this table's own emoji shape — one place, used by both register and refresh. */
function stickerToEmojiRow(sticker) {
  return {
    customEmojiId: sticker.custom_emoji_id,
    fallbackEmoji: sticker.emoji,
    isAnimated: Boolean(sticker.is_animated),
    isVideo: Boolean(sticker.is_video),
    fileId: sticker.file_id,
    fileUniqueId: sticker.file_unique_id,
    fileSize: sticker.file_size ?? null,
    thumbFileId: sticker.thumbnail?.file_id ?? null,
    thumbFileUniqueId: sticker.thumbnail?.file_unique_id ?? null,
    thumbWidth: sticker.thumbnail?.width ?? null,
    thumbHeight: sticker.thumbnail?.height ?? null
  };
}

/**
 * Fetches `setName` from Telegram via `botId`'s own client and validates
 * it's actually a custom-emoji pack — shared by register (a fresh name)
 * and refresh (an already-registered pack's own set_name). Telegram error
 * descriptions (pack missing, private, rate-limited) are safe, Telegram-
 * authored text with no secret in them — same "forward it, don't wrap it
 * in a generic 500" precedent this codebase already uses for e.g. upload
 * endpoints — so they're passed straight through rather than swallowed.
 */
async function fetchAndValidateStickerSet(botId, setName) {
  const client = getTelegramClient(botId);
  if (!client) {
    throw new HttpError(409, 'TELEGRAM_NOT_CONFIGURED', `No Telegram bot token is configured for bot '${botId}'.`);
  }
  let stickerSet;
  try {
    stickerSet = await client.getStickerSet(setName);
  } catch (err) {
    if (err instanceof TelegramApiError) {
      throw new HttpError(502, 'TELEGRAM_STICKER_SET_FAILED', err.message || `Telegram could not find a sticker set named '${setName}'.`);
    }
    throw err;
  }
  if (stickerSet.sticker_type !== 'custom_emoji') {
    throw new HttpError(
      400,
      'NOT_EMOJI_PACK',
      `'${setName}' is a ${stickerSet.sticker_type} sticker pack, not a custom-emoji pack — only custom-emoji packs can be registered here.`
    );
  }
  return stickerSet;
}

export async function register(req, res) {
  const botId = resolveBotId(req.body.bot);
  const setName = parseEmojiPackName(req.body.input);
  if (!setName) {
    throw new HttpError(
      400,
      'INVALID_PACK_NAME',
      'Enter a t.me/addemoji/NAME link or a plain pack name (letters, numbers, and underscores only).'
    );
  }

  const stickerSet = await fetchAndValidateStickerSet(botId, setName);
  const pack = upsertPackWithEmojis({
    botId,
    setName,
    title: stickerSet.title,
    stickerType: stickerSet.sticker_type,
    emojis: stickerSet.stickers.map(stickerToEmojiRow),
    registeredBy: req.admin.id
  });

  recordAuditLog({
    adminId: req.admin.id,
    action: 'broadcast.telegram.emoji_pack.register',
    targetType: 'telegram_emoji_pack',
    targetId: pack.id,
    metadata: { botId, setName, title: pack.title, emojiCount: pack.emoji_count }
  });

  res.status(201).json({ pack: serializePack(pack) });
}

export function list(req, res) {
  const botId = resolveBotId(req.query.bot);
  res.json({ packs: listPacksForBot(botId).map(serializePackWithCounts) });
}

export function listEmojis(req, res) {
  const botId = resolveBotId(req.query.bot);
  const pack = findPackById(req.params.id, botId);
  if (!pack) throw new HttpError(404, 'PACK_NOT_FOUND', 'No emoji pack with that id for this bot.');
  res.json({ pack: serializePack(pack), emojis: listEmojisForPack(pack.id).map(serializeEmoji) });
}

/**
 * Prompt 0153 — the ONE genuinely new endpoint this prompt adds to 0152's
 * surface (everything else reuses what already exists): given a bot and a
 * bare custom_emoji_id, resolves whether it's animated/video/fallback-
 * emoji, without needing to know which pack it came from. Needed because
 * the composer's premiumEmoji NodeView only ever has `{id, fallback}` on
 * the node itself (that's all `<tg-emoji>` round-trips through stored
 * HTML) — it has no pack context to look this up through
 * listEmojiPackEmojis() when rendering content loaded from "Edit isi"/
 * "Salin ke form"/Welcome, only the bare id. Reuses `findEmojiByBotAndId`
 * (already existed in the 0152 repo, used by the asset proxy) — no new
 * repository code, just a thin new read-only route on top of it. 404 when
 * unregistered/removed — the NodeView's own established fallback for that
 * case is to render the plain fallback character, never an error UI.
 *
 * `botId`/`customEmojiId` are both path params here (mirroring the asset
 * proxy's own `/:botId/:customEmojiId/...` shape, not the `?bot=` query
 * convention this file's other GETs use) — an unrecognized bot id 404s
 * the same generic way an unrecognized emoji id does, same reasoning as
 * the asset proxy: this is a lookup-by-id endpoint, not a form.
 */
export function lookupEmoji(req, res) {
  const { botId, customEmojiId } = req.params;
  if (!isValidBotId(botId)) throw new HttpError(404, 'EMOJI_NOT_FOUND', 'No such emoji in this bot\'s library.');
  const emoji = findEmojiByBotAndId(botId, customEmojiId);
  if (!emoji) throw new HttpError(404, 'EMOJI_NOT_FOUND', 'No such emoji in this bot\'s library.');
  res.json({ emoji: serializeEmoji(emoji) });
}

export async function refresh(req, res) {
  const botId = resolveBotId(req.body.bot);
  const existing = findPackById(req.params.id, botId);
  if (!existing) throw new HttpError(404, 'PACK_NOT_FOUND', 'No emoji pack with that id for this bot.');

  const stickerSet = await fetchAndValidateStickerSet(botId, existing.set_name);
  const pack = upsertPackWithEmojis({
    botId,
    setName: existing.set_name,
    title: stickerSet.title,
    stickerType: stickerSet.sticker_type,
    emojis: stickerSet.stickers.map(stickerToEmojiRow),
    registeredBy: existing.registered_by
  });

  recordAuditLog({
    adminId: req.admin.id,
    action: 'broadcast.telegram.emoji_pack.refresh',
    targetType: 'telegram_emoji_pack',
    targetId: pack.id,
    metadata: {
      botId,
      setName: pack.set_name,
      emojiCountBefore: existing.emoji_count,
      emojiCountAfter: pack.emoji_count
    }
  });

  res.json({ pack: serializePack(pack) });
}

export function remove(req, res) {
  const botId = resolveBotId(req.query.bot);
  const pack = findPackById(req.params.id, botId);
  if (!pack) throw new HttpError(404, 'PACK_NOT_FOUND', 'No emoji pack with that id for this bot.');

  deletePack(pack.id);

  // Captured BEFORE delete — there's nothing left to look up afterward,
  // and an audit log entry with no useful detail about what was removed
  // would defeat its own purpose.
  recordAuditLog({
    adminId: req.admin.id,
    action: 'broadcast.telegram.emoji_pack.remove',
    targetType: 'telegram_emoji_pack',
    targetId: pack.id,
    metadata: { botId, setName: pack.set_name, title: pack.title, emojiCount: pack.emoji_count }
  });

  res.status(204).end();
}

// Never exposes file_id/file_unique_id directly to the client — those stay
// server-side, resolved only through the asset proxy (see
// telegramEmojiAssetsController.js), matching this endpoint's own "no
// Telegram-hosted URL/identifier a client could use to bypass the proxy"
// posture, even though a bare file_id alone isn't the token-bearing URL
// itself (defense in depth, not a redundant restriction — the proxy is
// still the only path that ever needs these fields).
function serializePack(pack) {
  return {
    id: pack.id,
    botId: pack.bot_id,
    setName: pack.set_name,
    title: pack.title,
    stickerType: pack.sticker_type,
    emojiCount: pack.emoji_count,
    registeredBy: pack.registered_by,
    createdAt: pack.created_at,
    updatedAt: pack.updated_at
  };
}

function serializePackWithCounts(row) {
  return {
    ...serializePack(row),
    emojiCount: row.live_emoji_count,
    animatedCount: row.animated_count,
    videoCount: row.video_count
  };
}

// customEmojiId is the one Telegram identifier this DOES expose — the
// asset proxy's own URL shape (`/admin/emoji-assets/:botId/:customEmojiId/
// ...`) needs it, and it carries no token/secret of its own.
function serializeEmoji(emoji) {
  return {
    botId: emoji.bot_id,
    customEmojiId: emoji.custom_emoji_id,
    fallbackEmoji: emoji.fallback_emoji,
    isAnimated: Boolean(emoji.is_animated),
    isVideo: Boolean(emoji.is_video),
    fileSize: emoji.file_size,
    thumbWidth: emoji.thumb_width,
    thumbHeight: emoji.thumb_height,
    position: emoji.position
  };
}
