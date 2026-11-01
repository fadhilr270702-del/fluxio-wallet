/**
 * Content script — the ONLY bridge between untrusted webpage JS and the
 * extension's background service worker. Runs at document_start, in an
 * isolated world, but shares the page's DOM and its `window.postMessage`
 * channel with whatever script the page loaded — which means every
 * message this script receives must be treated as attacker-controlled.
 *
 * Hardening applied here (see CLAUDE.md Phase 1 "Extension security"):
 *   - Only same-window, same-origin messages are considered (rejects
 *     cross-origin iframes / other frames trying to post into this page).
 *   - Only an allow-listed set of request types with a well-formed
 *     requestId are relayed to the background service worker — arbitrary
 *     shaped objects are dropped before they ever reach chrome.runtime.
 *   - Responses are posted back with an explicit targetOrigin (this
 *     page's own origin) instead of '*', so a malicious same-page iframe
 *     on a different origin can't eavesdrop on the response.
 *
 * This script never imports or touches wallet crypto — that's by design.
 * Nothing here needs to, and keeping it that way means private key
 * material has no code path through this file even in principle.
 */
(function () {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('provider/provider.js');
  script.type = 'module';
  script.onload = () => script.remove();
  document.documentElement.prepend(script);

  const ALLOWED_TYPES = new Set(['CONNECT', 'SIGN_MESSAGE', 'SIGN_TRANSACTION']);
  const pageOrigin = window.location.origin;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return; // ignore other frames/iframes
    if (event.origin !== pageOrigin) return; // ignore cross-origin senders
    if (!isValidRequest(event.data)) return;

    const { type, requestId, payload } = event.data;
    chrome.runtime.sendMessage({ type, requestId, payload }, (response) => {
      if (chrome.runtime.lastError) {
        postToPage({
          requestId,
          error: chrome.runtime.lastError.message,
          source: 'fluxio-extension'
        });
        return;
      }
      postToPage({ ...response, source: 'fluxio-extension' });
    });
  });

  function isValidRequest(data) {
    return (
      !!data &&
      data.source === 'fluxio-provider' &&
      ALLOWED_TYPES.has(data.type) &&
      typeof data.requestId === 'string' &&
      data.requestId.length > 0 &&
      data.requestId.length < 200
    );
  }

  function postToPage(message) {
    window.postMessage(message, pageOrigin);
  }
})();
