/**
 * Prompt 0153 — a tiny session cache in front of `GET /admin/emoji-packs/
 * lookup/:botId/:customEmojiId` (see backend/src/controllers/
 * telegramEmojiPacksController.js's own header for why that endpoint
 * exists). The premiumEmoji NodeView calls this for every node it renders;
 * without caching, scrolling a body full of the same few emoji repeated
 * many times would refetch the identical lookup over and over. Keyed by
 * `${botId}:${customEmojiId}` — a bot switch is automatically a cache-miss
 * for every id under the new bot, with no explicit invalidation needed.
 *
 * Caches the PROMISE, not just the resolved value, so two NodeViews
 * mounting for the same id in the same tick share one in-flight request
 * instead of firing two identical ones.
 */
import { apiFetch } from '../../../services/apiClient.js';

const cache = new Map();

/** Resolves to `{fallbackEmoji, isAnimated, isVideo}`, or `null` if the emoji isn't (or no longer is) registered for this bot. Never rejects. */
export function lookupPremiumEmoji(botId, customEmojiId) {
  const key = `${botId}:${customEmojiId}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      apiFetch(`/admin/emoji-packs/lookup/${encodeURIComponent(botId)}/${encodeURIComponent(customEmojiId)}`)
        .then((data) => data.emoji)
        .catch(() => null)
    );
  }
  return cache.get(key);
}
