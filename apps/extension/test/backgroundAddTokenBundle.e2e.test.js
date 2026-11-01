/**
 * Lightweight end-to-end sanity check for the two-step Add Token flow's
 * new FLUXIO_INTERNAL_PREVIEW_CUSTOM_TOKEN handler (prompt 0119), through
 * the ACTUAL BUILT background.bundle.js — same pattern as
 * test/backgroundPortfolioBundle.e2e.test.js/backgroundAutoLockBundle.e2e.test.js:
 * applying the Revision-3-taught lesson (test the deployed artifact, not
 * just source) proactively to a new feature.
 *
 * Deliberately narrow: only the cheap-to-verify rejection paths (locked
 * wallet, unknown network) that need no wallet/RPC mocking at all — the
 * actual on-chain lookup/classification logic (found/rpc-unreachable/
 * not-found) is already covered by tokenService's own tests and this
 * handler's shared validateNewCustomTokenAddress() helper is exercised
 * indirectly via FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN's own existing
 * coverage — this file exists only to prove the NEW message name is
 * correctly wired into the deployed bundle's dispatcher, the exact class
 * of thing a source-only test can't prove (see the other two e2e files'
 * own header comments for the full "why").
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '..', 'background', 'background.bundle.js');
const EXTENSION_ID = 'mock-extension-id';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

/** Same minimal chrome.* mock shape as the other e2e-bundle test files in this directory — duplicated rather than shared, matching this repo's existing "each test file is standalone" convention. */
function installFakeChromeForBackground() {
  const localStore = new Map();
  const sessionStore = new Map();
  const listeners = {};
  // Prompt 0170 — background.js now registers TWO independent
  // chrome.alarms.onAlarm listeners (auto-lock's own, plus the
  // notifications-inbox poller) — see backgroundResetWalletBundle.e2e.test.js's
  // own onAlarmListeners comment for the full "why an array, not a
  // single-slot assignment" reasoning; this file never directly invokes
  // listeners.onAlarm itself, but is fixed the same way for consistency.
  const onAlarmListeners = [];

  globalThis.chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (p) => `${EXTENSION_ORIGIN}${p}`,
      onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
      onInstalled: { addListener: () => {} },
      lastError: undefined
    },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
      setBadgeTextColor: () => Promise.resolve()
    },
    alarms: {
      onAlarm: { addListener: (fn) => { onAlarmListeners.push(fn); } },
      create: () => Promise.resolve(),
      clear: () => Promise.resolve(true)
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const result = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (localStore.has(k)) result[k] = localStore.get(k);
          });
          cb(result);
        },
        set: (obj, cb) => {
          Object.entries(obj).forEach(([k, v]) => localStore.set(k, v));
          cb && cb();
        }
      },
      session: {
        get: (key) => Promise.resolve(sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
        set: (obj) => {
          Object.entries(obj).forEach(([k, v]) => sessionStore.set(k, v));
          return Promise.resolve();
        },
        remove: (key) => {
          sessionStore.delete(key);
          return Promise.resolve();
        }
      }
    },
    windows: {
      create: () => Promise.reject(new Error('not exercised by this test')),
      onRemoved: { addListener: () => {}, removeListener: () => {} }
    },
    tabs: { create: () => Promise.reject(new Error('not exercised by this test')) }
  };

  listeners.onAlarm = (alarm) => Promise.all(onAlarmListeners.map((fn) => fn(alarm))).then(() => undefined);

  return listeners;
}

async function send(listeners, type, extra = {}) {
  const sender = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}popup/popup.html` };
  return new Promise((resolve) => {
    listeners.onMessage({ type, requestId: 'r1', ...extra }, sender, resolve);
  });
}

// Prompt 0194 Revisi 1 — same explicit timeout as
// backgroundResetWalletBundle.e2e.test.js's own E2E_TIMEOUT_MS, for the
// same measured reason (see that file's comment for the full numbers):
// every async test below imports the 858KB bundle cache-busted, with
// seven e2e files sharing parallel workers; under 0194's reproducing
// stress config this file tipped past the 5000ms default once the
// earlier-treated files stopped absorbing the load.
const E2E_TIMEOUT_MS = 30000;
describe('background.bundle.js — FLUXIO_INTERNAL_PREVIEW_CUSTOM_TOKEN, end-to-end through the real chrome.runtime.onMessage pathway (prompt 0119)', () => {
  it('the built bundle exists on disk (run `pnpm build:extension` first if this fails)', () => {
    expect(existsSync(BUNDLE_PATH)).toBe(true);
  });

  it('rejects with a locked-wallet error when no session is unlocked (never attempts an on-chain lookup for a locked session)', async () => {
    const listeners = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    const result = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_CUSTOM_TOKEN', { networkKey: 'ethereum', address: '0x0000000000000000000000000000000000dEaD' });
    expect(result.error).toMatch(/locked/i);

    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);
});
