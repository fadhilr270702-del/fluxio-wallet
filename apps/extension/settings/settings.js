/**
 * Wallet Settings — currently one item, "Reveal Secret Phrase". Built as a
 * generic list so more settings can be added later without restructuring.
 * Opened as a full tab (never inside the popup, which closes on losing
 * focus) — same reasoning as onboarding/onboarding.js: this is the most
 * sensitive screen in the extension and must never be interrupted
 * mid-reveal. As of this file's own redesign, this is also reachable from
 * the popup as an in-popup screen (see popup/popup.js's
 * renderSettingsScreen) — that copy is deliberately NOT a duplicate of
 * this one, both share the actual reveal-flow implementation via
 * ../shared/revealSeed.js, kept here only for onboarding.js's own
 * "Settings" button (a full tab opening another full tab is a normal
 * transition there, unlike it was for the popup).
 *
 * Like every other unbundled page here, this file never touches
 * @fluxio/crypto or @fluxio/services directly — only background.js does,
 * via the FLUXIO_INTERNAL_* messages below.
 *
 * Secrets handling for the reveal flow itself now lives entirely in
 * ../shared/revealSeed.js (single source of truth for the password
 * re-entry -> seed display -> hide state machine, including the
 * never-log/always-fresh-password/DOM-scrubbing-on-hide invariants) — see
 * that file's own header comment.
 *
 * Second item, "Developer networks": a plain chrome.storage.local boolean
 * (default OFF) — no wallet secrets involved, so unlike Reveal Secret
 * Phrase this reads/writes storage directly rather than round-tripping
 * through background.js. popup.js reads the same key to decide whether to
 * show Solana Devnet/Solana Local/Ethereum Sepolia/Ethereum Local rows.
 *
 * Fifth item (after Auto-lock/Currency below), "Card background" (prompt
 * 0121): same direct-storage pattern as Developer networks, not
 * Auto-lock/Currency's message round trip — a pure display preference
 * with nothing for background.js to do. popup.js reads the same key to
 * decide whether the account card's chevron-accent ornament renders
 * visible or hidden; this page has no account card of its own.
 */
import { sendInternal, escapeHtml, DEV_NETWORKS_STORAGE_KEY, CARD_BACKGROUND_STORAGE_KEY } from '../shared/messaging.js';
import { renderRevealPasswordPrompt } from '../shared/revealSeed.js';
// Auto-lock (prompt 0117) — same pure module popup.js's Settings screen
// uses, here only for its two constants (building <select> options and
// formatting the current value); the actual lock decision only ever runs
// in background.js. See that module's own header comment.
import { AUTO_LOCK_NEVER, AUTO_LOCK_OPTIONS_MINUTES } from '../shared/autoLockDecision.js';
// Portfolio fiat total (prompt 0118) — same pattern as autoLockDecision.js
// above: only used here for SUPPORTED_CURRENCIES' code/label pairs to
// build the Currency <select>; the actual total is only ever computed in
// background.js. Deliberately imports shared/portfolioDisplay.js, NOT
// its sibling shared/portfolioValue.js — that one needs @fluxio/constants
// and must never be imported from an unbundled page (see its own header
// comment for the real bug this exact mistake caused, fixed in a
// Revision 1 to prompt 0118).
import { SUPPORTED_CURRENCIES } from '../shared/portfolioDisplay.js';
// Card background (prompt 0121) — same "read the two constants/options
// list here, the actual decision has nothing to run in background.js"
// pattern as autoLockDecision.js/portfolioDisplay.js above. Unlike those
// two, this setting never round-trips through background.js at all (see
// getCardBackground() below) — it's a pure chrome.storage.local
// preference, same as Developer networks.
import { CARD_BACKGROUND_OPTIONS, resolveCardBackground } from '../shared/cardBackground.js';

const app = document.getElementById('app');

async function main() {
  let status;
  try {
    status = await sendInternal('FLUXIO_INTERNAL_GET_STATUS');
  } catch (error) {
    renderBlocked(error.message);
    return;
  }

  if (!status.hasWallet) {
    renderBlocked('No wallet on this device yet.');
    return;
  }
  if (!status.isUnlocked) {
    renderBlocked('Your wallet is locked. Unlock it from the extension popup first, then reopen Settings.');
    return;
  }

  renderSettingsList();
}

function renderBlocked(message) {
  app.innerHTML = `
    <h1>Settings</h1>
    <p class="desc">${escapeHtml(message)}</p>
  `;
}

/** "1 minute" / "5 minutes" / "1 hour" / "Never" — mirrors popup.js's own formatAutoLockLabel exactly (small enough, and tied closely enough to this page's own markup, that a shared helper module felt like more indirection than it was worth for one string formatter — see this file's own header comment on why some things stay duplicated between the two Settings surfaces). */
function formatAutoLockLabel(minutes) {
  if (minutes === AUTO_LOCK_NEVER) return 'Never';
  if (minutes === 60) return '1 hour';
  if (minutes === 1) return '1 minute';
  return `${minutes} minutes`;
}

