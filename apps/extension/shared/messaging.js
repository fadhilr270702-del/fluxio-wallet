/**
 * Tiny helpers shared between the extension's own unbundled pages
 * (popup/popup.js, onboarding/onboarding.js). Loaded via a plain relative
 * ES module import — no bundler involved, same as provider/*.js loading
 * each other. Deliberately has zero @fluxio/crypto or @fluxio/services
 * imports: only background.js (the one bundled entry point) is allowed to
 * touch those — see build.mjs / CLAUDE.md.
 *
 * This mirrors approval/approval.js's own sendInternal()/escapeHtml()
 * helpers, minus the requestId echo (that's specific to approval.js's
 * pending-approval-request flow, not applicable here).
 */

/**
 * Sends a FLUXIO_INTERNAL_* message to background.js and resolves with its
 * response payload, or rejects with its error message. background.js only
 * accepts these from senders whose URL is under this extension's own
 * chrome-extension:// origin (see isTrustedInternalSender in background.js)
 * — true for any page of this extension, including this one.
 */
export function sendInternal(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (result?.error) {
        reject(new Error(result.error));
        return;
      }
      resolve(result?.response);
    });
  });
}

/** Escapes untrusted text before interpolating it into innerHTML. */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/**
 * chrome.storage.local key for the "Developer networks" toggle (Settings),
 * shared between settings.js (writes it) and popup.js (reads it) so the
 * key string only lives in one place. Plain chrome.storage.local usage is
 * fine directly from these unbundled pages — the bundling rule is only
 * about @fluxio/crypto/@fluxio/services npm imports, not browser APIs.
 * Default (unset) is treated as OFF everywhere it's read.
 */
export const DEV_NETWORKS_STORAGE_KEY = 'fluxio_developer_networks_enabled';

/**
 * chrome.storage.local key for the persisted Swap slippage-tolerance
 * choice (prompt 0115), read/written directly by popup.js only (nothing
 * else touches it yet) — co-located here anyway, matching
 * DEV_NETWORKS_STORAGE_KEY's own precedent of keeping every plain-
 * storage key string in this one shared file rather than inline in
 * popup.js. Value shape: a plain integer, basis points (e.g. 50 for
 * 0.5%). Default (unset) is 50 bps (0.5%) everywhere it's read — this
 * feature's own specified default.
 */
export const SWAP_SLIPPAGE_STORAGE_KEY = 'fluxio_swap_slippage_bps';

/**
 * chrome.storage.local key for the LAST COMPUTED portfolio fiat total
 * (prompt 0118) — a ready-to-render `{ totalFormatted, hasExcludedAssets,
 * computedAt }` blob, written only by background.js (the currency
 * formatting/summing happens there — see shared/portfolioValue.js), but
 * read DIRECTLY here by popup.js on render, same "plain chrome.storage.local
 * usage is fine directly from an unbundled page" reasoning as
 * DEV_NETWORKS_STORAGE_KEY above: this cached value holds no secret
 * (a fiat number and a timestamp), so there's no trust-boundary reason to
 * route the read through a background.js message. Reading it directly
 * (rather than via a round-trip FLUXIO_INTERNAL_* message) is precisely
 * what makes the "show the last known total instantly, before this
 * open's own fresh fetch resolves" requirement genuinely instant instead
 * of waiting on a message round trip first. Never contains raw
 * balances/prices/currency — just the final display string, so popup.js
 * needs no currency-formatting logic of its own to use it (same "popup.js
 * never does its own decimal/currency math" rule background.js's header
 * comment already establishes for every other amount shown here).
 */
export const PORTFOLIO_TOTAL_CACHE_STORAGE_KEY = 'fluxio_portfolio_total_cache';

/**
 * chrome.storage.local key for the "Card background" setting (prompt
 * 0121) — whether the account card on the main wallet-ready screen shows
 * the chevron accent (prompt 0120's apps/extension/assets/card-accent.png)
 * or a plain black surface with the ornament hidden. Same "plain
 * chrome.storage.local usage is fine directly from these unbundled
 * pages" reasoning as DEV_NETWORKS_STORAGE_KEY above — a pure display
 * preference, no secret, no background.js side effect to trigger, so no
 * FLUXIO_INTERNAL_* message exists for it either (checked directly:
 * background.js has none). The two real values and the default-
 * resolution logic live in shared/cardBackground.js, not here — this
 * file only collects the storage KEY STRING itself, matching this
 * file's own established convention (every plain-storage key lives in
 * one place, here).
 */
export const CARD_BACKGROUND_STORAGE_KEY = 'fluxio_card_background';

/**
 * chrome.storage.local key for the notifications inbox's own state
 * (prompt 0170) — one JSON blob, same "single cohesive feature's state in
 * one key" shape PORTFOLIO_TOTAL_CACHE_STORAGE_KEY already established,
 * rather than three separate keys: `{ announcements: [...], readIds:
 * [...], lastFetchedAt: number|null }`. Written only by background.js
 * (the actual fetch/merge/badge-recompute happens there — see
 * background.js's own fetchAndMergeNotifications()), but read DIRECTLY
 * here by popup.js on render for the header bell icon's unread dot, same
 * "no trust-boundary reason to route a non-secret read through a
 * message" reasoning as PORTFOLIO_TOTAL_CACHE_STORAGE_KEY above — this is
 * exactly what makes the bell dot show its last-known state instantly on
 * popup open, before that open's own throttled background refresh (if
 * any) resolves. Every announcement in it already passed through the
 * public API's own sanitizeRichHtml() (server-side) and this feature's
 * own richTextParse.js (client-side, defensive) before ever reaching a
 * screen — this cached blob itself holds no secret, just public
 * announcement content and a locally-generated read/seen bookkeeping.
 */
export const NOTIFICATIONS_STATE_STORAGE_KEY = 'fluxio_notifications_state';
