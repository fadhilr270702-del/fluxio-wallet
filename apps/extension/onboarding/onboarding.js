/**
 * Wallet onboarding — create, import, or unlock. Opened as a full browser
 * tab (never inside the popup, which closes on losing focus — see
 * popup/popup.js) so a user can never lose their seed phrase mid-flow.
 *
 * This file never touches @fluxio/crypto or @fluxio/services directly —
 * only background/background.js does (see build.mjs: it's the one
 * bundled entry point). Every crypto operation here goes through a
 * FLUXIO_INTERNAL_* message to background.js.
 *
 * Secrets handling: the freshly generated mnemonic (create flow) and the
 * pasted mnemonic (import flow) live only in the module-level variables
 * below, for as long as this tab stays on the relevant screen. Neither is
 * ever logged, sent anywhere but the one background.js round trip that
 * persists it (through @fluxio/crypto's createVault, already encrypted
 * before it touches storage), or written to chrome.storage/localStorage
 * directly. Both are set back to null the moment the vault has been
 * created — see the submit handler in renderPassword().
 */
import { sendInternal, escapeHtml } from '../shared/messaging.js';
// Import-wallet numbered seed grid (prompt 0125) — same "extract the
// decision, keep the side effects here" pattern as every other shared/*
// pure module this file could reach for; see that module's own header
// comment.
import {
  splitPastedWords,
  distributeWordsToBoxes,
  suggestWordCountForPaste,
  remapWordsForBoxCountChange,
  wordsWouldBeDiscarded,
  isGridComplete
} from '../shared/importSeedGrid.js';

const app = document.getElementById('app');

let mnemonicWords = null; // array of words, only while showing/verifying a freshly generated seed
let pendingImportMnemonic = null; // validated pasted mnemonic string, only while collecting the import password
let verifyIndices = [];

async function main() {
  let status;
  try {
    status = await sendInternal('FLUXIO_INTERNAL_GET_STATUS');
  } catch (error) {
    renderFatalError(error.message);
    return;
  }

  if (status.hasWallet) {
    // A wallet already exists on this device — never show create/import
    // again here, only unlock (or wallet-ready if already unlocked). This
    // is the UI-level half of the guard against overwriting an existing
    // vault; background.js's FLUXIO_INTERNAL_IMPORT_WALLET handler is the
    // backend-level half.
    if (status.isUnlocked) {
      renderWalletReady(status.wallet);
    } else {
      renderUnlock();
    }
    return;
  }

  renderChoose();
}

function renderFatalError(message) {
  app.innerHTML = `
    <h1>Something went wrong</h1>
    <p class="desc">${escapeHtml(message)}</p>
  `;
}

function renderChoose() {
  app.innerHTML = `
    <h1>Welcome to Fluxio</h1>
    <p class="desc">Set up a wallet to get started. This device doesn't have one yet.</p>
    <div class="choices">
      <button class="primary" id="createBtn">Create new wallet</button>
      <button class="secondary" id="importBtn">Import wallet</button>
    </div>
  `;
  document.getElementById('createBtn').addEventListener('click', renderWordCount);
  document.getElementById('importBtn').addEventListener('click', renderImportWordCount);
}

function renderWordCount() {
  app.innerHTML = `
    <h1>Create new wallet</h1>
    <p class="desc">Choose how many words your recovery phrase should have.</p>
    <div class="word-count-choices">
      <button class="secondary" id="wc12">12 words</button>
      <button class="secondary" id="wc24">24 words</button>
    </div>
    <div class="choices"><button class="secondary" id="backBtn">Back</button></div>
  `;
  document.getElementById('wc12').addEventListener('click', () => startCreate(12));
  document.getElementById('wc24').addEventListener('click', () => startCreate(24));
  document.getElementById('backBtn').addEventListener('click', renderChoose);
}

async function startCreate(wordCount) {
  app.innerHTML = `<div class="loading">Generating your recovery phrase…</div>`;
  try {
    const { mnemonic } = await sendInternal('FLUXIO_INTERNAL_GENERATE_MNEMONIC', { wordCount });
    mnemonicWords = mnemonic.split(' ');
    renderShowSeed();
  } catch (error) {
    renderFatalError(error.message);
  }
}

function renderShowSeed() {
  const grid = mnemonicWords
    .map((word, i) => `<div class="seed-word"><span class="idx">${i + 1}</span>${escapeHtml(word)}</div>`)
    .join('');

  app.innerHTML = `
    <h1>Your recovery phrase</h1>
    <div class="warning">
      Never share this phrase with anyone. Write it down and store it offline — Fluxio cannot
      recover it for you if it's lost. Anyone with these words can take everything in this wallet.
    </div>
    <div class="seed-grid">${grid}</div>
    <div class="choices">
      <button class="primary" id="continueBtn">I've written it down</button>
      <button class="secondary" id="backBtn">Choose a different word count</button>
    </div>
  `;
  document.getElementById('continueBtn').addEventListener('click', renderVerifySeed);
  document.getElementById('backBtn').addEventListener('click', () => {
    // Genuinely abandoning this phrase for a new word-count choice — unlike
    // "view seed phrase again" below, which must reuse the same phrase.
    mnemonicWords = null;
    renderWordCount();
  });
}

