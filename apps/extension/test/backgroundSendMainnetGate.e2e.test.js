/**
 * Prompt 0173 — end-to-end regression test, through the ACTUAL BUILT
 * background.bundle.js (same pattern as this directory's other
 * *Bundle.e2e.test.js files — see backgroundAutoLockBundle.e2e.test.js's
 * own header comment for the Revision 3 bug this whole pattern exists to
 * prevent from recurring), proving FLUXIO_INTERNAL_SEND_TRANSFER's old
 * hard `network.isTestnet !== true` guard is genuinely gone from the
 * DEPLOYED bundle, not just the unbundled source.
 *
 * Investigated first, not assumed (see prompt/0173's own archive for the
 * full report): a repo-wide grep found NO pre-existing test anywhere that
 * exercised FLUXIO_INTERNAL_SEND_TRANSFER at all, let alone locked the old
 * mainnet-rejection behavior — so this file is new tests proving the new
 * behavior, not a modification of an old one.
 *
 * The network layer is mocked throughout (a fetch mock keyed by JSON-RPC
 * METHOD name only, not the exact endpoint URL — deliberately, since the
 * real bundle's own baked-in Solana mainnet RPC URL depends on whether
 * HELIUS_API_KEY was set in apps/extension/.env.local at build time on
 * whatever machine built the bundle under test; keying by method name
 * keeps this test portable across both cases). No real mainnet RPC call
 * is ever made.
 *
 * Both mainnet cases below use a genuinely zero balance rather than a
 * fully-mocked successful broadcast: this is deliberately the SAME
 * "insufficient balance, real validation, clear message" outcome
 * prompt 0173's own live VERIFIKASI produces in the real popup — proving
 * the exact thing that matters (the guard's own specific rejection is
 * gone, replaced by real balance/fee validation reaching a real,
 * different error) without needing to hand-roll a full transaction
 * broadcast mock for every network family.
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

// Well-known, always-valid literal recipient addresses — no bs58/ethers
// import needed (apps/extension has no direct dependency on either; only
// @fluxio/crypto does, transitively, and pnpm's strict node_modules
// isolation correctly refuses to let this test file reach into another
// package's own transitive dependency). The Solana System Program's own
// address (32 zero bytes, base58) passes `new PublicKey(...)` — Solana
// pubkeys have no checksum concept. The EVM address is plain all-lowercase
// hex — ethers' isAddress() only enforces EIP-55 checksum casing for a
// MIXED-case input, so an all-lowercase address always passes regardless
// of checksum (see evmTransactionService.js's own requireValidAddress).
const SOLANA_RECIPIENT = '11111111111111111111111111111111';
const EVM_RECIPIENT = '0x000000000000000000000000000000000000dead';

// A real base58 encoding of 32 zero bytes (the System Program's own id) —
// Solana blockhashes must decode to exactly 32 bytes, matching
// transactionService.test.js's own BLOCKHASH_RESULT fixture.
const SOLANA_BLOCKHASH_RESULT = { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000 } };
const EVM_BASE_FEE = 1_000_000_000n;
const EVM_PRIORITY_FEE = 1_500_000_000n;

/** Minimal chrome.* mock — same shape as backgroundResetWalletBundle.e2e.test.js's own (needs both callback- and promise-style chrome.storage.local, since a real IMPORT_WALLET round trip touches both). */
function installFakeChromeForBackground() {
  const localStore = new Map();
  const sessionStore = new Map();
  const listeners = {};
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
          if (cb) { cb(result); return undefined; }
          return Promise.resolve(result);
        },
        set: (obj, cb) => {
          Object.entries(obj).forEach(([k, v]) => localStore.set(k, v));
          if (cb) { cb(); return undefined; }
          return Promise.resolve();
        },
        remove: (keys, cb) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => localStore.delete(k));
          if (cb) { cb(); return undefined; }
          return Promise.resolve();
        }
      },
      session: {
        get: (key) => Promise.resolve(sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
        set: (obj) => { Object.entries(obj).forEach(([k, v]) => sessionStore.set(k, v)); return Promise.resolve(); },
        remove: (key) => { sessionStore.delete(key); return Promise.resolve(); }
      }
    },
    windows: {
      create: () => Promise.reject(new Error('not exercised by this test')),
      onRemoved: { addListener: () => {}, removeListener: () => {} }
    },
    tabs: { create: () => Promise.reject(new Error('not exercised by this test')) }
  };

  listeners.onAlarm = (alarm) => Promise.all(onAlarmListeners.map((fn) => fn(alarm))).then(() => undefined);

  return { listeners, localStore, sessionStore };
}

