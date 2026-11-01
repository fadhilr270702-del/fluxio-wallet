/**
 * Thin fetch wrapper shared by authApi.js and announcementsApi.js.
 *
 * `credentials: 'include'` on every request is what makes the session
 * cookie actually round-trip — without it, a same-origin dev proxy request
 * would still work (browsers send cookies same-origin by default) but a
 * cross-origin production deployment (admin.example.com talking to
 * api.example.com) would silently drop the cookie and every request would
 * look unauthenticated.
 *
 * In dev, VITE_API_BASE_URL is unset and BASE_URL is '' — requests go to
 * relative paths like `/admin/login`, which vite.config.js's proxy forwards
 * to the backend. In production, set VITE_API_BASE_URL to the real backend
 * origin (see .env.example) and the CORS config in backend/src/app.js must
 * allow it via ADMIN_ORIGIN.
 */
const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export async function apiFetch(path, { method = 'GET', body, signal } = {}) {
  // FormData (image upload) must NOT be JSON.stringify'd or given an
  // explicit Content-Type — the browser sets the correct multipart
  // boundary itself only when Content-Type is left unset. Every existing
  // call site passes a plain object, so this is purely additive.
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    credentials: 'include',
    headers: body && !isFormData ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? (isFormData ? body : JSON.stringify(body)) : undefined,
    signal
  });

  // 204 No Content (logout) has no JSON body to parse.
  const data = res.status === 204 ? null : await res.json().catch(() => null);

  if (!res.ok) {
    const err = data?.error || {};
    throw new ApiError(res.status, err.code || 'UNKNOWN_ERROR', err.message);
  }
  return data;
}

/**
 * Like apiFetch, but for a binary response — added in prompt 0132 Revision
 * 2 for the "View broadcast" modal's real image/video preview
 * (GET /admin/broadcast/telegram/:id/media). Deliberately not just an
 * `<img src="...">`/`<video src="...">` pointed straight at that endpoint
 * (the caller's own instruction, and for two concrete reasons): (1) this
 * app's session cookie round-trips via `credentials:'include'` on a fetch
 * the same way every other admin request already does — a bare `<img>`/
 * `<video>` tag needs an easy-to-forget `crossOrigin="use-credentials"`
 * opt-in to send credentials cross-origin at all (irrelevant in dev's
 * same-origin proxy setup, but this app is deployed cross-origin in
 * production per this file's own header comment); (2) more importantly,
 * this endpoint can fail in several distinct ways (no media, file expired,
 * over the 20MB Bot-API download cap, a transient Telegram error) with a
 * JSON error body explaining which — a fetch lets the caller read that
 * body and status to show a specific, non-crashing fallback, which a
 * media tag's own `onError` event can't do (it has no access to the
 * response body/status at all). Returns a Blob on success; throws the same
 * ApiError shape as apiFetch on failure, parsed from the JSON error body
 * when present.
 */
export async function apiFetchBlob(path) {
  const res = await fetch(`${BASE_URL}${path}`, { credentials: 'include' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const err = data?.error || {};
    throw new ApiError(res.status, err.code || 'UNKNOWN_ERROR', err.message);
  }
  return res.blob();
}
