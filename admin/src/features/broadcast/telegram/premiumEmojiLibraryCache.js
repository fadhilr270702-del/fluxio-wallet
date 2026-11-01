/**
 * Prompt 0153 — session cache backing the emoji picker's Premium tab, so
 * reopening the picker doesn't refetch every pack + every pack's emoji
 * list each time (the base prompt's own explicit performance requirement).
 * Keyed by botId — a bot switch is automatically a cache miss for the new
 * bot's own key, with no explicit "invalidate on switch" step needed,
 * while switching back to a previously-loaded bot stays instant.
 *
 * Caches the in-flight PROMISE (not just the resolved value) so opening
 * the picker twice in quick succession for the same bot shares one fetch
 * rather than firing two.
 *
 * Does NOT stay fresh across a register/refresh/remove made on the
 * Premium Emoji tab in the same session without a reload — a known,
 * accepted trade-off for the "don't refetch on every open" requirement
 * this cache exists to satisfy; that tab and the composer are different
 * pages, and a same-session edit-then-immediately-compose sequence is not
 * a scenario the base prompt asked this cache to stay live for.
 */
import { listEmojiPacks, listEmojiPackEmojis } from '../../../services/emojiPacksApi.js';

const cache = new Map();

async function fetchLibrary(botId) {
  const { packs } = await listEmojiPacks({ bot: botId });
  const withEmojis = await Promise.all(
    packs.map((pack) =>
      listEmojiPackEmojis(pack.id, { bot: botId }).then((data) => ({ ...pack, emojis: data.emojis }))
    )
  );
  return withEmojis;
}

/** Resolves to an array of packs, each with its own `emojis` array already attached. Never rejects — an error resolves to `[]` so the picker can show its own empty state rather than an error UI. */
export function loadPremiumEmojiLibrary(botId) {
  if (!cache.has(botId)) {
    cache.set(botId, fetchLibrary(botId).catch(() => []));
  }
  return cache.get(botId);
}
