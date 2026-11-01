/**
 * End-to-end regression test for the Revision 3 bug: a "1 minute"
 * auto-lock option was added to shared/autoLockDecision.js's
 * AUTO_LOCK_OPTIONS_MINUTES (Revision 2), but real Chrome manual
 * verification found the popup's own "Invalid auto-lock duration: 1"
 * error — the UNBUNDLED source was correct (background.js imports and
 * validates against the live AUTO_LOCK_OPTIONS_MINUTES export, no
 * hardcoded duplicate anywhere — confirmed by grep, see this file's own
 * commit message / prompt/0117-auto-lock-timer.md's Revision 3 section),
 * but background.js is never RUN as source in the real extension — only
 * background/background.bundle.js (an esbuild IIFE bundle, see
 * build.mjs) is. esbuild inlines shared/autoLockDecision.js's content
 * into that bundle AT BUILD TIME — editing the shared source file after
 * the last build leaves a stale, frozen copy of
 * AUTO_LOCK_OPTIONS_MINUTES inside the bundle until the NEXT
 * `pnpm build:extension` run.
 *
 * Every other test in this repo (including the existing
 * autoLockDecision.test.js) imports shared/autoLockDecision.js directly
 * — the live, always-current SOURCE — so none of them could ever have
 * caught this: they'd pass identically whether or not the bundle had
 * been rebuilt, because they never touch the bundle at all. This is
 * exactly the gap that let the bug ship. This test instead loads and
 * evaluates the ACTUAL BUILT background.bundle.js (the real deployed
 * artifact — what a real Chrome service worker actually runs) and drives
 * it through the exact same chrome.runtime.onMessage pathway
 * popup.js's/settings.js's own sendInternal() triggers in a real
 * browser, so it fails whenever the bundle is stale relative to source —
 * the precise failure mode this bug was.
 *
 * Trade-off, reported honestly: this test can only be as fresh as
 * whatever background.bundle.js currently exists on disk — `pnpm test`
 * does not itself run `pnpm build:extension` first (no pretest hook
 * exists in this repo). Editing shared/autoLockDecision.js and running
 * `pnpm test` WITHOUT an intervening `pnpm build:extension` will
 * reproduce a failure here — which is a feature, not a limitation: it's
 * the exact reproduction of this bug, surfaced as a red test instead of
 * a real-Chrome bug report next time.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { AUTO_LOCK_OPTIONS_MINUTES } from '../shared/autoLockDecision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '..', 'background', 'background.bundle.js');
const EXTENSION_ID = 'mock-extension-id';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

/**
 * A minimal chrome.* mock covering exactly what background.js touches at
 * module-evaluation time (chrome.runtime.getURL, chrome.alarms.onAlarm,
 * chrome.storage.local, chrome.runtime.onMessage) plus chrome.storage.session
 * (walletService's session backend, hit by the dispatcher's own
 * hydrateSessionIfNeeded()/recordActivity() on every internal message —
 * see packages/services/walletService.js). Not a full chrome mock — only
 * what's needed for the module to load cleanly and for
 * FLUXIO_INTERNAL_SET_AUTO_LOCK specifically to be driveable end-to-end;
 * chrome.windows/tabs are stubbed just enough not to throw if touched,
 * since this test never exercises the approval-popup paths.
 */
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

// Prompt 0194 Revisi 1 — same explicit timeout as
// backgroundResetWalletBundle.e2e.test.js's own E2E_TIMEOUT_MS, for the
// same measured reason (see that file's comment for the full numbers):
// every async test below imports the 858KB bundle cache-busted (no key
// derivation here — the bundle import alone is the dominant cost), with
// seven e2e files sharing parallel workers; under 0194's reproducing
// stress config one of these tipped past the 5000ms default.
const E2E_TIMEOUT_MS = 30000;

describe('background.bundle.js — FLUXIO_INTERNAL_SET_AUTO_LOCK, end-to-end through the real chrome.runtime.onMessage pathway (Revision 3 regression test)', () => {
  it('the built bundle exists on disk (run `pnpm build:extension` first if this fails)', () => {
    expect(existsSync(BUNDLE_PATH)).toBe(true);
  });

  it.each(AUTO_LOCK_OPTIONS_MINUTES)(
    'accepts %s — every currently-defined AUTO_LOCK_OPTIONS_MINUTES value — through the DEPLOYED bundle\'s own onMessage dispatcher, not just the unbundled source',
    async (minutes) => {
      const listeners = installFakeChromeForBackground();
      // Cache-busting query so a fresh evaluation happens if this bundle
      // was rebuilt between test runs within the same vitest worker.
      await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

      expect(typeof listeners.onMessage).toBe('function');

      const sender = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}popup/popup.html` };
      const response = await new Promise((resolve) => {
        listeners.onMessage(
          { type: 'FLUXIO_INTERNAL_SET_AUTO_LOCK', requestId: 'r1', minutes },
          sender,
          resolve
        );
      });

      // The actual Revision 3 bug: the bundle's own frozen copy of
      // AUTO_LOCK_OPTIONS_MINUTES didn't include a value the UI's own
      // <select> (built from the SAME shared list) could legitimately
      // send — the dispatcher threw "Invalid auto-lock duration: <n>"
      // for a value that was, by construction, always one of the values
      // this exact parametrized list contains.
      expect(response.error).toBeUndefined();
      expect(response.response).toEqual({ minutes });

      delete globalThis.chrome;
    },
    E2E_TIMEOUT_MS
  );

  it('rejects a value that genuinely is NOT one of the configured options (sanity check the validation still rejects real garbage, not just proving it now accepts everything)', async () => {
    const listeners = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    const sender = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}popup/popup.html` };
    const response = await new Promise((resolve) => {
      listeners.onMessage(
        { type: 'FLUXIO_INTERNAL_SET_AUTO_LOCK', requestId: 'r1', minutes: 999 },
        sender,
        resolve
      );
    });

    expect(response.error).toMatch(/Invalid auto-lock duration/);
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);
});
