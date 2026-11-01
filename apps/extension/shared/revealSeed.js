/**
 * Settings' "Reveal Secret Phrase" flow — password re-entry -> seed grid
 * display -> hide. Shared by settings/settings.js (its own full tab,
 * reached from onboarding.js's "Settings" button) and popup/popup.js (an
 * in-popup Settings screen) so this security-sensitive code has exactly
 * one implementation, not two that could silently drift apart. Renders
 * into whatever `container` element the caller provides and calls
 * `onExit()` once the user backs out or the seed auto-hides — the caller
 * decides what to render next (each page's own settings list, in whatever
 * shell that page uses: settings.html's `.card`, or a popup `.screen`).
 *
 * Security invariants that must hold in EVERY embedding context:
 *  - The password is asked fresh every single time this flow starts — no
 *    "already revealed this session" flag anywhere.
 *  - The revealed mnemonic lives only in this module's own `revealedMnemonic`
 *    variable, only while the seed screen is showing, and is never logged.
 *    Note this is one variable per *document* — settings.html and the
 *    popup are separate browsing contexts, so each gets its own isolated
 *    module instance; there is no cross-page state to leak.
 *  - The typed password is read once from the input at submit time, sent
 *    in the one FLUXIO_INTERNAL_REVEAL_SEED call, and never stored in a
 *    variable beyond that; the input is cleared after every attempt.
 *  - Hiding (an explicit Hide click, backing out of the password prompt,
 *    or losing visibility/focus) always does two things together: nulls
 *    the in-memory mnemonic reference AND replaces the DOM subtree that
 *    displayed it (never a display:none toggle that would leave the text
 *    sitting in the DOM) — `onExit()` re-rendering the container is what
 *    guarantees the second half.
 */
import { sendInternal, escapeHtml } from './messaging.js';

let revealedMnemonic = null; // array of words, only while the seed screen is showing

/** Step 1: password re-entry. `onExit()` is called on Cancel, and (indirectly, via renderSeedReveal) on Hide/auto-hide. */
export function renderRevealPasswordPrompt(container, onExit) {
  revealedMnemonic = null;

  container.innerHTML = `
    <h1>Reveal Secret Phrase</h1>
    <p class="desc">Enter your wallet password to view your recovery phrase.</p>
    <input type="password" id="revealPassword" placeholder="Wallet password" autocomplete="current-password" />
    <div class="error" id="revealErrorMsg"></div>
    <button class="primary" id="revealBtn">Reveal</button>
    <div class="back-link"><button class="link" id="revealCancelBtn">Cancel</button></div>
  `;

  document.getElementById('revealCancelBtn').addEventListener('click', onExit);

  const revealBtn = document.getElementById('revealBtn');
  const errorMsg = document.getElementById('revealErrorMsg');
  const passwordInput = document.getElementById('revealPassword');

  revealBtn.addEventListener('click', async () => {
    const password = passwordInput.value;
    if (!password) {
      errorMsg.textContent = 'Enter your wallet password.';
      return;
    }
    errorMsg.textContent = '';
    revealBtn.disabled = true;
    try {
      const { mnemonic } = await sendInternal('FLUXIO_INTERNAL_REVEAL_SEED', { password });
      passwordInput.value = '';
      revealedMnemonic = mnemonic.split(' ');
      renderSeedReveal(container, onExit);
    } catch (error) {
      passwordInput.value = '';
      errorMsg.textContent = error.message || 'Incorrect password.';
      revealBtn.disabled = false;
    }
  });
}

/** Step 2: the actual seed grid, plus the Hide button and auto-hide-on-blur/tab-switch wiring. */
function renderSeedReveal(container, onExit) {
  const grid = revealedMnemonic
    .map((word, i) => `<div class="seed-word"><span class="idx">${i + 1}</span>${escapeHtml(word)}</div>`)
    .join('');

  container.innerHTML = `
    <h1>Your recovery phrase</h1>
    <div class="warning">
      Don't let anyone else see this screen, and never take a screenshot or share these words.
      Fluxio will never ask you for your recovery phrase.
    </div>
    <div class="seed-grid">${grid}</div>
    <button class="secondary" id="hideBtn">Hide</button>
  `;

  function hide() {
    detachAutoHide();
    revealedMnemonic = null;
    onExit();
  }

  document.getElementById('hideBtn').addEventListener('click', hide);

  function onVisibilityChange() {
    if (document.hidden) hide();
  }
  function onWindowBlur() {
    hide();
  }
  function attachAutoHide() {
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);
  }
  function detachAutoHide() {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('blur', onWindowBlur);
  }

  attachAutoHide();
}