async function send(listeners, type, extra = {}) {
  const sender = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}popup/popup.html` };
  return new Promise((resolve) => {
    listeners.onMessage({ type, requestId: 'r1', ...extra }, sender, resolve);
  });
}

/** Method-keyed (not URL-keyed) RPC mock — see this file's own header comment for why. */
function mockRpcByMethod(responsesByMethod) {
  globalThis.fetch = async (url, options) => {
    const { method } = JSON.parse(options.body);
    const entry = responsesByMethod[method];
    if (!entry) throw new Error(`Unexpected RPC method ${method} against ${url}`);
    if (entry.reject) throw new Error(entry.reject);
    return { json: async () => entry.body };
  };
}

// Prompt 0194 Revisi 1 — same explicit timeout as
// backgroundResetWalletBundle.e2e.test.js's own E2E_TIMEOUT_MS, for the
// same measured reason (see that file's comment for the full numbers):
// every async test below imports the 858KB bundle cache-busted AND runs
// real key derivation, with seven e2e files sharing parallel workers;
// under 0194's reproducing stress config two of these tipped past the
// 5000ms default.
const E2E_TIMEOUT_MS = 30000;

describe('background.bundle.js — FLUXIO_INTERNAL_SEND_TRANSFER, mainnet gate lifted (prompt 0173)', () => {
  it('the built bundle exists on disk (run `pnpm build:extension` first if this fails)', () => {
    expect(existsSync(BUNDLE_PATH)).toBe(true);
  });

  it('mainnet Solana is no longer rejected by the old guard — a real balance check runs instead', async () => {
    const { listeners } = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    const imported = await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });
    expect(imported.error).toBeUndefined();

    mockRpcByMethod({
      getLatestBlockhash: { body: { jsonrpc: '2.0', id: 1, result: SOLANA_BLOCKHASH_RESULT } },
      getFeeForMessage: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000 } } },
      // A genuinely zero balance — the real validation this network now
      // reaches, exactly like every other configured network.
      getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 0 } } }
    });

    const result = await send(listeners, 'FLUXIO_INTERNAL_SEND_TRANSFER', {
      networkKey: 'solana',
      to: SOLANA_RECIPIENT,
      amount: '0.001'
    });

    expect(result.error).toBeDefined();
    expect(result.error).not.toMatch(/mainnet sending not enabled yet/i);
    expect(result.error).toMatch(/insufficient balance/i);
  }, E2E_TIMEOUT_MS);

  it('mainnet EVM (Base) is no longer rejected by the old guard — a real balance check runs instead', async () => {
    const { listeners } = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    const imported = await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });
    expect(imported.error).toBeUndefined();

    mockRpcByMethod({
      eth_getBlockByNumber: { body: { jsonrpc: '2.0', id: 1, result: { baseFeePerGas: `0x${EVM_BASE_FEE.toString(16)}` } } },
      eth_maxPriorityFeePerGas: { body: { jsonrpc: '2.0', id: 1, result: `0x${EVM_PRIORITY_FEE.toString(16)}` } },
      eth_getTransactionCount: { body: { jsonrpc: '2.0', id: 1, result: '0x0' } },
      // A genuinely zero balance — same reasoning as the Solana case above.
      eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: '0x0' } }
    });

    const result = await send(listeners, 'FLUXIO_INTERNAL_SEND_TRANSFER', {
      networkKey: 'base',
      to: EVM_RECIPIENT,
      amount: '0.001',
      // 0242 (penyelarasan sadar): plafon tampil kini WAJIB untuk Send EVM
      // (fail closed) — tes ini tetap menguji validasi saldo nyata, jadi
      // plafonnya dibuat besar supaya alur sampai ke cek saldo.
      displayedMaxFeeWei: '999000000000000000'
    });

    expect(result.error).toBeDefined();
    expect(result.error).not.toMatch(/mainnet sending not enabled yet/i);
    expect(result.error).toMatch(/insufficient balance/i);
  }, E2E_TIMEOUT_MS);

  it('(0242, catatan 18) Send EVM TANPA displayedMaxFeeWei ditolak fail closed — tidak ada broadcast, teks jujur', async () => {
    const { listeners } = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);
    const imported = await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });
    expect(imported.error).toBeUndefined();
    mockRpcByMethod({
      eth_getBlockByNumber: { body: { jsonrpc: '2.0', id: 1, result: { baseFeePerGas: `0x${EVM_BASE_FEE.toString(16)}` } } },
      eth_maxPriorityFeePerGas: { body: { jsonrpc: '2.0', id: 1, result: `0x${EVM_PRIORITY_FEE.toString(16)}` } },
      eth_getTransactionCount: { body: { jsonrpc: '2.0', id: 1, result: '0x0' } },
      eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: `0x${(10n ** 18n).toString(16)}` } },
      eth_sendRawTransaction: { body: { jsonrpc: '2.0', id: 1, result: '0xMustNeverBroadcast' } }
    });
    const result = await send(listeners, 'FLUXIO_INTERNAL_SEND_TRANSFER', {
      networkKey: 'base',
      to: EVM_RECIPIENT,
      amount: '0.001'
    });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/network fee is now higher than shown/i);
    // Fail closed terjadi SEBELUM service dipanggil: error di atas sudah
    // membuktikan tidak ada yang ditandatangani maupun di-broadcast
    // (mock eth_sendRawTransaction sengaja disediakan dan tak tersentuh).
  }, E2E_TIMEOUT_MS);

  it('testnet (solana-devnet) still works end to end — a fully-mocked send still produces a real signature', async () => {
    const { listeners } = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    const imported = await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });
    expect(imported.error).toBeUndefined();

    mockRpcByMethod({
      getLatestBlockhash: { body: { jsonrpc: '2.0', id: 1, result: SOLANA_BLOCKHASH_RESULT } },
      getFeeForMessage: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000 } } },
      getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 10_000_000 } } },
      sendTransaction: { body: { jsonrpc: '2.0', id: 1, result: 'FakeSignature111' } }
    });

    const result = await send(listeners, 'FLUXIO_INTERNAL_SEND_TRANSFER', {
      networkKey: 'solana-devnet',
      to: SOLANA_RECIPIENT,
      amount: '0.001'
    });

    expect(result.error).toBeUndefined();
    // FLUXIO_INTERNAL_SEND_TRANSFER's own response shape is `{ hash, explorerUrl }`
    // for every chain family alike (a Solana signature included) — see
    // that handler's own `return { hash: signature, explorerUrl }`.
    expect(result.response.hash).toBe('FakeSignature111');
  }, E2E_TIMEOUT_MS);

  it('an unknown network is still rejected — with a clear "unknown network" message, not the old guard text', async () => {
    const { listeners } = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);
    await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });

    const result = await send(listeners, 'FLUXIO_INTERNAL_SEND_TRANSFER', {
      networkKey: 'not-a-real-network',
      to: SOLANA_RECIPIENT,
      amount: '0.001'
    });
    expect(result.error).toMatch(/unknown network/i);
  }, E2E_TIMEOUT_MS);
});

// Prompt 0200 — CONSCIOUS REVISION of the 0115-era lock (this block used
// to assert an unconditional SWAP_EXECUTION_DISABLED throw; that guard is
// now replaced by real conditions, so the lock's job changes with it:
// prove the OLD unconditional text is gone AND the new gates hold. Still
// a completely separate gate from SEND_TRANSFER, never keyed on
// isTestnet. The full success/fee/simulation matrix lives in
// backgroundSwapExecute.e2e.test.js.
describe('background.bundle.js — FLUXIO_INTERNAL_EXECUTE_SWAP, real conditions replacing the old unconditional guard (prompt 0200)', () => {
  it('a locked session is refused with SWAP_LOCKED — not the old SWAP_EXECUTION_DISABLED text', async () => {
    const { listeners } = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);

    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: 'any', networkKey: 'solana' });
    expect(result.error).toMatch(/SWAP_LOCKED/);
    expect(result.error).not.toMatch(/SWAP_EXECUTION_DISABLED/);
  }, E2E_TIMEOUT_MS);

  it('a non-mainnet network (solana-devnet) is refused with SWAP_NETWORK_UNSUPPORTED — Jupiter is mainnet-only', async () => {
    const { listeners } = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);
    await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });

    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: 'any', networkKey: 'solana-devnet' });
    expect(result.error).toMatch(/SWAP_NETWORK_UNSUPPORTED/);
  }, E2E_TIMEOUT_MS);

  it('an unknown/expired quoteId on mainnet is refused with SWAP_QUOTE_EXPIRED — quotes are background-minted, never client-supplied', async () => {
    const { listeners } = installFakeChromeForBackground();
    await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);
    await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });

    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: 'never-minted', networkKey: 'solana' });
    expect(result.error).toMatch(/SWAP_QUOTE_EXPIRED/);
  }, E2E_TIMEOUT_MS);
});
