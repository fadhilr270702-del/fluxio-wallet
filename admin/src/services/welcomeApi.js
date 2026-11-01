import { apiFetch, apiFetchBlob } from './apiClient.js';

function botQuery(bot) {
  return bot ? `?bot=${encodeURIComponent(bot)}` : '';
}

/**
 * The current effective /start welcome config — see
 * backend/src/controllers/welcomeController.js's get(). `bot` (prompt
 * 0139, 'test' | 'official') is optional — omitted, the backend defaults
 * to 'test' (see backend/src/telegram/resolveBotId.js), exactly matching
 * every pre-0139 call site's behavior unchanged.
 */
export function getWelcomeMessage({ bot } = {}) {
  return apiFetch(`/admin/welcome${botQuery(bot)}`);
}

/** Saves the whole config in one shot — body/bodyFormat/imageFilename/buttons/bot — and appends a new content-version snapshot (prompt 0137). `fields.bot` (prompt 0139) selects which bot's config this saves; omitted, defaults to 'test' server-side. */
export function updateWelcomeMessage(fields) {
  return apiFetch('/admin/welcome', { method: 'PUT', body: fields });
}

/**
 * Uploads a new welcome image, giving it its own permanent filename (prompt
 * 0137 — no more single shared slot, see welcome.js's saveUploadedMedia())
 * and returns it. Include that filename in the next updateWelcomeMessage()
 * call to actually apply it (same two-step upload-then-reference pattern as
 * uploadTelegramBroadcastImage). `file` is a browser File object; `bot`
 * (prompt 0139) is what the resulting filename embeds (see welcome.js's
 * own saveUploadedMedia()) — unlike the broadcast composer's file_id-based
 * upload, welcome media upload is real server-side storage and genuinely
 * works for either bot, so this DOES thread a bot param through, unlike
 * uploadTelegramBroadcastImage/Video. The response key is `imageFilename`
 * even here — the wire/DB field kept its name from prompt 0136 rather than
 * being renamed once video support was added, see welcome.js's own header
 * comment.
 */
export function uploadWelcomeImage(file, { bot } = {}) {
  const form = new FormData();
  form.append('image', file);
  return apiFetch(`/admin/welcome/image${botQuery(bot)}`, { method: 'POST', body: form });
}

/** Same shape as uploadWelcomeImage, for MP4 video — mutually exclusive with an image at save time (one `imageFilename` slot). */
export function uploadWelcomeVideo(file, { bot } = {}) {
  const form = new FormData();
  form.append('video', file);
  return apiFetch(`/admin/welcome/video${botQuery(bot)}`, { method: 'POST', body: form });
}

/**
 * Fetches the currently-configured welcome media (image or video) as a
 * Blob, through the admin's own session cookie — same authenticated-proxy
 * pattern as fetchTelegramBroadcastMedia, just reading from this server's
 * own disk. Throws (ApiError) when no media is configured; the caller is
 * expected to fall back to a placeholder, not surface a raw error.
 */
export function fetchWelcomeImage({ bot } = {}) {
  return apiFetchBlob(`/admin/welcome/media${botQuery(bot)}`);
}

/** The full content-version history (prompt 0137), newest first, capped server-side at 20 entries — scoped per bot as of prompt 0139. */
export function listWelcomeVersions({ bot } = {}) {
  return apiFetch(`/admin/welcome/versions${botQuery(bot)}`);
}

/** A specific historical version's own media file, as a Blob — proves prompt 0137's per-version file fix: an old version keeps showing what was really attached back when IT was saved, never the currently-active media. */
export function fetchWelcomeVersionMedia(id) {
  return apiFetchBlob(`/admin/welcome/versions/${id}/media`);
}

/**
 * "Salin ke bot lain" (prompt 0141, Stage C) — copies `bot`'s current
 * effective welcome config (body + buttons + media) into the OTHER bot,
 * through the real save path (a new version + welcome.update audit entry
 * land on the TARGET bot — see welcomeController.js's copyToOtherBot()).
 * `bot` is the SOURCE; the target is never chosen explicitly, there are
 * only ever two bots.
 */
export function copyWelcomeToOtherBot({ bot } = {}) {
  return apiFetch('/admin/welcome/copy-to-other-bot', { method: 'POST', body: { bot } });
}
