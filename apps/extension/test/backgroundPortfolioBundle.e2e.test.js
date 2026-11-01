/**
 * Lightweight end-to-end sanity check for the portfolio-value feature's
 * new background.js message handlers (prompt 0118), through the ACTUAL
 * BUILT background.bundle.js — same reasoning/pattern as
 * backgroundAutoLockBundle.e2e.test.js (Revision 3 of prompt 0117):
 * `shared/portfolioValue.js` is a module background.js imports and this
 * bundle inlines at build time, so a source-only test (like
 * test/portfolioValue.test.js's own 35 unit tests) can't by itself prove
 * the DEPLOYED bundle actually wires it up correctly — only running the
 * real bundle through its real chrome.runtime.onMessage dispatcher can.
 * Applying that lesson proactively to a new feature, not just
 * retroactively to the bug that taught it.
 *
 * Deliberately narrow in scope compared to a full balance+price
 * integration test: FLUXIO_INTERNAL_GET_CURRENCY/SET_CURRENCY are plain
 * chrome.storage.local round trips (no wallet/RPC involved) and
 * FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE's locked-wallet rejection needs no
 * wallet either — both are cheap to verify against the real bundle
 * without standing up a full mocked wallet session + RPC + CoinGecko
 * harness, which is what packages/services/test/{priceService,
 * walletService,balanceService,tokenService}.test.js already cover at
 * the unit level, and what this file is not attempting to duplicate.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '..', 'background', 'background.bundle.js');
const EXTENSION_ID = 'mock-extension-id';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

/** Same minimal chrome.* mock shape as backgroundAutoLockBundle.e2e.test.js's own installFakeChromeForBackground() — duplicated rather than imported, since these are two independent, standalone test files (neither imports the other, matching every other test file in this repo). */
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
describe('background.bundle.js — portfolio-value handlers, end-to-end through the real chrome.runtime.onMessage pathway (prompt 0118)', () => {
  it('the built bundle exists on disk (run `pnpm build:extension` first if this fails)', () => {
    expect(existsSync(BUNDLE_PATH)).toBe(true);
  });

  it('FLUXIO_INTERNAL_GET_CURRENCY defaults to usd, and FLUXIO_INTERNAL_SET_CURRENCY persists a real round trip', async () => {
    const listeners = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    const initial = await send(listeners, 'FLUXIO_INTERNAL_GET_CURRENCY');
    expect(initial.error).toBeUndefined();
    expect(initial.response).toEqual({ currency: 'usd' });

    const setResult = await send(listeners, 'FLUXIO_INTERNAL_SET_CURRENCY', { currency: 'idr' });
    expect(setResult.error).toBeUndefined();
    expect(setResult.response).toEqual({ currency: 'idr' });

    const after = await send(listeners, 'FLUXIO_INTERNAL_GET_CURRENCY');
    expect(after.response).toEqual({ currency: 'idr' });

    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('FLUXIO_INTERNAL_SET_CURRENCY rejects an unsupported currency code (the real bundle\'s own validation, not just the pure module\'s)', async () => {
    const listeners = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    const result = await send(listeners, 'FLUXIO_INTERNAL_SET_CURRENCY', { currency: 'not-a-real-currency' });
    expect(result.error).toMatch(/Unsupported currency/);

    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE rejects with a locked-wallet error when no session is unlocked (never attempts a balance/price fetch for a locked session)', async () => {
    const listeners = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    const result = await send(listeners, 'FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE');
    expect(result.error).toMatch(/locked/i);

    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);
});

/**
 * Prompt 0212 — REPRO TEST, written to LOCK THE CORRECT BEHAVIOR (the
 * owner's requirement: the dashboard total = every priced mainnet asset,
 * tokens included). Against the CURRENT code this test FAILS, by design
 * — that failure IS the fase-1 proof of the bug: background.js's
 * fetchMainnetBalancesForPortfolio stores tokenService.getTokenBalances'
 * PLAIN ARRAY as tokenSettled.value, while portfolioValue.js's
 * accumulateTokens reads tokenSettled.value?.tokens (the
 * GET_TOKEN_BALANCES handler's { networkKey, tokens } response shape,
 * which never flows through this path) — so held tokens silently count
 * for nothing AND never reach excludedAssets either (no ⓘ badge).
 *
 * Numbers mirror the owner's real 5 Oktober screenshot: 0.031344 SOL +
 * 1.065279 USDC; mock prices solana=120, usd-coin=1. Correct total =
 * 0.031344×120 + 1.065279×1 = 4.826559 → "$4.83" with NO exclusions.
 * The buggy code answers "$3.76" (SOL only) with hasExcludedAssets
 * false — the dishonest silent-drop this prompt exists to fix.
 */
describe('background.bundle.js — portfolio total must include priced TOKENS (prompt 0212 repro, locks the CORRECT behavior)', () => {
  const REFERENCE_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  /** CoinGecko + every RPC the unlocked portfolio path touches. Unknown request = throw (nothing else may go out). `solanaTokenAccounts` overrides the default single-USDC account list; `bnbUsdtRaw` (prompt 0214) makes the BNB Chain registry USDT's balanceOf answer that raw hex amount instead of 0; `prices` overrides the CoinGecko response. */
  function installPortfolioFetchMock({ solanaTokenAccounts, bnbUsdtRaw, prices } = {}) {
    const capture = { urls: [], rpcMethods: [] };
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      capture.urls.push(u);
      if (u.startsWith('https://api.coingecko.com/api/v3/simple/price')) {
        return {
          ok: true,
          status: 200,
          json: async () => prices ?? { solana: { usd: 120 }, ethereum: { usd: 2000 }, binancecoin: { usd: 500 }, 'usd-coin': { usd: 1 } }
        };
      }
      const { method, params } = JSON.parse(options.body);
      capture.rpcMethods.push(method);
      if (method === 'getBalance') {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: 31344000 } }) };
      }
      if (method === 'getTokenAccountsByOwner') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: solanaTokenAccounts ?? [
                {
                  pubkey: 'TesterUsdcAta111111111111111111111111111111',
                  account: {
                    data: {
                      parsed: {
                        info: {
                          mint: USDC_MINT,
                          owner: params[0],
                          tokenAmount: { amount: '1065279', decimals: 6, uiAmountString: '1.065279' }
                        },
                        type: 'account'
                      },
                      program: 'spl-token'
                    }
                  }
                }
              ]
            }
          })
        };
      }
      if (method === 'eth_getBalance') {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x0' }) };
      }
      if (method === 'eth_call') {
        // Prompt 0214: the BNB Chain registry USDT's balanceOf can be
        // given a real balance; every other eth_call (Ethereum/Base
        // USDC, and bnb USDT when bnbUsdtRaw is unset) stays 0 and is
        // dropped by tokenService's own zero filter, as before.
        const callTo = (params?.[0]?.to || '').toLowerCase();
        const callData = params?.[0]?.data || '';
        if (bnbUsdtRaw && callTo === '0x55d398326f99059ff775485246999027b3197955' && callData.startsWith('0x70a08231')) {
          return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: `0x${BigInt(bnbUsdtRaw).toString(16).padStart(64, '0')}` }) };
        }
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: `0x${'0'.repeat(64)}` }) };
      }
      throw new Error(`Unexpected request in portfolio repro: ${method ?? u}`);
    };
    return capture;
  }

  it('GET_PORTFOLIO_VALUE: 0.031344 SOL @120 + 1.065279 USDC @1 -> "$4.83" with NO excluded assets (FAILS on current code: tokens silently dropped, "$3.76")', async () => {
    const listeners = installFakeChromeForBackground();
    // This file's minimal storage.local mock is callback-only; the
    // import-wallet path also uses the promise style — support both
    // here without touching the pre-existing harness above.
    const origGet = globalThis.chrome.storage.local.get;
    const origSet = globalThis.chrome.storage.local.set;
    globalThis.chrome.storage.local.get = (keys, cb) => (cb ? origGet(keys, cb) : new Promise((res) => origGet(keys, res)));
    globalThis.chrome.storage.local.set = (obj, cb) => (cb ? origSet(obj, cb) : new Promise((res) => origSet(obj, res)));
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);
    const imported = await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });
    expect(imported.error).toBeUndefined();

    const capture = installPortfolioFetchMock();
    const result = await send(listeners, 'FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE');
    expect(result.error).toBeUndefined();
    expect(capture.rpcMethods).toContain('getTokenAccountsByOwner'); // the token balances really were fetched...
    expect(result.response.totalFormatted).toBe('$4.83'); // ...so the priced USDC must be IN the total
    expect(result.response.hasExcludedAssets).toBe(false); // and nothing should be silently excluded
    // Opsi B (prompt 0212): the ONE batched CoinGecko call now carries
    // tether too — same single /simple/price URL, one more comma id.
    const priceUrl = capture.urls.find((u) => u.includes('simple/price'));
    expect(priceUrl).toContain('usd-coin');
    expect(priceUrl).toContain('tether');

    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('a held token with NO price source (foreign mint) -> hasExcludedAssets true (the popup badge shows), while the priced legs still sum (keputusan 3)', async () => {
    const listeners = installFakeChromeForBackground();
    const origGet = globalThis.chrome.storage.local.get;
    const origSet = globalThis.chrome.storage.local.set;
    globalThis.chrome.storage.local.get = (keys, cb) => (cb ? origGet(keys, cb) : new Promise((res) => origGet(keys, res)));
    globalThis.chrome.storage.local.set = (obj, cb) => (cb ? origSet(obj, cb) : new Promise((res) => origSet(obj, res)));
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);
    const imported = await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });
    expect(imported.error).toBeUndefined();

    const capture = installPortfolioFetchMock({
      solanaTokenAccounts: [
        {
          pubkey: 'ForeignAta1111111111111111111111111111111111',
          account: {
            data: {
              parsed: {
                info: {
                  mint: 'Mystery111111111111111111111111111111111111',
                  owner: 'x',
                  tokenAmount: { amount: '42', decimals: 0, uiAmountString: '42' }
                },
                type: 'account'
              },
              program: 'spl-token'
            }
          }
        }
      ]
    });
    const result = await send(listeners, 'FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE');
    expect(result.error).toBeUndefined();
    expect(result.response.totalFormatted).toBe('$3.76'); // SOL leg only — the foreign token has no price
    expect(result.response.hasExcludedAssets).toBe(true); // honest: popup.js shows the ⓘ badge from exactly this flag

    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  // Prompt 0214 (keputusan 5): the BNB Chain registry USDT — a REAL
  // tokenService end-to-end leg (mocked only at fetch), priced by its
  // own bridged CoinGecko id, must join the total with NO ⓘ. Mirrors
  // the owner's real 0213 holding: 2.99 USDT (raw 2.99e18 — the exact
  // on-chain figure reconciled in 0213 Revisi 3).
  it('GET_PORTFOLIO_VALUE: BNB Chain USDT 2.99 @ bridged id 1 joins the total ("$7.82") with NO excluded assets, and the ONE batch URL carries the bridged id + tether + usd-coin', async () => {
    const listeners = installFakeChromeForBackground();
    const origGet = globalThis.chrome.storage.local.get;
    const origSet = globalThis.chrome.storage.local.set;
    globalThis.chrome.storage.local.get = (keys, cb) => (cb ? origGet(keys, cb) : new Promise((res) => origGet(keys, res)));
    globalThis.chrome.storage.local.set = (obj, cb) => (cb ? origSet(obj, cb) : new Promise((res) => origSet(obj, res)));
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);
    const imported = await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });
    expect(imported.error).toBeUndefined();

    const capture = installPortfolioFetchMock({
      bnbUsdtRaw: 2990000000000000000n,
      prices: {
        solana: { usd: 120 },
        ethereum: { usd: 2000 },
        binancecoin: { usd: 500 },
        'usd-coin': { usd: 1 },
        tether: { usd: 1 },
        'binance-bridged-usdt-bnb-smart-chain': { usd: 1 }
      }
    });
    const result = await send(listeners, 'FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE');
    expect(result.error).toBeUndefined();
    // 0.031344 SOL x 120 + 1.065279 USDC x 1 + 2.99 USDT(BNB) x 1 = 7.816559
    expect(result.response.totalFormatted).toBe('$7.82');
    expect(result.response.hasExcludedAssets).toBe(false); // priced via the override — never the ⓘ badge
    const priceUrl = capture.urls.find((u) => u.includes('simple/price'));
    expect(priceUrl).toContain('binance-bridged-usdt-bnb-smart-chain');
    expect(priceUrl).toContain('tether');
    expect(priceUrl).toContain('usd-coin');

    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);
});
