/**
 * End-to-end regression test for FLUXIO_INTERNAL_RESET_WALLET (prompt
 * 0124 — "Forgot password?"), through the ACTUAL BUILT
 * background.bundle.js — same pattern as this directory's other
 * *Bundle.e2e.test.js files (backgroundAutoLockBundle, backgroundAddToken,
 * backgroundPortfolio): a new background.js message handler is only
 * "real" once it's proven to work through the DEPLOYED bundle's own
 * chrome.runtime.onMessage dispatcher, not just the unbundled source
 * (see backgroundAutoLockBundle.e2e.test.js's own header comment for the
 * Revision 3 bug this whole pattern exists to prevent from recurring).
 *
 * Unlike the other e2e-bundle files in this directory, this one needs a
 * chrome.storage.local mock that supports BOTH invocation styles real
 * Chrome (and this repo's own code) actually use — background.js's own
 * inline helpers (getCustomTokens, etc.) call it callback-style
 * (`get(keys, cb)`), while @fluxio/crypto/storage.js's vault backend and
 * @fluxio/services/accountsService.js's backend both call it promise-style
 * (`await chrome.storage.local.set(...)`, no callback) — this test is the
 * first in this directory to exercise a real create/import-wallet round
 * trip through the bundle, so it's the first to need both styles at once.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '..', 'background', 'background.bundle.js');
const EXTENSION_ID = 'mock-extension-id';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

const REFERENCE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * chrome.storage.local's get/set/remove all accept an OPTIONAL trailing
 * callback in real Chrome — call it when given one, otherwise return a
 * Promise. Every other e2e-bundle mock in this directory only implements
 * the callback form, which was sufficient for what they each exercise;
 * this test's full wallet-import round trip goes through the
 * promise-style callers too (see this file's own header comment).
 */
function installFakeChromeForBackground() {
  const localStore = new Map();
  const sessionStore = new Map();
  const listeners = {};
  // Recorded, not just stubbed (prompt 0124 Revision 1) — the reset
  // handler is required to explicitly clear the periodic auto-lock alarm
  // (see background.js's own FLUXIO_INTERNAL_RESET_WALLET comment for the
  // real bug this closes: removing the DURATION setting from
  // chrome.storage.local never touched the separate chrome.alarms
  // registration, which Chrome tracks entirely outside storage). Asserting
  // this requires knowing which alarm names were actually cleared, which a
  // bare `() => Promise.resolve(true)` stub can't reveal.
  const alarmCalls = { create: [], clear: [] };
  // Prompt 0170 — background.js now registers TWO independent
  // chrome.alarms.onAlarm listeners (auto-lock's own, plus the
  // notifications-inbox poller), matching real Chrome's own multi-
  // listener event semantics (every listener runs for every alarm; each
  // checks alarm.name itself and no-ops on a mismatch). The old
  // single-slot `listeners.onAlarm = fn` here silently OVERWROTE the
  // first-registered (auto-lock) listener with the second
  // (notifications) one — a real bug this prompt's own `pnpm test` run
  // caught: this file's own "clears the periodic auto-lock alarm on
  // reset" test below started invoking the WRONG listener. Fixed by
  // accumulating every registered listener and dispatching an alarm
  // event to all of them, same as a real browser would.
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
      create: (name, opts) => { alarmCalls.create.push({ name, opts }); return Promise.resolve(); },
      clear: (name) => { alarmCalls.clear.push(name); return Promise.resolve(true); }
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const result = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (localStore.has(k)) result[k] = localStore.get(k);
          });
          if (cb) {
            cb(result);
            return undefined;
          }
          return Promise.resolve(result);
        },
        set: (obj, cb) => {
          Object.entries(obj).forEach(([k, v]) => localStore.set(k, v));
          if (cb) {
            cb();
            return undefined;
          }
          return Promise.resolve();
        },
        remove: (keys, cb) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => localStore.delete(k));
          if (cb) {
            cb();
            return undefined;
          }
          return Promise.resolve();
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

  // Dispatches to every registered onAlarm listener, matching real
  // Chrome's own multi-listener semantics — see onAlarmListeners' own
  // comment above for why this replaced a single-slot assignment.
  listeners.onAlarm = (alarm) => Promise.all(onAlarmListeners.map((fn) => fn(alarm))).then(() => undefined);

  return { listeners, localStore, sessionStore, alarmCalls };
}

