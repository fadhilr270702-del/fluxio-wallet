import { apiFetch, apiFetchBlob } from './apiClient.js';

/**
 * Bot connectivity + live active-subscriber count, for the composer UI.
 * `bot` (prompt 0139, 'test' | 'official') is optional — omitted, the
 * backend defaults to 'test' (see backend/src/telegram/resolveBotId.js),
 * exactly matching every pre-0139 call site's behavior unchanged.
 */
export function getTelegramStatus({ bot } = {}) {
  const params = new URLSearchParams();
  if (bot) params.set('bot', bot);
  const qs = params.toString();
  return apiFetch(`/admin/broadcast/telegram/status${qs ? `?${qs}` : ''}`);
}

export function listTelegramBroadcasts({ status, limit, offset, bot } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (limit) params.set('limit', limit);
  if (offset) params.set('offset', offset);
  if (bot) params.set('bot', bot);
  const qs = params.toString();
  return apiFetch(`/admin/broadcast/telegram${qs ? `?${qs}` : ''}`);
}

export function getTelegramBroadcast(id) {
  return apiFetch(`/admin/broadcast/telegram/${id}`);
}

/**
 * Fetches a broadcast's real Telegram-hosted media (image/video) bytes as
 * a Blob, through the admin's own session cookie — see
 * backend/src/controllers/telegramBroadcastController.js's getMedia() for
 * the full server-side proxy (never a redirect to Telegram's own,
 * token-bearing URL). Throws (ApiError) for a broadcast with no media, an
 * expired/oversized file, or a Telegram-side failure — the caller (see
 * ViewBroadcastModal.jsx) is expected to fall back to the existing
 * icon+text badge on any rejection, not surface a raw error.
 */
export function fetchTelegramBroadcastMedia(id) {
  return apiFetchBlob(`/admin/broadcast/telegram/${id}/media`);
}

export function createTelegramBroadcast(fields) {
  return apiFetch('/admin/broadcast/telegram', { method: 'POST', body: fields });
}

/** Only succeeds while the broadcast is still `scheduled` — see backend/src/controllers/telegramBroadcastController.js. */
export function cancelTelegramBroadcast(id) {
  return apiFetch(`/admin/broadcast/telegram/${id}/cancel`, { method: 'POST' });
}

/**
 * Stops an active recurring broadcast (prompt 0134) — moves it to
 * 'completed' with its final sent_count/recurring_last_sent_at intact. Only
 * succeeds while the broadcast is still `recurring` — see
 * deactivateRecurring() in the backend controller.
 */
export function deactivateRecurringBroadcast(id) {
  return apiFetch(`/admin/broadcast/telegram/${id}/deactivate-recurring`, { method: 'POST' });
}

/** Content-only edit (title/body/mediaUrl/buttons). Only succeeds while still `scheduled` — see updateContent(). */
export function updateTelegramBroadcastContent(id, fields) {
  return apiFetch(`/admin/broadcast/telegram/${id}/content`, { method: 'PATCH', body: fields });
}

/** scheduled_at-only edit. Only succeeds while still `scheduled` — see reschedule(). */
export function rescheduleTelegramBroadcast(id, scheduledAt) {
  return apiFetch(`/admin/broadcast/telegram/${id}/schedule`, { method: 'PATCH', body: { scheduledAt } });
}

function botQuery(bot) {
  return bot ? `?bot=${encodeURIComponent(bot)}` : '';
}

/**
 * Saves an image server-side, then uploads it once to `bot`'s own storage
 * chat to get back a reusable file_id — see
 * backend/src/controllers/telegramBroadcastController.js's uploadImage().
 * `file` is a browser File object from an <input type="file">. `bot`
 * (prompt 0141, Stage C) is the bot to upload to — omitted, the backend
 * defaults to 'test'; ComposePage.jsx always passes it explicitly (the
 * live switcher position in create mode, the broadcast's own bot in edit
 * mode — see that component's own `effectiveMediaBotId`). The response's
 * `mediaServerFilename` is what "Salin ke form" now carries forward
 * cross-bot (see composeRecentCards.js) — `fileId` stays this bot's own,
 * never reused directly for another bot.
 */
export function uploadTelegramBroadcastImage(file, { bot } = {}) {
  const form = new FormData();
  form.append('image', file);
  return apiFetch(`/admin/broadcast/telegram/upload-image${botQuery(bot)}`, { method: 'POST', body: form });
}

/**
 * Same shape as uploadTelegramBroadcastImage — see
 * backend/src/controllers/telegramBroadcastController.js's uploadVideo().
 * `file` is a browser File object, expected to be MP4.
 */
export function uploadTelegramBroadcastVideo(file, { bot } = {}) {
  const form = new FormData();
  form.append('video', file);
  return apiFetch(`/admin/broadcast/telegram/upload-video${botQuery(bot)}`, { method: 'POST', body: form });
}
