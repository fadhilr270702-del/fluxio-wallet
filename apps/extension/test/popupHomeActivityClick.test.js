// 0245 — the home action row's Activity button, against the REAL popup.js
// module (same guarded test seam + hand-rolled document/chrome stub as
// popupSwapConfirmClick.test.js, per the 0223 lesson: a UI text test does
// not prove a button works — the CLICK PATH itself must be driven). This
// prompt replaced the Buy "Coming soon" placeholder with Activity in the
// action row (Send, Receive, Activity, Swap) and removed the header's old
// clock icon, so two things need locking: (1) clicking the new button
// really opens the Activity screen, and (2) the header no longer carries
// an Activity button at all.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POPUP_PATH = path.join(__dirname, '..', 'popup', 'popup.js');
const CLICK_TEST_TIMEOUT_MS = 30000; // prompt 0194's measured pattern: the big popup module import crawls under full-suite worker contention

const elements = new Map();
function makeElement(id) {
  const stub = {
    id,
    _innerHTML: '',
    _textContent: '',
    hidden: false,
    disabled: false,
    value: '',
    style: {},
    dataset: {},
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    click() {
      for (const fn of this.listeners.click || []) fn({ preventDefault() {} });
    },
    appendChild() {},
    insertAdjacentHTML() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() {},
    setAttribute() {},
    removeAttribute() {}
  };
  Object.defineProperty(stub, 'textContent', {
    get() {
      return this._textContent;
    },
    set(value) {
      this._textContent = String(value ?? '');
      this._innerHTML = this._textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  });
  Object.defineProperty(stub, 'innerHTML', {
    get() {
      return this._innerHTML;
    },
    set(value) {
      this._innerHTML = String(value ?? '');
    }
  });
  return stub;
}
function el(id) {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
}

function installStubs() {
  elements.clear();
  globalThis.document = {
    getElementById: (id) => el(id),
    // renderWalletReady's wireCopyButton setup reads
    // document.querySelector('#chip-sol .chip__text') — null is enough,
    // wireCopyButton guards a missing labelEl itself.
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createElement: (tag) => makeElement(`created-${tag}`),
    createTextNode: (text) => ({ textContent: text }),
    body: makeElement('body')
  };
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, cb) {
        const respond = (response) => cb && cb({ response });
        switch (message.type) {
          case 'FLUXIO_INTERNAL_GET_STATUS':
            return respond({ hasWallet: false });
          case 'FLUXIO_INTERNAL_GET_ACCOUNTS':
            // The real response shape (accountsService + walletService):
            // an {index, name} list plus which one is active.
            return respond({ accounts: [{ index: 0, name: 'Account 1' }], activeIndex: 0 });
          default:
            return respond({});
        }
      }
    },
    storage: {
      // popup.js's own getters (getDevNetworksEnabled/getCardBackground/
      // getCachedPortfolioTotal/getCachedNotificationsState) use the
      // CALLBACK form of chrome.storage.local.get — the stub must invoke
      // the callback or every one of those Promises hangs forever.
      local: {
        get: (keys, cb) => {
          if (typeof cb === 'function') cb({});
          return Promise.resolve({});
        },
        set: async () => {},
        remove: async () => {}
      },
      session: {
        get: (keys, cb) => {
          if (typeof cb === 'function') cb({});
          return Promise.resolve({});
        },
        set: async () => {},
        remove: async () => {}
      }
    },
    tabs: { create: () => {} }
  };
  globalThis.__FLUXIO_POPUP_TEST_HOOKS__ = true;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function importPopup() {
  await import(`${pathToFileURL(POPUP_PATH).href}?bust=${Math.random()}`);
  const hooks = globalThis.__FLUXIO_POPUP_HOOKS__;
  expect(hooks).toBeTruthy();
  expect(typeof hooks.renderWalletReady).toBe('function');
  // Let main()'s own import-time GET_STATUS render settle before the test
  // renders the home screen over it.
  await flush();
  return hooks;
}

/** A realistic unlocked-wallet shape — the two derived account addresses the home screen actually reads. */
function walletFixture() {
  return {
    accountIndex: 0,
    accounts: {
      solana: { address: 'BXDgbhyoYW1xTGzZbgEJd1nRpCBG9mdYQE9BPLPwpcU1' },
      evm: { address: '0x4B2c00fD7647780F1d21694Ce51feA235De7Ca39' }
    }
  };
}

describe('popup.js — home action row Activity button (0245)', () => {
  beforeEach(() => {
    installStubs();
  }, CLICK_TEST_TIMEOUT_MS);

  it('the header no longer carries an Activity button, and the action row is Send, Receive, Activity, Swap with no Buy left', async () => {
    const hooks = await importPopup();
    await hooks.renderWalletReady(walletFixture());
    const html = el('app').innerHTML;

    // Header segment: everything between the header-actions container and
    // the next card section. Refresh/Notifications/Settings/Lock stay;
    // Activity is gone from it entirely.
    const headerStart = html.indexOf('account-card__header-actions');
    const headerEnd = html.indexOf('account-card__total');
    expect(headerStart).toBeGreaterThan(-1);
    expect(headerEnd).toBeGreaterThan(headerStart);
    const header = html.slice(headerStart, headerEnd);
    expect(header).toContain('id="actionRefresh"');
    expect(header).toContain('id="actionNotifications"');
    expect(header).toContain('id="actionSettings"');
    expect(header).toContain('id="lockBtn"');
    expect(header).not.toContain('Activity');

    // Action row: order Send, Receive, Activity, Swap — and Buy is gone
    // from the whole screen (no id, no label, no toast text).
    const row = html.slice(html.indexOf('action-row'));
    const iSend = row.indexOf('id="actionSend"');
    const iReceive = row.indexOf('id="actionReceive"');
    const iActivity = row.indexOf('id="actionActivity"');
    const iSwap = row.indexOf('id="actionSwap"');
    expect(iSend).toBeGreaterThan(-1);
    expect(iReceive).toBeGreaterThan(iSend);
    expect(iActivity).toBeGreaterThan(iReceive);
    expect(iSwap).toBeGreaterThan(iActivity);
    expect(row).toContain('action-btn__label">Activity<');
    expect(html).not.toContain('actionBuy');
    expect(html).not.toContain('>Buy<');
    expect(html).not.toContain('Coming soon');
  }, CLICK_TEST_TIMEOUT_MS);

  it('clicking the action row Activity button opens the Activity screen (network picker)', async () => {
    const hooks = await importPopup();
    await hooks.renderWalletReady(walletFixture());
    expect(el('app').innerHTML).toContain('id="actionActivity"');

    el('actionActivity').click();
    await flush();
    await flush();

    const html = el('app').innerHTML;
    expect(html).toContain('<h1>Activity</h1>');
    expect(html).toContain('Choose a network.');
  }, CLICK_TEST_TIMEOUT_MS);
});