function pickRandomIndices(length, count) {
  const indices = Array.from({ length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, count).sort((a, b) => a - b);
}

function renderVerifySeed() {
  verifyIndices = pickRandomIndices(mnemonicWords.length, Math.min(3, mnemonicWords.length));

  const fields = verifyIndices
    .map(
      (i) => `
      <div class="verify-field">
        <label for="verify-${i}">Word #${i + 1}</label>
        <input type="text" id="verify-${i}" autocomplete="off" autocapitalize="off" spellcheck="false" />
      </div>`
    )
    .join('');

  app.innerHTML = `
    <h1>Verify your recovery phrase</h1>
    <p class="desc">Type the requested words to confirm you've written the phrase down correctly.</p>
    ${fields}
    <div class="error" id="errorMsg"></div>
    <div class="choices">
      <button class="primary" id="continueBtn">Continue</button>
      <button class="secondary" id="viewAgainBtn">View seed phrase again</button>
    </div>
  `;

  // Reuses the SAME in-memory mnemonicWords — never regenerates, or
  // everything the user already wrote down would silently become invalid.
  document.getElementById('viewAgainBtn').addEventListener('click', renderShowSeed);

  document.getElementById('continueBtn').addEventListener('click', () => {
    const errorMsg = document.getElementById('errorMsg');
    const allCorrect = verifyIndices.every((i) => {
      const typed = (document.getElementById(`verify-${i}`).value || '').trim().toLowerCase();
      return typed === mnemonicWords[i].toLowerCase();
    });
    if (!allCorrect) {
      errorMsg.textContent = "That doesn't match your recovery phrase — try again.";
      return;
    }
    renderPassword('create');
  });
}

/** Shared password screen for both finishing "create" and "import" — mode only changes copy/button label. */
function renderPassword(mode) {
  app.innerHTML = `
    <h1>${mode === 'create' ? 'Create a password' : 'Set a password'}</h1>
    <p class="desc">
      This password encrypts your wallet on this device. You'll need it to unlock Fluxio. It
      cannot be recovered if you forget it, only restored from your recovery phrase.
    </p>
    <input type="password" id="password" placeholder="Password (min. 8 characters)" autocomplete="new-password" />
    <input type="password" id="confirmPassword" placeholder="Confirm password" autocomplete="new-password" />
    <div class="error" id="errorMsg"></div>
    <button class="primary" id="submitBtn">${mode === 'create' ? 'Create wallet' : 'Import wallet'}</button>
  `;

  const submitBtn = document.getElementById('submitBtn');
  const errorMsg = document.getElementById('errorMsg');

  submitBtn.addEventListener('click', async () => {
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    if (password.length < 8) {
      errorMsg.textContent = 'Password must be at least 8 characters.';
      return;
    }
    if (password !== confirmPassword) {
      errorMsg.textContent = 'Passwords do not match.';
      return;
    }

    const mnemonic = mode === 'create' ? mnemonicWords.join(' ') : pendingImportMnemonic;

    errorMsg.textContent = '';
    submitBtn.disabled = true;
    try {
      const { wallet } = await sendInternal('FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic, password });
      // Vault is persisted (encrypted) now — drop every reference to the
      // plaintext mnemonic this page was holding.
      mnemonicWords = null;
      pendingImportMnemonic = null;
      renderWalletReady(wallet);
    } catch (error) {
      errorMsg.textContent = error.message || 'Could not finish setting up the wallet.';
      submitBtn.disabled = false;
    }
  });
}

/** Same markup/styling pattern as renderWordCount() (create flow) — reused verbatim per this feature's own instruction not to invent a new visual pattern for this choice. */
function renderImportWordCount() {
  app.innerHTML = `
    <h1>Import wallet</h1>
    <p class="desc">Choose how many words your recovery phrase has.</p>
    <div class="word-count-choices">
      <button class="secondary" id="wc12">12 words</button>
      <button class="secondary" id="wc24">24 words</button>
    </div>
    <div class="choices"><button class="secondary" id="backBtn">Back</button></div>
  `;
  document.getElementById('wc12').addEventListener('click', () => renderImportGrid(12));
  document.getElementById('wc24').addEventListener('click', () => renderImportGrid(24));
  document.getElementById('backBtn').addEventListener('click', renderChoose);
}

/**
 * The numbered seed-input grid (prompt 0125) — a Phantom/MetaMask-style
 * replacement for the old plain textarea. `boxCount` is 12 or 24;
 * `initialWords`, when given (only ever passed by this function calling
 * itself — see the word-count switch and paste-mode-switch handlers
 * below), is remapped onto the new box count via remapWordsForBoxCountChange()
 * rather than starting blank, so switching word counts doesn't throw away
 * what's already been typed.
 *
 * Security note (this screen shows seed words in plaintext while being
 * filled in, same as Phantom's own equivalent screen — unavoidable for
 * this UX): every exit path (Back, switching word count, a successful
 * Import) calls clearGridSecrets() BEFORE moving on, which blanks every
 * box's live `.value` first — belt-and-suspenders alongside the fact that
 * every render function here replaces `app.innerHTML` wholesale anyway
 * (destroying the old input elements outright). Same two-part ritual
 * shared/revealSeed.js uses (null the in-memory reference, then replace
 * the DOM subtree that displayed it) — this screen's "in-memory
 * reference" IS the live DOM input values, since nothing here ever
 * copies them into a separate JS variable except momentarily, to build
 * the one mnemonic string handed to FLUXIO_INTERNAL_VALIDATE_MNEMONIC.
 * @param {12 | 24} boxCount
 * @param {string[]} [initialWords]
 */
function renderImportGrid(boxCount, initialWords) {
  const words = initialWords ? remapWordsForBoxCountChange(initialWords, boxCount) : distributeWordsToBoxes([], boxCount);
  const otherCount = boxCount === 12 ? 24 : 12;

  const fields = Array.from({ length: boxCount }, (_, i) => `
    <div class="seed-word seed-word--input">
      <span class="idx">${i + 1}</span>
      <input
        type="text"
        class="seed-word-field"
        id="importWord-${i}"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        value="${escapeHtml(words[i] || '')}"
      />
    </div>`).join('');

  app.innerHTML = `
    <h1>Import wallet</h1>
    <p class="desc">Enter your ${boxCount}-word recovery phrase, one word per box.</p>
    <div class="seed-grid">${fields}</div>
    <div class="field-hint" id="pasteHint" hidden></div>
    <div class="error" id="errorMsg"></div>
    <div class="choices">
      <button class="primary" id="continueBtn" disabled>Import</button>
      <button class="secondary" id="switchCountBtn">Use ${otherCount} words instead</button>
      <button class="secondary" id="backBtn">Back</button>
    </div>
  `;

  const inputs = Array.from({ length: boxCount }, (_, i) => document.getElementById(`importWord-${i}`));
  const continueBtn = document.getElementById('continueBtn');
  const switchCountBtn = document.getElementById('switchCountBtn');
  const errorMsg = document.getElementById('errorMsg');
  const pasteHint = document.getElementById('pasteHint');

  function currentWords() {
    return inputs.map((input) => input.value.trim().toLowerCase());
  }

  function refreshImportButton() {
    continueBtn.disabled = !isGridComplete(currentWords());
  }

  /** The screen's own half of the security note above — see this function's own JSDoc. */
  function clearGridSecrets() {
    inputs.forEach((input) => { input.value = ''; });
  }

  /**
   * Prompt 0125 Revision 1 — a real bug caught by manual verification: the
   * paste-triggered "Looks like a N-word phrase" offer had no auto-dismiss
   * at all before this fix, so it could sit on screen alongside an
   * unrelated (and, by then, stale) validation error once the user typed
   * over it or tried Import anyway. Dismissed on the two moments the
   * prompt itself named as the minimum: the user edits any box after the
   * paste (they're choosing not to take the suggestion), or they press
   * Import (their intent is now "try this as typed", not "reconsider the
   * count"). Setting `.value` programmatically (the paste handler itself,
   * or remapWordsForBoxCountChange() repopulating a fresh grid) does NOT
   * fire a real 'input' event, so this never fights with the paste
   * handler's own hint-showing logic below.
   */
  function dismissPasteHint() {
    pasteHint.hidden = true;
    pasteHint.innerHTML = '';
  }

  inputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      dismissPasteHint();
      refreshImportButton();
    });

    input.addEventListener('keydown', (event) => {
      // Space/Enter advance focus instead of typing — a mnemonic word
      // never legitimately contains either, and this is what makes typing
      // feel like Phantom's own grid rather than 12-24 separate plain
      // text inputs.
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        const next = inputs[i + 1];
        if (next) next.focus();
        return;
      }
      if (event.key === 'Backspace' && input.value === '' && i > 0) {
        event.preventDefault();
        inputs[i - 1].focus();
      }
    });

    input.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData).getData('text');
      const pasted = splitPastedWords(text);
      if (pasted.length === 0) return;

      const distributed = distributeWordsToBoxes(pasted, boxCount);
      inputs.forEach((box, idx) => { box.value = distributed[idx]; });
      refreshImportButton();

      const firstEmpty = inputs.findIndex((box) => box.value === '');
      (firstEmpty === -1 ? inputs[inputs.length - 1] : inputs[firstEmpty]).focus();

      // A light, dismissible offer to switch — never a blocking dialog
      // (no window.confirm() anywhere in this codebase, and this screen
      // doesn't introduce one). Same ".link inside .field-hint" shape
      // already used elsewhere in this file/theme.
      const suggestion = suggestWordCountForPaste(pasted.length, boxCount);
      if (suggestion) {
        pasteHint.hidden = false;
        pasteHint.innerHTML = `Looks like a ${suggestion}-word phrase. <button type="button" class="link" id="pasteSwitchBtn">Switch to ${suggestion} words</button>`;
        document.getElementById('pasteSwitchBtn').addEventListener('click', () => {
          clearGridSecrets();
          renderImportGrid(suggestion, pasted);
        });
      } else {
        dismissPasteHint();
      }
    });
  });

  // "Use N words instead" — a light, two-click confirm ONLY when switching
  // would actually discard something (24->12 with words 13-24 filled in);
  // otherwise switches immediately, matching this codebase's own existing
  // two-click pattern (popup.js's wireTokenManageRemoveButtons) rather than
  // introducing a native confirm() dialog.
  let switchArmed = false;
  switchCountBtn.addEventListener('click', () => {
    const words = currentWords();
    if (!switchArmed && wordsWouldBeDiscarded(words, otherCount)) {
      switchArmed = true;
      switchCountBtn.textContent = `Discard words ${otherCount + 1}-${boxCount} and switch?`;
      return;
    }
    clearGridSecrets();
    renderImportGrid(otherCount, words);
  });

  document.getElementById('backBtn').addEventListener('click', () => {
    // One step back in the hierarchy (to the word-count choice), not all
    // the way to the welcome screen — matches the create-wallet flow's
    // own precedent (renderShowSeed()'s "Choose a different word count"
    // link goes to renderWordCount(), not renderChoose()).
    clearGridSecrets();
    renderImportWordCount();
  });

  continueBtn.addEventListener('click', async () => {
    dismissPasteHint();
    const words = currentWords();
    if (!isGridComplete(words)) return; // defense in depth — the button should already be disabled
    const mnemonic = words.join(' ');
    errorMsg.textContent = '';
    continueBtn.disabled = true;
    try {
      const { valid } = await sendInternal('FLUXIO_INTERNAL_VALIDATE_MNEMONIC', { mnemonic });
      if (!valid) {
        errorMsg.textContent = 'That recovery phrase is not valid. Check the words and try again.';
        continueBtn.disabled = false;
        return;
      }
      pendingImportMnemonic = mnemonic;
      clearGridSecrets();
      renderPassword('import');
    } catch (error) {
      errorMsg.textContent = error.message || 'Could not validate this recovery phrase.';
      continueBtn.disabled = false;
    }
  });

  refreshImportButton();
  inputs[0].focus();
}

