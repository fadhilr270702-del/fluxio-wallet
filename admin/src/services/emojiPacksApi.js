import { apiFetch, apiFetchBlob } from './apiClient.js';

/**
 * Premium-emoji library API (prompt 0152) — same `bot` query/body param
 * convention every other bot-scoped admin endpoint already uses (see
 * welcomeApi.js/telegramBroadcastApi.js): omitted, the backend defaults to
 * 'test'. Mounted at a plain top-level `/admin/emoji-packs` (NOT nested
 * under `/admin/broadcast/telegram`) — see backend/src/app.js's own
 * comment for the routing collision that would otherwise cause.
 */
function botQuery(bot) {
  return bot ? `?bot=${encodeURIComponent(bot)}` : '';
}

/** `input` is whatever the admin pasted — a full t.me/addemoji/NAME link or a bare name; the backend does the actual parsing/validation (see emojiPackName.js) and reports a clear error if it doesn't resolve to one. */
export function registerEmojiPack({ bot, input }) {
  return apiFetch('/admin/emoji-packs', { method: 'POST', body: { bot, input } });
}

export function listEmojiPacks({ bot } = {}) {
  return apiFetch(`/admin/emoji-packs${botQuery(bot)}`);
}

export function listEmojiPackEmojis(packId, { bot } = {}) {
  return apiFetch(`/admin/emoji-packs/${packId}/emojis${botQuery(bot)}`);
}

export function refreshEmojiPack(packId, { bot } = {}) {
  return apiFetch(`/admin/emoji-packs/${packId}/refresh`, { method: 'POST', body: { bot } });
}

export function removeEmojiPack(packId, { bot } = {}) {
  return apiFetch(`/admin/emoji-packs/${packId}${botQuery(bot)}`, { method: 'DELETE' });
}

/**
 * The two asset-proxy reads, both through this app's own session cookie —
 * same authenticated-Blob pattern as fetchTelegramBroadcastMedia/
 * fetchWelcomeImage (never a bare `<img src>`/`<video src>` pointed
 * straight at the proxy URL, and never anything token-bearing reaching the
 * browser — see the backend proxy controller's own header for why).
 * `botId`/`customEmojiId` are always values this app already has from a
 * listEmojiPackEmojis() response, never user-typed.
 */
export function fetchEmojiThumb(botId, customEmojiId) {
  return apiFetchBlob(`/admin/emoji-assets/${encodeURIComponent(botId)}/${encodeURIComponent(customEmojiId)}/thumb`);
}

export function fetchEmojiFile(botId, customEmojiId) {
  return apiFetchBlob(`/admin/emoji-assets/${encodeURIComponent(botId)}/${encodeURIComponent(customEmojiId)}/file`);
}
