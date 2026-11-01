/**
 * Minimal inline-message helper.
 * Writes a short status message into a target element and clears it after a delay.
 */
function showMessage(targetEl, text, { duration = 4000 } = {}) {
  if (!targetEl) return;
  targetEl.textContent = text;

  if (targetEl._clearTimer) {
    clearTimeout(targetEl._clearTimer);
  }
  targetEl._clearTimer = setTimeout(() => {
    targetEl.textContent = '';
  }, duration);
}