function renderUnlock() {
  app.innerHTML = `
    <h1>Unlock Fluxio</h1>
    <p class="desc">A wallet already exists on this device.</p>
    <input type="password" id="password" placeholder="Wallet password" autocomplete="current-password" />
    <div class="error" id="errorMsg"></div>
    <button class="primary" id="unlockBtn">Unlock</button>
  `;

  const unlockBtn = document.getElementById('unlockBtn');
  const errorMsg = document.getElementById('errorMsg');
  unlockBtn.addEventListener('click', async () => {
    const password = document.getElementById('password').value;
    if (!password) {
      errorMsg.textContent = 'Enter your wallet password.';
      return;
    }
    errorMsg.textContent = '';
    unlockBtn.disabled = true;
    try {
      const { wallet } = await sendInternal('FLUXIO_INTERNAL_UNLOCK', { password });
      renderWalletReady(wallet);
    } catch (error) {
      errorMsg.textContent = error.message || 'Incorrect password.';
      unlockBtn.disabled = false;
    }
  });
}

function renderWalletReady(wallet) {
  const solana = wallet?.accounts?.solana?.address || '—';
  const evm = wallet?.accounts?.evm?.address || '—';
  app.innerHTML = `
    <h1>Wallet ready</h1>
    <p class="desc">Your wallet is set up and unlocked on this device.</p>
    <div class="address-label">Solana address</div>
    <div class="address-box">${escapeHtml(solana)}</div>
    <div class="address-label">EVM address (Ethereum / BNB Chain / Base)</div>
    <div class="address-box">${escapeHtml(evm)}</div>
    <button class="secondary" id="openSettings">Settings</button>
    <p class="field-hint">You can close this tab now.</p>
  `;
  document.getElementById('openSettings').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
  });
}

main();