async function send(listeners, type, extra = {}) {
  const sender = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}popup/popup.html` };
  return new Promise((resolve) => {
    listeners.onMessage({ type, requestId: 'r1', ...extra }, sender, resolve);
  });
}

/**
 * Prompt 0194 — explicit per-test timeout for this file's four async
 * tests, replacing vitest's 5000ms default. Measured, not guessed: each
 * test re-imports the 858KB built bundle with a cache bust AND runs real
 * key derivation (PBKDF2 600k iterations per successful IMPORT_WALLET —
 * five across the file), while vitest runs this directory's seven
 * e2e-bundle files in parallel workers. Healthy-machine parallel runs
 * put the heaviest test at 3.0–3.7s (isolated: ~1.4s; with file
 * parallelism off: ~1.2s — the contention is real), so any extra load
 * pushes it past 5000ms: three full monorepo runs were lost to exactly
 * that (0189 one, 0193 two), and the flake was REPRODUCED on demand for
 * this fix (24 CPU burners + two extra suite instances → the same two
 * tests timed out at 5000ms). 30000ms is ~8x the worst healthy
 * measurement; nothing about the tests themselves changed.
 */
const E2E_TIMEOUT_MS = 30000;

describe('background.bundle.js — FLUXIO_INTERNAL_RESET_WALLET, end-to-end through the real chrome.runtime.onMessage pathway (prompt 0124)', () => {
  it('the built bundle exists on disk (run `pnpm build:extension` first if this fails)', () => {
    expect(existsSync(BUNDLE_PATH)).toBe(true);
  });

  it('erases the vault, session, accounts metadata, and every other tracked storage key — then a fresh import legitimately passes hasWallet()\'s own unmodified guard', async () => {
    const { listeners, localStore, sessionStore, alarmCalls } = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    // 1. Import a real wallet (exercises the real crypto stack, not a mock).
    const imported = await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });
    expect(imported.error).toBeUndefined();
    expect(imported.response.wallet.accounts.evm.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');

    // 2. Populate every OTHER tracked key this feature is responsible for
    // clearing, so the test actually proves something was removed rather
    // than trivially finding empty storage. Real message types where one
    // exists; direct storage writes for the plain preferences background.js
    // never wraps in a message (see prompt/0124's own storage-key
    // inventory — popup.js/settings.js write these directly).
    await send(listeners, 'FLUXIO_INTERNAL_ADD_ACCOUNT');
    await send(listeners, 'FLUXIO_INTERNAL_SET_AUTO_LOCK', { minutes: 30 });
    await send(listeners, 'FLUXIO_INTERNAL_SET_CURRENCY', { currency: 'idr' });
    // A real 30-minute setting means the periodic 1-minute check-alarm is
    // genuinely registered by this point (SET_AUTO_LOCK reprograms it) —
    // exactly the state in which the Revision 1 bug (alarm surviving a
    // reset) would actually matter.
    expect(alarmCalls.create.some((c) => c.name === 'fluxio-auto-lock-check')).toBe(true);
    alarmCalls.create.length = 0;
    alarmCalls.clear.length = 0;
    localStore.set('fluxio_custom_tokens', { solana: [{ address: 'Fakemint111', symbol: 'FAKE' }] });
    localStore.set('fluxio_tx_history', { solana: [{ hash: 'abc', amount: '1' }] });
    localStore.set('fluxio_portfolio_total_cache', { totalFormatted: '$123.45' });
    localStore.set('fluxio_developer_networks_enabled', true);
    localStore.set('fluxio_swap_slippage_bps', 250);
    localStore.set('fluxio_card_background', 'plain');

    expect(localStore.has('fluxio.vault.v1')).toBe(true);
    expect(localStore.has('fluxio.accounts.v1')).toBe(true);
    expect(sessionStore.has('fluxio.wallet-session.v1')).toBe(true);

    // 3. The actual reset.
    const reset = await send(listeners, 'FLUXIO_INTERNAL_RESET_WALLET');
    expect(reset.error).toBeUndefined();
    expect(reset.response).toEqual({ ok: true });

    // 3b. Revision 1 regression test: the periodic auto-lock alarm is
    // explicitly cleared, not left registered to fire forever on a
    // now-nonexistent wallet. Asserts the SAME mechanism
    // reprogramAutoLockAlarm()'s own "Never" branch uses
    // (chrome.alarms.clear(AUTO_LOCK_ALARM_NAME)) — not merely that
    // *some* alarm call happened.
    expect(alarmCalls.clear).toContain('fluxio-auto-lock-check');
    expect(alarmCalls.create).toEqual([]); // must not re-arm it either

    // 4. Every one of this feature's own tracked keys is gone.
    const clearedLocalKeys = [
      'fluxio.vault.v1',
      'fluxio.accounts.v1',
      'fluxio_custom_tokens',
      'fluxio_tx_history',
      'fluxio_auto_lock_minutes',
      'fluxio_portfolio_currency',
      'fluxio_portfolio_total_cache',
      'fluxio_developer_networks_enabled',
      'fluxio_swap_slippage_bps',
      'fluxio_card_background'
    ];
    for (const key of clearedLocalKeys) {
      expect(localStore.has(key)).toBe(false);
    }
    expect(sessionStore.has('fluxio.wallet-session.v1')).toBe(false);
    expect(sessionStore.has('fluxio.wallet-session.last-activity.v1')).toBe(false);

    // 5. Deliberately kept, per this feature's own reported reasoning
    // (not wallet-identifying, not misleading — see the prompt archive's
    // storage-key inventory table): the price cache is untouched.
    // (Not seeded in this test — asserting its ABSENCE either way would
    // prove nothing; this is documented here, not asserted, since the
    // real claim is "resetWallet never touches this key at all", which
    // the handler's own source is what actually guarantees it.)

    // 6. hasWallet() genuinely false — status reflects it.
    const status = await send(listeners, 'FLUXIO_INTERNAL_GET_STATUS');
    expect(status.response).toEqual({ hasWallet: false, isUnlocked: false, wallet: null });

    // 7. IMPORT_WALLET's own guard, completely unmodified, now legitimately
    // passes — proving this feature closed the door with a real delete,
    // not a bypass flag on the guard itself.
    const genMnemonic = await send(listeners, 'FLUXIO_INTERNAL_GENERATE_MNEMONIC', { wordCount: 12 });
    const freshImport = await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', {
      mnemonic: genMnemonic.response.mnemonic,
      password: 'a-different-password'
    });
    expect(freshImport.error).toBeUndefined();
    expect(freshImport.response.wallet.accounts.evm.address).toBeTruthy();

    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('is reachable — and succeeds — while the wallet is LOCKED, the entire point of "Forgot password?"', async () => {
    const { listeners, localStore, sessionStore } = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });
    const locked = await send(listeners, 'FLUXIO_INTERNAL_LOCK');
    expect(locked.response).toEqual({ isUnlocked: false });

    const statusBefore = await send(listeners, 'FLUXIO_INTERNAL_GET_STATUS');
    expect(statusBefore.response.isUnlocked).toBe(false);
    expect(statusBefore.response.hasWallet).toBe(true);

    const reset = await send(listeners, 'FLUXIO_INTERNAL_RESET_WALLET');
    expect(reset.error).toBeUndefined();
    expect(localStore.has('fluxio.vault.v1')).toBe(false);
    expect(sessionStore.has('fluxio.wallet-session.v1')).toBe(false);

    const statusAfter = await send(listeners, 'FLUXIO_INTERNAL_GET_STATUS');
    expect(statusAfter.response).toEqual({ hasWallet: false, isUnlocked: false, wallet: null });

    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('clears the periodic auto-lock alarm on reset (prompt 0124 Revision 1 — a real bug caught before manual testing: removing the AUTO_LOCK_STORAGE_KEY setting never touched the separate chrome.alarms registration, so the alarm kept firing once a minute forever, harmlessly no-op-ing on a wallet that no longer existed)', async () => {
    const { listeners, alarmCalls } = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    // Module load alone already registers the alarm (reprogramAutoLockAlarm()
    // runs once at worker start) — confirms the alarm genuinely exists
    // going into this test, not just "no calls happened either way".
    expect(alarmCalls.create.some((c) => c.name === 'fluxio-auto-lock-check')).toBe(true);

    await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });
    alarmCalls.create.length = 0;
    alarmCalls.clear.length = 0;

    await send(listeners, 'FLUXIO_INTERNAL_RESET_WALLET');

    expect(alarmCalls.clear).toEqual(['fluxio-auto-lock-check']);
    expect(alarmCalls.create).toEqual([]);

    // Concretely prove the alarm firing afterward is a harmless no-op —
    // not just "clear() was called", but that the handler behind it
    // tolerates the alarm still firing (e.g. a due alarm Chrome had
    // already queued before clear() took effect) without throwing, now
    // that there is no wallet at all to check.
    await expect(listeners.onAlarm({ name: 'fluxio-auto-lock-check' })).resolves.toBeUndefined();

    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('does not weaken IMPORT_WALLET\'s own existing-wallet guard when a wallet still exists (sanity check the guard itself is untouched by this feature)', async () => {
    const { listeners } = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });
    // No reset in between — the guard must still reject, exactly as before this feature existed.
    const secondImport = await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'another-password' });
    expect(secondImport.error).toMatch(/already exists/i);

    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);
});