async function renderSettingsList() {
  const devNetworksEnabled = await getDevNetworksEnabled();
  const cardBackground = await getCardBackground();
  let autoLockMinutes = 15;
  try {
    ({ minutes: autoLockMinutes } = await sendInternal('FLUXIO_INTERNAL_GET_AUTO_LOCK'));
  } catch {
    // Non-fatal — see popup.js's own renderSettingsScreen for the same fallback.
  }
  let portfolioCurrency = 'usd';
  try {
    ({ currency: portfolioCurrency } = await sendInternal('FLUXIO_INTERNAL_GET_CURRENCY'));
  } catch {
    // Non-fatal — same fallback reasoning as Auto-lock above.
  }

  app.innerHTML = `
    <h1>Settings</h1>
    <div class="settings-list">
      <button class="settings-item" id="revealItem">
        <span>Reveal Secret Phrase</span>
        <span class="chevron">›</span>
      </button>
      <div class="settings-item settings-item--toggle">
        <span class="settings-item__label">
          <span>Developer networks</span>
          <span class="settings-item__hint">Show Solana Devnet, Solana Local, Ethereum Sepolia &amp; Ethereum Local in the popup</span>
        </span>
        <label class="toggle-switch">
          <input type="checkbox" id="devNetworksToggle" ${devNetworksEnabled ? 'checked' : ''} />
          <span class="track"><span class="thumb"></span></span>
        </label>
      </div>
      <div class="settings-item settings-item--toggle">
        <span class="settings-item__label">
          <span>Auto-lock</span>
          <span class="settings-item__hint">Lock the wallet automatically after inactivity</span>
        </span>
        <select id="autoLockSelect" class="settings-select">
          ${AUTO_LOCK_OPTIONS_MINUTES.map(
            (m) => `<option value="${escapeHtml(String(m))}" ${m === autoLockMinutes ? 'selected' : ''}>${escapeHtml(formatAutoLockLabel(m))}</option>`
          ).join('')}
        </select>
      </div>
      <div class="settings-item settings-item--toggle">
        <span class="settings-item__label">
          <span>Currency</span>
          <span class="settings-item__hint">Portfolio total on the main screen</span>
        </span>
        <select id="currencySelect" class="settings-select">
          ${SUPPORTED_CURRENCIES.map(
            (c) => `<option value="${escapeHtml(c.code)}" ${c.code === portfolioCurrency ? 'selected' : ''}>${escapeHtml(c.code.toUpperCase())} · ${escapeHtml(c.label)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="settings-item settings-item--toggle">
        <span class="settings-item__label">
          <span>Card background</span>
          <span class="settings-item__hint">Chevron accent or a plain black card</span>
        </span>
        <select id="cardBackgroundSelect" class="settings-select">
          ${CARD_BACKGROUND_OPTIONS.map(
            (o) => `<option value="${escapeHtml(o.value)}" ${o.value === cardBackground ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
          ).join('')}
        </select>
      </div>
    </div>
  `;
  // `app` is this page's own `.card` (already padded) — passed straight
  // through as the reveal flow's container, same as its own #app root.
  document.getElementById('revealItem').addEventListener('click', () => renderRevealPasswordPrompt(app, renderSettingsList));
  document.getElementById('devNetworksToggle').addEventListener('change', async (event) => {
    await chrome.storage.local.set({ [DEV_NETWORKS_STORAGE_KEY]: event.target.checked });
  });
  document.getElementById('cardBackgroundSelect').addEventListener('change', async (event) => {
    // Same direct-storage pattern as devNetworksToggle above — this page
    // has no account card of its own to update; the popup re-reads this
    // key fresh on its own next render.
    await chrome.storage.local.set({ [CARD_BACKGROUND_STORAGE_KEY]: event.target.value });
  });
  document.getElementById('autoLockSelect').addEventListener('change', async (event) => {
    const raw = event.target.value;
    const minutes = raw === AUTO_LOCK_NEVER ? AUTO_LOCK_NEVER : Number(raw);
    try {
      await sendInternal('FLUXIO_INTERNAL_SET_AUTO_LOCK', { minutes });
    } catch {
      // Best-effort — this page has no toast mechanism (unlike popup.js);
      // a failed change is silently retried by simply picking the option
      // again, same as any other transient-failure UI action here.
    }
  });
  document.getElementById('currencySelect').addEventListener('change', async (event) => {
    try {
      await sendInternal('FLUXIO_INTERNAL_SET_CURRENCY', { currency: event.target.value });
      // Recompute the cached total in the new currency right away — no
      // new CoinGecko call (background.js already has every currency's
      // price cached, see FLUXIO_INTERNAL_SET_CURRENCY's own comment) —
      // so the popup's own card reads the correct number next time it
      // opens, not the previous currency's total. Fire-and-forget, same
      // best-effort reasoning as Auto-lock above; this page has nothing
      // of its own to update either way.
      sendInternal('FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE').catch(() => {});
    } catch {
      // Best-effort — same reasoning as Auto-lock above.
    }
  });
}

function getDevNetworksEnabled() {
  return new Promise((resolve) => {
    chrome.storage.local.get([DEV_NETWORKS_STORAGE_KEY], (result) => {
      resolve(result?.[DEV_NETWORKS_STORAGE_KEY] === true);
    });
  });
}

/** Mirrors popup.js's own getCardBackground() exactly — see that file's comment for why resolveCardBackground() (not a bare boolean check) is used. */
function getCardBackground() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CARD_BACKGROUND_STORAGE_KEY], (result) => {
      resolve(resolveCardBackground(result?.[CARD_BACKGROUND_STORAGE_KEY]));
    });
  });
}

main();
