/**
 * Prompt 0200 — the swap-execution matrix, through the ACTUAL BUILT
 * background.bundle.js (same harness pattern as this directory's other
 * *e2e.test.js files; chrome mock copied from
 * backgroundSendMainnetGate.e2e.test.js). No real network is ever
 * touched: Jupiter's REST endpoints AND the Solana JSON-RPC methods are
 * all served by one fetch mock, and the "swap transaction" it returns is
 * a real, hand-assembled v0 VersionedTransaction (this test file cannot
 * import @solana/web3.js — apps/extension has no direct dependency on it
 * and pnpm's strict isolation correctly refuses transitive reach-ins, the
 * same constraint backgroundSendMainnetGate documents for bs58/ethers —
 * so the bytes are laid out by hand per the documented wire format:
 * shortvec sig count + 64-byte placeholder + 0x80 version prefix +
 * header + static keys + blockhash + instructions + empty address-table
 * lookups; prompt 0199 proved the bundle-side deserialize/sign/reserialize
 * path against a REAL Jupiter transaction).
 *
 * The wallet is the reference mnemonic's deterministic Solana account:
 * HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk — its 32 pubkey bytes are
 * hardcoded below (derived once via @fluxio/crypto from the same
 * REFERENCE_MNEMONIC; deterministic, so safe to pin) and used as the mock
 * transaction's fee payer so the bundle's identity fence passes.
 *
 * Fee-path injection: swapService's SWAP_FEE_ACCOUNTS is a frozen source
 * constant a bundle test cannot reach into, so background.js reads a
 * test-only override from globalThis (set BEFORE the bundle import, the
 * exact same channel the chrome.* mock itself already uses) — see
 * SWAP_FEE_ACCOUNTS_OVERRIDE's own comment in background.js.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '..', 'background', 'background.bundle.js');
const EXTENSION_ID = 'mock-extension-id';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
const REFERENCE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// The reference mnemonic's own Solana account 0 (m/44'/501'/0'/0') —
// base58 address + the same 32 raw pubkey bytes.
const REF_SOL_ADDRESS = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const REF_SOL_PUBKEY_BYTES = [
  240, 54, 39, 98, 70, 167, 91, 157, 227, 52, 158, 212, 43, 21, 226, 50,
  246, 81, 143, 194, 15, 95, 205, 79, 29, 100, 232, 31, 155, 210, 88, 247
];

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FEE_ACCOUNT = 'HM2tV6hdcRFvPkcspwWvs9KU7rwKTyEa6UXGPc6v6TFy'; // arbitrary valid base58, never a real account

// Prompt 0209 fee-account guard: the bundle verifies a fee pair's
// account on chain (getAccountInfo jsonParsed) against the REAL
// swapService.SWAP_FEE_ACCOUNT_OWNER constant and the pair's fee mint —
// so every mock must be able to answer getAccountInfo, and the DEFAULT
// answer must be VALID so every pre-guard test stays green unchanged.
const FEE_ACCOUNT_OWNER = 'FnjdJcYsQShxUTPJjgVnjjvw5kKsVwfxtFCWBJMjPiwQ'; // = swapService.SWAP_FEE_ACCOUNT_OWNER (locked by packages/services' own tests)
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** A getAccountInfo `value` shaped exactly like the real treasury ATA's live jsonParsed answer (prompt 0209 fase 1's read-only proof). */
function validFeeAccountInfoValue(mint = USDC_MINT, owner = FEE_ACCOUNT_OWNER) {
  return {
    data: {
      parsed: {
        info: { isNative: false, mint, owner, state: 'initialized', tokenAmount: { amount: '480925', decimals: 6, uiAmount: 0.480925, uiAmountString: '0.480925' } },
        type: 'account'
      },
      program: 'spl-token',
      space: 165
    },
    executable: false,
    lamports: 1488440,
    owner: TOKEN_PROGRAM_ID,
    rentEpoch: 0,
    space: 165
  };
}

const E2E_TIMEOUT_MS = 30000; // prompt 0194's measured pattern, same as every sibling e2e file

/** Chrome mock — copied from backgroundSendMainnetGate.e2e.test.js (see its comment). */
function installFakeChromeForBackground() {
  const localStore = new Map();
  const sessionStore = new Map();
  const listeners = {};
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
    // Tahap C (prompt 0223): alarm listeners are CAPTURED so a test can
    // fire the re-broadcast alarm wake path for real (they were dropped
    // before — no earlier test needed to drive that path explicitly).
    alarms: { onAlarm: { addListener: (fn) => { (listeners.onAlarm ||= []).push(fn); } }, create: () => Promise.resolve(), clear: () => Promise.resolve(true) },
    storage: {
      local: {
        get: (keys, cb) => {
          const result = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (localStore.has(k)) result[k] = localStore.get(k); });
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
    windows: { create: () => Promise.reject(new Error('not exercised')), onRemoved: { addListener: () => {}, removeListener: () => {} } },
    tabs: { create: () => Promise.reject(new Error('not exercised')) }
  };
  return { listeners, localStore, sessionStore };
}

async function send(listeners, type, extra = {}) {
  const sender = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}popup/popup.html` };
  return new Promise((resolve) => {
    listeners.onMessage({ type, requestId: 'r1', ...extra }, sender, resolve);
  });
}

/**
 * Hand-assembled v0 VersionedTransaction (see this file's header): fee
 * payer = `feePayerBytes`, one required signature, one System-Program
 * transfer instruction, no address-table lookups. Every length below is
 * < 128, so the shortvec encoding is a single plain byte.
 */
function buildUnsignedV0TxBase64(feePayerBytes) {
  const bytes = [];
  bytes.push(1); // shortvec: 1 signature slot
  for (let i = 0; i < 64; i++) bytes.push(0); // placeholder signature
  bytes.push(0x80); // v0 message version prefix
  bytes.push(1, 0, 1); // header: 1 required sig, 0 readonly-signed, 1 readonly-unsigned
  bytes.push(2); // shortvec: 2 static account keys
  bytes.push(...feePayerBytes); // key 0: fee payer (writable signer)
  for (let i = 0; i < 32; i++) bytes.push(0); // key 1: System Program (all zeros)
  for (let i = 0; i < 32; i++) bytes.push(1); // recent blockhash (arbitrary 32 bytes)
  bytes.push(1); // shortvec: 1 instruction
  bytes.push(1); // program id index -> key 1 (System Program)
  bytes.push(2, 0, 0); // shortvec: 2 account indices, both key 0 (self-transfer)
  bytes.push(12, 2, 0, 0, 0, 232, 3, 0, 0, 0, 0, 0, 0); // shortvec len 12 + u32le 2 (Transfer) + u64le 1000 lamports
  bytes.push(0); // shortvec: 0 address table lookups
  return Buffer.from(bytes).toString('base64');
}

// The REFERENCE wallet's own USDC ATA + the Associated Token Program id,
// as raw 32-byte keys (derived once, deterministically, from
// REF_SOL_ADDRESS + the USDC mint + the classic token program — the
// base58 form is 5N3f1tj9v1vc5TUZ8S7mCAnVmjVKrfnzXWhxLaxyZAgt). Used by
// the prompt-0205 rent tests: a build whose ATA-program instruction
// references this exact account is "this swap creates the user's output
// ATA" to detectNewAtaCreation.
const REF_USDC_ATA_BYTES = [
  64, 210, 242, 124, 70, 31, 41, 233, 254, 186, 26, 184, 172, 211, 148, 150,
  169, 198, 91, 10, 230, 42, 113, 63, 1, 249, 65, 169, 147, 191, 85, 237
];
const ATA_PROGRAM_BYTES = [
  140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131,
  11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89
];

/** Same hand-assembled v0 shape as above, plus an ATA-program CreateIdempotent instruction referencing the REF wallet's USDC ATA — the "this swap will create the output token account" case (prompt 0205). */
function buildUnsignedV0TxWithAtaCreateBase64(feePayerBytes) {
  const bytes = [];
  bytes.push(1); // shortvec: 1 signature slot
  for (let i = 0; i < 64; i++) bytes.push(0);
  bytes.push(0x80); // v0 prefix
  bytes.push(1, 0, 2); // header: 1 required sig, 0 readonly-signed, 2 readonly-unsigned
  bytes.push(4); // shortvec: 4 static account keys
  bytes.push(...feePayerBytes); // key 0: fee payer
  bytes.push(...REF_USDC_ATA_BYTES); // key 1: the output ATA being created
  for (let i = 0; i < 32; i++) bytes.push(0); // key 2: System Program
  bytes.push(...ATA_PROGRAM_BYTES); // key 3: Associated Token Program
  for (let i = 0; i < 32; i++) bytes.push(1); // recent blockhash
  bytes.push(2); // shortvec: 2 instructions
  bytes.push(2); // ix 1: program id index -> key 2 (System Program)
  bytes.push(2, 0, 0); // 2 account indices, both key 0
  bytes.push(12, 2, 0, 0, 0, 232, 3, 0, 0, 0, 0, 0, 0);
  bytes.push(3); // ix 2: program id index -> key 3 (ATA Program)
  bytes.push(2, 0, 1); // 2 account indices: payer, the new ATA
  bytes.push(1, 1); // shortvec len 1 + data [1] = CreateIdempotent
  bytes.push(0); // 0 address table lookups
  return Buffer.from(bytes).toString('base64');
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function quoteBody(withFee) {
  return {
    inputMint: SOL_MINT,
    inAmount: '10000000',
    outputMint: USDC_MINT,
    outAmount: '1008265',
    otherAmountThreshold: '1003224',
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0',
    routePlan: [],
    ...(withFee ? { platformFee: { amount: '8643', feeBps: 85 } } : {})
  };
}

/**
 * One fetch mock for BOTH the Jupiter REST endpoints and the Solana
 * JSON-RPC methods the execute path reaches. `capture` records what the
 * bundle actually asked for, so tests assert on real requests.
 */
function installSwapFetchMock({ withFeeQuote = false, simulateValue, sendBehavior, statusValue, blockHeight, feePayerBytes = REF_SOL_PUBKEY_BYTES, buildTransactionBase64, transactionValue, quoteSequence, verifiedList, tokenAccountsValue, feeAccountInfoValue, feeAccountMint, buildFailure, capture }) {
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u === 'https://lite-api.jup.ag/tokens/v2/tag?query=verified') {
      // Prompt 0206 butir 2: GET_SWAP_TOKENS' verified list — the
      // snapshot source. Raw v2 shape (id/icon), same as the live API.
      capture.verifiedListFetches = (capture.verifiedListFetches || 0) + 1;
      return jsonResponse(verifiedList ?? []);
    }
    if (u.startsWith('https://lite-api.jup.ag/swap/v1/quote')) {
      capture.quoteUrls.push(u);
      // quoteSequence (prompt 0205 Revisi 4): per-call quote bodies —
      // EXECUTE_SWAP re-quotes at Confirm, so tests can hand the display
      // quote and the fresh quote different numbers (clamped to the last
      // entry; an Error entry makes that call fail).
      if (Array.isArray(quoteSequence) && quoteSequence.length > 0) {
        const item = quoteSequence[Math.min(capture.quoteUrls.length - 1, quoteSequence.length - 1)];
        if (item instanceof Error) throw item;
        return jsonResponse(item);
      }
      return jsonResponse(quoteBody(withFeeQuote));
    }
    if (u === 'https://lite-api.jup.ag/swap/v1/swap') {
      capture.swapBuildBody = JSON.parse(options.body);
      capture.swapBuildBodies.push(capture.swapBuildBody); // every build in order (prompt 0206 butir 5: preview vs execute parity)
      if (buildFailure) {
        // Prompt 0209: a Jupiter build rejection, shaped like the real
        // 400 the fee guard exists for (0199's live-proven body shape).
        return { ok: false, status: 400, json: async () => ({ error: 'fee account is not initialized', errorCode: 'NOT_SUPPORTED' }) };
      }
      return jsonResponse({
        swapTransaction: buildTransactionBase64 ?? buildUnsignedV0TxBase64(feePayerBytes),
        prioritizationFeeLamports: 56000,
        computeUnitLimit: 1400000,
        lastValidBlockHeight: 1000
      });
    }
    const { method, params } = JSON.parse(options.body);
    capture.rpcMethods.push(method);
    if (method === 'simulateTransaction') {
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { value: simulateValue ?? { err: null, logs: [], unitsConsumed: 5000 } } });
    }
    if (method === 'sendTransaction') {
      if (sendBehavior?.reject) throw new Error(sendBehavior.reject);
      capture.sentRawTx = params[0];
      capture.sendOptions = params[1];
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: sendBehavior?.signature ?? 'FakeSwapSig1' });
    }
    if (method === 'getSignatureStatuses') {
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { value: [statusValue ?? null] } });
    }
    if (method === 'getBlockHeight') {
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: blockHeight ?? 999 });
    }
    if (method === 'getEpochInfo') {
      // Expiry verdicts read getEpochInfo since prompt 0203 Revisi 2
      // (self-sanity-checkable: blockHeight + absoluteSlot in one
      // answer). A healthy mainnet-shaped response: slot ~22M above the
      // block height, well past the sanity fence's 1M minimum gap.
      const bh = blockHeight ?? 999;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { blockHeight: bh, absoluteSlot: bh + 22_000_000, epoch: 1035, slotIndex: 1 } });
    }
    if (method === 'getSignaturesForAddress') {
      // GET_HISTORY's chain-history fetch (prompt 0203 Revisi 1's
      // piggyback tests) — no chain entries, the exact incident shape.
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: [] });
    }
    if (method === 'getTokenAccountsByOwner') {
      // GET_TOKEN_BALANCES' Solana discovery (prompt 0206 butir 2's
      // snapshot-naming tests) — jsonParsed account shapes.
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { value: tokenAccountsValue ?? [] } });
    }
    if (method === 'getMinimumBalanceForRentExemption') {
      // Prompt 0205: the LIVE rent figure, matching the chain's real
      // 1,488,440 (never the stale 2,039,280).
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: 1488440 });
    }
    if (method === 'getAccountInfo') {
      // Prompt 0209 fee-account guard. `feeAccountInfoValue`: undefined
      // -> the default VALID treasury-ATA shape (pre-guard tests stay
      // green); null/object -> used verbatim as `value`; a FUNCTION is
      // re-evaluated per request (stateful scenarios: valid-then-gone),
      // and may throw to simulate a transport failure on every endpoint.
      capture.accountInfoCalls = (capture.accountInfoCalls || 0) + 1;
      capture.accountInfoAddresses = capture.accountInfoAddresses || [];
      capture.accountInfoAddresses.push(params[0]);
      const value =
        typeof feeAccountInfoValue === 'function'
          ? feeAccountInfoValue()
          : feeAccountInfoValue !== undefined
            ? feeAccountInfoValue
            : validFeeAccountInfoValue(feeAccountMint ?? USDC_MINT);
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 451343619 }, value } });
    }
    if (method === 'getTransaction') {
      // Prompt 0205: the real-received fetch. `transactionValue` answers
      // every endpoint — a FUNCTION is re-evaluated per request (the
      // Revisi 1 fake-timer tests flip availability by clock); default
      // null = "not retained here" (no error). The per-endpoint
      // null-then-data fallthrough is covered by the endpoint-injected
      // unit test in packages/services (a keyless build's bundle only
      // has ONE Solana endpoint, so it can't be exercised
      // deterministically at this level).
      const value = typeof transactionValue === 'function' ? transactionValue() : (transactionValue ?? null);
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: value });
    }
    throw new Error(`Unexpected RPC method ${method} against ${u}`);
  };
  return capture;
}

function newCapture() {
  return { quoteUrls: [], rpcMethods: [], swapBuildBody: null, swapBuildBodies: [], sentRawTx: null, sendOptions: null, verifiedListFetches: 0 };
}

async function importFreshBundle() {
  await import(`${pathToFileURL(BUNDLE_PATH).href}?bust=${Math.random()}`);
}

async function importWallet(listeners) {
  const imported = await send(listeners, 'FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: REFERENCE_MNEMONIC, password: 'a-password' });
  expect(imported.error).toBeUndefined();
}

const QUOTE_PARAMS = {
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  amount: '0.01',
  inputDecimals: 9,
  outputDecimals: 6,
  slippageBps: 50,
  inputSymbol: 'SOL',
  outputSymbol: 'USDC'
};

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__;
  delete globalThis.fetch;
});

describe('background.bundle.js — FLUXIO_INTERNAL_EXECUTE_SWAP end to end (prompt 0200)', () => {
  it('NO-FEE success: quote has no platformFeeBps, build gets no feeAccount, simulate runs before send, a swap Activity entry is written', async () => {
    // Inject an EMPTY map explicitly (prompt 0203): the PRODUCTION
    // SWAP_FEE_ACCOUNTS is no longer empty (it carries the real USDC ->
    // treasury-ATA entry), so this test's no-fee premise now needs the
    // same globalThis injection seam the FEE test below already uses —
    // it exercises "no entry on either side resolves no fee", not "the
    // shipping map happens to be empty".
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = {};
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    expect(capture.quoteUrls[0]).not.toContain('platformFeeBps'); // injected empty map -> no fee requested
    expect(quote.response.quoteId).toBeDefined();
    expect(quote.response.feeIncluded).toBe(false);
    expect(quote.response.feeSide).toBeNull();

    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    expect(result.response.signature).toBe('FakeSwapSig1');
    expect(result.response.prioritizationFeeLamports).toBe(56000);
    expect(result.response.computeUnitLimit).toBe(1400000);
    expect(result.response.lastValidBlockHeight).toBe(1000);
    expect(result.response.explorerUrl).toContain('FakeSwapSig1');

    // The mandated fence order actually held: identity is free, then ONE
    // simulate, THEN the send — in that order.
    expect(capture.swapBuildBody.userPublicKey).toBe(REF_SOL_ADDRESS);
    expect(capture.swapBuildBody.feeAccount).toBeUndefined();
    expect(capture.rpcMethods.indexOf('simulateTransaction')).toBeGreaterThanOrEqual(0);
    expect(capture.rpcMethods.indexOf('simulateTransaction')).toBeLessThan(capture.rpcMethods.indexOf('sendTransaction'));
    expect(capture.sendOptions).toMatchObject({ encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    // The broadcast bytes carry a REAL signature now (not the 64-zero
    // placeholder the mock handed back).
    const sentBytes = Buffer.from(capture.sentRawTx, 'base64');
    expect(sentBytes.subarray(1, 65).every((b) => b === 0)).toBe(false);

    const history = localStore.get('fluxio_tx_history');
    const entry = history.solana[0];
    // Raw entry JSON, quoted in the phase-1 report:
    console.log('[0200 e2e] swap Activity entry (no fee):', JSON.stringify(entry));
    expect(entry).toMatchObject({
      networkKey: 'solana',
      type: 'swap',
      signatureOrHash: 'FakeSwapSig1',
      inputMint: SOL_MINT,
      inputSymbol: 'SOL',
      inputAmountRaw: '10000000',
      inputDecimals: 9,
      outputMint: USDC_MINT,
      outputSymbol: 'USDC',
      outputAmountRaw: '1008265',
      outputDecimals: 6,
      otherAmountThresholdRaw: '1003224',
      platformFee: null,
      status: 'pending',
      lastValidBlockHeight: 1000
    });
  }, E2E_TIMEOUT_MS);

  it('FEE success (SWAP_FEE_ACCOUNTS injected): quote carries platformFeeBps=85, build carries the SAME feeAccount, the entry records the platform fee', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = { [USDC_MINT]: FEE_ACCOUNT };
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ withFeeQuote: true, capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    expect(capture.quoteUrls[0]).toContain('platformFeeBps=85'); // fee requested because the OUTPUT mint has an entry
    expect(quote.response.feeIncluded).toBe(true);
    expect(quote.response.feeBps).toBe(85);
    expect(quote.response.feeSide).toBe('output');
    expect(quote.response.feeAmountFormatted).toBe('0.008643'); // 8643 raw at the OUTPUT's 6 decimals

    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    expect(capture.swapBuildBody.feeAccount).toBe(FEE_ACCOUNT);

    const entry = localStore.get('fluxio_tx_history').solana[0];
    console.log('[0200 e2e] swap Activity entry (with fee):', JSON.stringify(entry));
    expect(entry.platformFee).toEqual({ feeBps: 85, amountRaw: '8643', side: 'output' });
  }, E2E_TIMEOUT_MS);

  it('a quote older than the 60s TTL is refused with SWAP_QUOTE_EXPIRED and nothing is built/sent', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ capture: newCapture() });

    vi.useFakeTimers({ now: Date.now() });
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    vi.setSystemTime(Date.now() + 61_000);

    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toMatch(/SWAP_QUOTE_EXPIRED/);
    expect(capture.swapBuildBody).toBeNull();
    expect(capture.rpcMethods).not.toContain('sendTransaction');
  }, E2E_TIMEOUT_MS);

  it('a failed simulation aborts BEFORE signing/sending — SWAP_SIMULATION_FAILED with the log tail, slippage 0x1771 called out', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({
      simulateValue: {
        err: { InstructionError: [3, { Custom: 6001 }] },
        logs: ['Program log: route', 'Program failed: custom program error: 0x1771'],
        unitsConsumed: 0
      },
      capture: newCapture()
    });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toMatch(/SWAP_SIMULATION_FAILED/);
    expect(result.error).toMatch(/Price moved beyond your slippage/);
    expect(result.error).toMatch(/0x1771/);
    expect(capture.rpcMethods).toContain('simulateTransaction');
    expect(capture.rpcMethods).not.toContain('sendTransaction');
  }, E2E_TIMEOUT_MS);

  it('a built transaction whose fee payer is NOT the session address fails the identity fence before any RPC is spent', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const wrongFeePayer = new Array(32).fill(7);
    const capture = installSwapFetchMock({ feePayerBytes: wrongFeePayer, capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toMatch(/SWAP_SEND_FAILED/);
    expect(result.error).toMatch(/identity fence/);
    expect(capture.rpcMethods).not.toContain('simulateTransaction');
    expect(capture.rpcMethods).not.toContain('sendTransaction');
  }, E2E_TIMEOUT_MS);

  it('an RPC failure on broadcast surfaces as SWAP_SEND_FAILED (after a clean simulation)', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ sendBehavior: { reject: 'network down' }, capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toMatch(/SWAP_SEND_FAILED/);
    expect(capture.rpcMethods).toContain('simulateTransaction');
  }, E2E_TIMEOUT_MS);
});

describe('background.bundle.js — FLUXIO_INTERNAL_PREVIEW_SWAP_FEES (prompt 0200 fase 2)', () => {
  it('returns the real fee numbers from a Jupiter build and does NOT consume the quoteId — EXECUTE_SWAP still works after it', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.response.quoteId });
    expect(preview.error).toBeUndefined();
    expect(preview.response.prioritizationFeeLamports).toBe(56000);
    expect(preview.response.networkFeeLamports).toBe(61000); // 5000 base + 56000 prioritization
    expect(preview.response.networkFeeSolFormatted).toBe('0.000061000'); // formatUnits keeps trailing zeros; the popup trims via trimAmount
    expect(preview.response.lastValidBlockHeight).toBe(1000);

    // The peek must not have consumed the id: a real execute still succeeds.
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    expect(result.response.signature).toBe('FakeSwapSig1');
    expect(capture.rpcMethods).toContain('sendTransaction');
  }, E2E_TIMEOUT_MS);
});

describe('background.bundle.js — FLUXIO_INTERNAL_SWAP_STATUS (prompt 0200)', () => {
  async function executeOneSwap(listeners) {
    const capture = installSwapFetchMock({ capture: newCapture() });
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    return { capture, signature: result.response.signature, lastValidBlockHeight: result.response.lastValidBlockHeight };
  }

  it('a confirmed signature advances the local swap entry to confirmed (expired: false)', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const { signature, lastValidBlockHeight } = await executeOneSwap(listeners);

    installSwapFetchMock({
      statusValue: { confirmationStatus: 'confirmed', confirmations: 3, err: null },
      capture: newCapture()
    });
    const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature, lastValidBlockHeight });
    expect(status.error).toBeUndefined();
    expect(status.response.status).toBe('confirmed');
    expect(status.response.expired).toBe(false);
    expect(localStore.get('fluxio_tx_history').solana[0].status).toBe('confirmed');
  }, E2E_TIMEOUT_MS);

  it('a signature still not found past lastValidBlockHeight is DEFINITIVELY expired — SWAP_BLOCKHASH_EXPIRED, entry marked failed', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const { signature, lastValidBlockHeight } = await executeOneSwap(listeners);

    installSwapFetchMock({ statusValue: null, blockHeight: 1001, capture: newCapture() });
    const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature, lastValidBlockHeight });
    expect(status.error).toBeUndefined();
    expect(status.response.expired).toBe(true);
    expect(status.response.code).toBe('SWAP_BLOCKHASH_EXPIRED');
    expect(localStore.get('fluxio_tx_history').solana[0].status).toBe('failed');
  }, E2E_TIMEOUT_MS);

  it('not-found but still WITHIN lastValidBlockHeight stays pending (expired: false), entry untouched', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const { signature, lastValidBlockHeight } = await executeOneSwap(listeners);

    installSwapFetchMock({ statusValue: null, blockHeight: 999, capture: newCapture() });
    const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature, lastValidBlockHeight });
    expect(status.error).toBeUndefined();
    expect(status.response.status).toBe('not_found');
    expect(status.response.expired).toBe(false);
    expect(localStore.get('fluxio_tx_history').solana[0].status).toBe('pending');
  }, E2E_TIMEOUT_MS);
});

/**
 * Prompt 0203 Revisi 1 — the real-incident fixes: a dropped mainnet swap
 * (signature returned, never included, [null] on two RPCs) exposed that
 * (a) the bundle broadcast exactly once with no client re-send and (b) a
 * pending swap entry had no verdict path once the Swapped screen's poll
 * died with the popup. These tests prove the re-broadcast loop, the
 * piggyback/sweep verdicts, and the worker-restart recovery.
 */
describe('background.bundle.js — swap re-broadcast + definitive verdicts (prompt 0203 Revisi 1)', () => {
  const ACTIVE_SWAP_KEY = 'fluxio_active_swap';

  /**
   * Dynamic sibling of installSwapFetchMock: getSignatureStatuses stays
   * not-found until `confirmAfterResends` re-sends have happened, then
   * turns confirmed — the exact congestion-then-landed shape the
   * re-broadcast loop exists for. Captures EVERY sendTransaction's
   * options (the static mock only keeps the last).
   */
  function installRebroadcastFetchMock({ confirmAfterResends, blockHeight = 999, signature = 'RebroadcastSig1' }) {
    const capture = { sends: [], statusChecks: 0, rpcMethods: [] };
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.startsWith('https://lite-api.jup.ag/swap/v1/quote')) {
        return jsonResponse(quoteBody(false));
      }
      if (u === 'https://lite-api.jup.ag/swap/v1/swap') {
        return jsonResponse({
          swapTransaction: buildUnsignedV0TxBase64(REF_SOL_PUBKEY_BYTES),
          prioritizationFeeLamports: 56000,
          computeUnitLimit: 1400000,
          lastValidBlockHeight: 1000
        });
      }
      const { method, params } = JSON.parse(options.body);
      capture.rpcMethods.push(method);
      if (method === 'simulateTransaction') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { value: { err: null, logs: [], unitsConsumed: 5000 } } });
      }
      if (method === 'sendTransaction') {
        capture.sends.push({ rawTx: params[0], options: params[1] });
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: signature });
      }
      if (method === 'getSignatureStatuses') {
        capture.statusChecks += 1;
        const resends = capture.sends.length - 1; // first send is the EXECUTE broadcast itself
        const confirmed = resends >= confirmAfterResends;
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { value: [confirmed ? { confirmationStatus: 'confirmed', confirmations: 3, err: null } : null] }
        });
      }
      if (method === 'getBlockHeight') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: blockHeight });
      }
      if (method === 'getEpochInfo') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { blockHeight, absoluteSlot: blockHeight + 22_000_000, epoch: 1035, slotIndex: 1 } });
      }
      if (method === 'getSignaturesForAddress') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: [] });
      }
      if (method === 'getTransaction') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: null }); // real-received fetch (0205) — nothing retained in these scenarios
      }
      if (method === 'getAccountInfo') {
        // Prompt 0209 fee-account guard: these scenarios run the REAL
        // SWAP_FEE_ACCOUNTS (no override), so SOL->USDC is a fee pair —
        // answer VALID so the guard passes and the rebroadcast flow
        // under test proceeds unchanged.
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 451343619 }, value: validFeeAccountInfoValue() } });
      }
      throw new Error(`Unexpected RPC method ${method} against ${u}`);
    };
    return capture;
  }

  it('re-broadcast: an unconfirmed first send is re-sent (skipPreflight true, maxRetries 0) every tick until confirmed — 3 re-sends here — then the entry confirms and the active state clears', async () => {
    const { listeners, localStore, sessionStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installRebroadcastFetchMock({ confirmAfterResends: 3 });

    vi.useFakeTimers({ now: Date.now() });
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    expect(result.response.signature).toBe('RebroadcastSig1');

    // The active-swap state was persisted for MV3 survivability.
    expect(sessionStore.get(ACTIVE_SWAP_KEY)).toMatchObject({
      signature: 'RebroadcastSig1',
      lastValidBlockHeight: 1000,
      networkKey: 'solana'
    });
    expect(typeof sessionStore.get(ACTIVE_SWAP_KEY).rawTransactionBase64).toBe('string');

    // Drive the 2s loop with fake time: each advance runs one iteration
    // (status check -> still not found -> re-send). After 3 re-sends the
    // mock turns confirmed; the next iteration applies the verdict.
    for (let i = 0; i < 6 && sessionStore.has(ACTIVE_SWAP_KEY); i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    expect(capture.sends.length).toBe(4); // 1 EXECUTE broadcast + 3 re-sends
    expect(capture.sends[0].options).toMatchObject({ skipPreflight: false, maxRetries: 3 });
    for (const resend of capture.sends.slice(1)) {
      expect(resend.options).toMatchObject({ encoding: 'base64', skipPreflight: true, maxRetries: 0 });
      expect(resend.rawTx).toBe(capture.sends[1].rawTx); // identical signed bytes every time
    }
    expect(localStore.get('fluxio_tx_history').solana[0].status).toBe('confirmed');
    expect(sessionStore.has(ACTIVE_SWAP_KEY)).toBe(false); // done -> state cleared
  }, E2E_TIMEOUT_MS);

  it('expiry verdict WITHOUT the Swapped screen: GET_HISTORY alone fails a stuck pending swap entry past lastValidBlockHeight (SWAP_BLOCKHASH_EXPIRED)', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);

    // Seed the incident's exact shape AFTER import (so the startup sweep
    // can't be the thing that resolves it): a pending swap whose
    // transaction never landed, blockhash now long dead.
    localStore.set('fluxio_tx_history', {
      solana: [{
        networkKey: 'solana',
        type: 'swap',
        signatureOrHash: 'StuckSwapSig1',
        inputMint: SOL_MINT,
        inputSymbol: 'SOL',
        inputAmountRaw: '5000000',
        inputDecimals: 9,
        outputMint: USDC_MINT,
        outputSymbol: 'USDC',
        outputAmountRaw: '1000000',
        outputDecimals: 6,
        timestamp: Date.now() - 6 * 60_000,
        status: 'pending',
        lastValidBlockHeight: 1000
      }]
    });
    installSwapFetchMock({ statusValue: null, blockHeight: 1001, capture: newCapture() });

    const history = await send(listeners, 'FLUXIO_INTERNAL_GET_HISTORY', { networkKey: 'solana' });
    expect(history.error).toBeUndefined();
    const rendered = history.response.entries.find((e) => e.signatureOrHash === 'StuckSwapSig1');
    expect(rendered.status).toBe('failed'); // the CURRENT render already shows the verdict
    const stored = localStore.get('fluxio_tx_history').solana[0];
    expect(stored.status).toBe('failed');
    expect(stored.failureCode).toBe('SWAP_BLOCKHASH_EXPIRED');
  }, E2E_TIMEOUT_MS);

  it('worker-restart recovery: active state seeded in chrome.storage.session BEFORE import resumes on module init, applies the confirmed verdict, and clears the state', async () => {
    const { localStore, sessionStore } = installFakeChromeForBackground();
    // The restarted-worker scenario: a previous worker instance was mid-
    // re-broadcast; its state survives in storage.session, its loop does
    // not. Seed BOTH the session state and the pending local entry, then
    // import a FRESH bundle — module init alone must finish the job.
    sessionStore.set(ACTIVE_SWAP_KEY, {
      networkKey: 'solana',
      signature: 'ResumedSwapSig1',
      rawTransactionBase64: buildUnsignedV0TxBase64(REF_SOL_PUBKEY_BYTES),
      lastValidBlockHeight: 1000,
      startedAt: Date.now(),
      attempts: 2,
      summary: { inputSymbol: 'SOL', outputSymbol: 'USDC' }
    });
    localStore.set('fluxio_tx_history', {
      solana: [{
        networkKey: 'solana',
        type: 'swap',
        signatureOrHash: 'ResumedSwapSig1',
        inputMint: SOL_MINT,
        inputSymbol: 'SOL',
        inputAmountRaw: '5000000',
        inputDecimals: 9,
        outputMint: USDC_MINT,
        outputSymbol: 'USDC',
        outputAmountRaw: '1000000',
        outputDecimals: 6,
        timestamp: Date.now(),
        status: 'pending',
        lastValidBlockHeight: 1000
      }]
    });
    const capture = installRebroadcastFetchMock({ confirmAfterResends: -1, signature: 'ResumedSwapSig1' }); // confirmed on the very first status check

    await importFreshBundle();

    // Module init kicked the loop (no message, no popup, no alarm needed);
    // its first iteration sees 'confirmed' and finishes without a single
    // re-send. Real timers here — the first iteration needs none.
    await vi.waitFor(() => {
      expect(localStore.get('fluxio_tx_history').solana[0].status).toBe('confirmed');
      expect(sessionStore.has(ACTIVE_SWAP_KEY)).toBe(false);
    });
    expect(capture.sends.length).toBe(0); // confirmed before any re-send was needed
    expect(capture.rpcMethods).toContain('getSignatureStatuses');
  }, E2E_TIMEOUT_MS);
});

/**
 * Prompt 0203 Revisi 2 — reviewer finding: publicnode's getBlockHeight
 * returns the SLOT (~22M above the real block height), so the old
 * unfenced comparison would stamp every swap expired instantly through
 * that endpoint. Verdicts now go through getTrustedBlockHeight
 * (getEpochInfo, self-sanity-checked per endpoint) with a 90s
 * time-since-send BACKUP only when no endpoint gives a trusted height.
 * Both tests here make EVERY endpoint answer bogusly (slot-as-height) so
 * they hold regardless of how many endpoints the built bundle's config
 * has (a keyless build has one, a Helius build two); the recovery-via-
 * second-RPC case lives in packages/services/test/trustedBlockHeight.test.js,
 * where the endpoint list is injectable.
 */
describe('background.bundle.js — block-height sanity fence (prompt 0203 Revisi 2)', () => {
  function seedPendingSwapEntry(localStore, { signature, timestamp }) {
    localStore.set('fluxio_tx_history', {
      solana: [{
        networkKey: 'solana',
        type: 'swap',
        signatureOrHash: signature,
        inputMint: SOL_MINT,
        inputSymbol: 'SOL',
        inputAmountRaw: '5000000',
        inputDecimals: 9,
        outputMint: USDC_MINT,
        outputSymbol: 'USDC',
        outputAmountRaw: '1000000',
        outputDecimals: 6,
        timestamp,
        status: 'pending',
        lastValidBlockHeight: 1000
      }]
    });
  }

  /** Every endpoint answers getEpochInfo with the live bug's shape: "blockHeight" ≈ its own slot (gap 2), far above lastValidBlockHeight 1000. */
  function installBogusEpochInfoFetchMock() {
    const capture = { rpcMethods: [] };
    globalThis.fetch = async (url, options = {}) => {
      const { method } = JSON.parse(options.body);
      capture.rpcMethods.push(method);
      if (method === 'getSignatureStatuses') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { value: [null] } });
      }
      if (method === 'getEpochInfo') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { blockHeight: 447421525, absoluteSlot: 447421527, epoch: 1035, slotIndex: 1 } });
      }
      if (method === 'getBlockHeight') {
        // The verdict path must never consult raw getBlockHeight anymore.
        throw new Error('verdict path called getBlockHeight — it must use getEpochInfo via getTrustedBlockHeight');
      }
      if (method === 'getAccountInfo') {
        // Prompt 0209 fee-account guard (real map, SOL->USDC fee pair) — VALID.
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 451343619 }, value: validFeeAccountInfoValue() } });
      }
      throw new Error(`Unexpected RPC method ${method}`);
    };
    return capture;
  }

  it('an RPC returning the slot as block height must NOT produce an expiry verdict — fresh swap stays pending, fence logs its contract line', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    seedPendingSwapEntry(localStore, { signature: 'FenceFreshSig1', timestamp: Date.now() }); // fresh: the 90s time backup must not fire either
    installBogusEpochInfoFetchMock();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature: 'FenceFreshSig1', lastValidBlockHeight: 1000 });
    expect(status.error).toBeUndefined();
    expect(status.response.status).toBe('not_found');
    expect(status.response.expired).toBe(false); // the bogus 447421525 > 1000 was NOT believed
    expect(localStore.get('fluxio_tx_history').solana[0].status).toBe('pending');
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('block-height sanity fence'))).toBe(true);
    warnSpy.mockRestore();
  }, E2E_TIMEOUT_MS);

  it('time backup: with NO trusted height anywhere, a swap sent well past 90s ago IS expired — failed with SWAP_BLOCKHASH_EXPIRED', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    seedPendingSwapEntry(localStore, { signature: 'FenceOldSig1', timestamp: Date.now() - 6 * 60_000 }); // the incident's own shape: 6 minutes stuck
    installBogusEpochInfoFetchMock();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature: 'FenceOldSig1', lastValidBlockHeight: 1000 });
    expect(status.error).toBeUndefined();
    expect(status.response.expired).toBe(true);
    expect(status.response.code).toBe('SWAP_BLOCKHASH_EXPIRED');
    const stored = localStore.get('fluxio_tx_history').solana[0];
    expect(stored.status).toBe('failed');
    expect(stored.failureCode).toBe('SWAP_BLOCKHASH_EXPIRED');
    warnSpy.mockRestore();
  }, E2E_TIMEOUT_MS);
});

/**
 * Prompt 0205 — swap polish before 0.2.0: (A) the "New token account
 * rent" info on PREVIEW_SWAP_FEES (detection from the build itself), and
 * (B) the REAL received amount replacing the quote estimate once the
 * confirmed transaction has been fetched and parsed. Hard rules under
 * test: the real-amount path can never change a verdict (koreksi c),
 * a null getTransaction just keeps the estimate (koreksi b), and old
 * entries without the new fields render exactly as before.
 */
describe('background.bundle.js — ATA rent info + real received amount (prompt 0205)', () => {
  function fakeParsedSwapTx({ feePayer = REF_SOL_ADDRESS, outputMint = USDC_MINT, receivedRaw = '1005000', err = null } = {}) {
    return {
      slot: 447423784,
      transaction: { message: { accountKeys: [{ pubkey: feePayer, signer: true, writable: true }] } },
      meta: {
        err,
        fee: 105000,
        preBalances: [50948000],
        postBalances: [44354560],
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 0, mint: outputMint, owner: feePayer, uiTokenAmount: { amount: receivedRaw, decimals: 6, uiAmountString: 'x' } }]
      }
    };
  }

  async function executeConfirmedSwap(listeners, { transactionValue }) {
    let capture = installSwapFetchMock({ capture: newCapture() });
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    capture = installSwapFetchMock({
      statusValue: { confirmationStatus: 'confirmed', confirmations: 3, err: null },
      transactionValue,
      capture: newCapture()
    });
    return { capture, signature: result.response.signature, lastValidBlockHeight: result.response.lastValidBlockHeight };
  }

  it('PREVIEW: a build that creates the output ATA -> rent required, LIVE amount 1,488,440 -> "0.001488440" SOL (never the stale 2,039,280)', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    installSwapFetchMock({ buildTransactionBase64: buildUnsignedV0TxWithAtaCreateBase64(REF_SOL_PUBKEY_BYTES), capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.response.quoteId });
    expect(preview.error).toBeUndefined();
    expect(preview.response.newTokenAccountRent).toEqual({ status: 'required', approx: false, rentLamports: '1488440', rentSolFormatted: '0.001488440' });
    expect(preview.response.tokenAccountRentLamports).toBe('1488440');
  }, E2E_TIMEOUT_MS);

  it('PREVIEW: a build with NO output-ATA create -> status none (no rent row), live rent still passed for the MAX reserve', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    installSwapFetchMock({ capture: newCapture() }); // default build: no ATA instruction

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.response.quoteId });
    expect(preview.error).toBeUndefined();
    expect(preview.response.newTokenAccountRent.status).toBe('none');
    expect(preview.response.tokenAccountRentLamports).toBe('1488440');
  }, E2E_TIMEOUT_MS);

  it('real received: confirmed + getTransaction available -> entry stores receivedRealRaw, SWAP_STATUS carries it, Activity renders the REAL number', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const { signature, lastValidBlockHeight } = await executeConfirmedSwap(listeners, {
      transactionValue: fakeParsedSwapTx({ receivedRaw: '1005000' }) // deliberately != the quote's 1008265 estimate
    });

    const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature, lastValidBlockHeight });
    expect(status.error).toBeUndefined();
    expect(status.response.status).toBe('confirmed');
    expect(status.response.receivedRealRaw).toBe('1005000');
    expect(status.response.receivedRealFormatted).toBe('1.005000');

    const stored = localStore.get('fluxio_tx_history').solana[0];
    expect(stored.status).toBe('confirmed');
    expect(stored.receivedRealRaw).toBe('1005000');

    const history = await send(listeners, 'FLUXIO_INTERNAL_GET_HISTORY', { networkKey: 'solana' });
    const entry = history.response.entries.find((e) => e.signatureOrHash === signature);
    expect(entry.outputAmountFormatted).toBe('1.005000'); // the REAL number, not the 1.008265 estimate
    expect(entry.receivedIsReal).toBe(true);
  }, E2E_TIMEOUT_MS);

  it('Revisi 1 (i): data only available at t=15s -> the SPACED attempts still reach it and the real amount IS filled', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    vi.useFakeTimers({ now: Date.now() });
    const t0 = Date.now();
    const { capture, signature, lastValidBlockHeight } = await executeConfirmedSwap(listeners, {
      transactionValue: () => (Date.now() - t0 >= 15000 ? fakeParsedSwapTx({ receivedRaw: '1005000' }) : null)
    });

    // The Swapped screen's own 3s poll cadence, simulated with the fake
    // clock: attempts are consumed only when the 4s gap has elapsed
    // (t=0 by the re-broadcast loop, then t=6, 12, 18, ...), so the
    // t=15s arrival is reached at the t=18 attempt — well inside the
    // 8-spaced-attempt budget the old per-poll counter burned by t≈12.
    let last;
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(3000);
      last = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature, lastValidBlockHeight });
      expect(last.error).toBeUndefined();
      expect(last.response.status).toBe('confirmed');
    }
    expect(last.response.receivedRealRaw).toBe('1005000'); // FILLED
    const stored = localStore.get('fluxio_tx_history').solana[0];
    expect(stored.status).toBe('confirmed');
    expect(stored.receivedRealRaw).toBe('1005000');
    expect(stored.receivedRealAttempts).toBeLessThanOrEqual(8);
    // RPC budget: each attempt asks at most every configured endpoint
    // once — with the built bundle's own endpoint count that stayed at
    // a handful of calls, never a flood.
    const txCalls = capture.rpcMethods.filter((m) => m === 'getTransaction').length;
    expect(txCalls).toBeLessThanOrEqual(stored.receivedRealAttempts * 2);
  }, E2E_TIMEOUT_MS);

  it('Revisi 1 (ii): getTransaction null forever -> polite stop at 8 SPACED attempts, entry stays confirmed with the estimate, bounded RPC count', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    vi.useFakeTimers({ now: Date.now() });
    const { capture, signature, lastValidBlockHeight } = await executeConfirmedSwap(listeners, { transactionValue: null });

    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(3000);
      const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature, lastValidBlockHeight });
      expect(status.error).toBeUndefined();
      expect(status.response.status).toBe('confirmed');
      expect(status.response.receivedRealRaw).toBeNull();
    }
    const stored = localStore.get('fluxio_tx_history').solana[0];
    expect(stored.status).toBe('confirmed'); // the verdict never moved
    expect(stored.receivedRealRaw).toBeUndefined();
    expect(stored.receivedRealAttempts).toBe(8); // the polling surface's cap — 20 polls over 60s consumed only 8 spaced attempts
    const txCalls = capture.rpcMethods.filter((m) => m === 'getTransaction').length;
    expect(txCalls).toBeLessThanOrEqual(16); // 8 attempts x at most 2 configured endpoints — the stated bound

    const history = await send(listeners, 'FLUXIO_INTERNAL_GET_HISTORY', { networkKey: 'solana' });
    const entry = history.response.entries.find((e) => e.signatureOrHash === signature);
    expect(entry.outputAmountFormatted).toBe('1.008265'); // the estimate keeps showing
    expect(entry.receivedIsReal).toBe(false);
  }, E2E_TIMEOUT_MS);

  it('Revisi 4 (i): a BETTER fresh quote executes — and the transaction is built from the FRESH quoteResponse, not the displayed one', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const fresh = { ...quoteBody(false), outAmount: '1010000', otherAmountThreshold: '1004950' };
    const capture = installSwapFetchMock({ quoteSequence: [quoteBody(false), fresh], capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    expect(result.response.signature).toBe('FakeSwapSig1');
    expect(capture.quoteUrls).toHaveLength(2); // display + the Confirm-time re-quote
    expect(capture.swapBuildBody.quoteResponse.outAmount).toBe('1010000'); // built from the FRESH quote
    expect(localStore.get('fluxio_tx_history').solana[0].outputAmountRaw).toBe('1010000'); // Activity uses fresh numbers too
  }, E2E_TIMEOUT_MS);

  it('Revisi 4 (ii): a 0.05% drop is inside the silent-continue rule — executes with the fresh quote', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const fresh = { ...quoteBody(false), outAmount: '1007761', otherAmountThreshold: '1002723' }; // 1008265 x 0.9995, above the 0.999 floor
    const capture = installSwapFetchMock({ quoteSequence: [quoteBody(false), fresh], capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    expect(result.response.signature).toBe('FakeSwapSig1');
    expect(capture.swapBuildBody.quoteResponse.outAmount).toBe('1007761');
  }, E2E_TIMEOUT_MS);

  it('Revisi 4 (iii): a 0.5% drop returns SWAP_QUOTE_CHANGED — zero signatures, zero broadcasts, the NEW quoteId works and the old one is dead', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const dropped = { ...quoteBody(false), outAmount: '1003224', otherAmountThreshold: '998207' }; // ~0.5% below 1008265 — under the 0.999 floor
    const capture = installSwapFetchMock({ quoteSequence: [quoteBody(false), dropped], capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const oldId = quote.response.quoteId;
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: oldId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    expect(result.response.quoteChanged).toBe(true);
    expect(result.response.code).toBe('SWAP_QUOTE_CHANGED');
    expect(result.response.quote.quoteId).toBeDefined();
    expect(result.response.quote.quoteId).not.toBe(oldId);
    expect(result.response.quote.outAmountFormatted).toBe('1.003224'); // Review re-renders with the fresh numbers
    expect(capture.swapBuildBody).toBeNull(); // nothing was built...
    expect(capture.rpcMethods).not.toContain('simulateTransaction'); // ...nothing simulated...
    expect(capture.rpcMethods).not.toContain('sendTransaction'); // ...nothing signed or broadcast

    // The OLD id died with the change; the NEW id executes (its own
    // Confirm-time re-quote clamps to the same last body — no drop).
    const replay = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: oldId, networkKey: 'solana' });
    expect(replay.error).toMatch(/SWAP_QUOTE_EXPIRED/);
    const second = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: result.response.quote.quoteId, networkKey: 'solana' });
    expect(second.error).toBeUndefined();
    expect(second.response.signature).toBe('FakeSwapSig1');
  }, E2E_TIMEOUT_MS);

  it('Revisi 4 (iv): a FAILED re-quote signs nothing and keeps the displayed quote alive for a retry', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({
      quoteSequence: [quoteBody(false), new Error('jupiter 500'), quoteBody(false)],
      capture: newCapture()
    });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const first = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(first.error).toBeUndefined();
    expect(first.response.requoteFailed).toBe(true);
    expect(capture.swapBuildBody).toBeNull();
    expect(capture.rpcMethods).not.toContain('sendTransaction');

    // Same id, next Confirm: the re-quote now succeeds — executes.
    const retry = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(retry.error).toBeUndefined();
    expect(retry.response.signature).toBe('FakeSwapSig1');
  }, E2E_TIMEOUT_MS);

  it('Revisi 4 (v): a double Confirm still yields exactly ONE execution — the second call hits the single-use gate', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    installSwapFetchMock({ capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const first = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(first.error).toBeUndefined();
    expect(first.response.signature).toBe('FakeSwapSig1');
    const second = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(second.error).toMatch(/SWAP_QUOTE_EXPIRED/);
  }, E2E_TIMEOUT_MS);

  it('Revisi 4 (vi): on a USDC pair the Confirm-time re-quote still carries platformFeeBps=85 (fee params identical to the displayed quote)', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = { [USDC_MINT]: FEE_ACCOUNT };
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ withFeeQuote: true, capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    expect(capture.quoteUrls).toHaveLength(2);
    expect(capture.quoteUrls[0]).toContain('platformFeeBps=85');
    expect(capture.quoteUrls[1]).toContain('platformFeeBps=85'); // the re-quote asks for the SAME fee
    expect(capture.swapBuildBody.feeAccount).toBe(FEE_ACCOUNT);
  }, E2E_TIMEOUT_MS);

  it('Revisi 1 (iii): an entry past the polling cap is STILL retried from Activity later and gets its number', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    // An entry that exhausted the polling surface's budget long ago.
    localStore.set('fluxio_tx_history', {
      solana: [{
        networkKey: 'solana',
        type: 'swap',
        signatureOrHash: 'CappedOutSwapSig1',
        inputMint: SOL_MINT,
        inputSymbol: 'SOL',
        inputAmountRaw: '5000000',
        inputDecimals: 9,
        outputMint: USDC_MINT,
        outputSymbol: 'USDC',
        outputAmountRaw: '485118',
        outputDecimals: 6,
        timestamp: Date.now() - 3600_000,
        status: 'confirmed',
        lastValidBlockHeight: 1000,
        receivedRealAttempts: 8,
        receivedRealLastAttemptAt: Date.now() - 3600_000
      }]
    });
    installSwapFetchMock({ transactionValue: fakeParsedSwapTx({ outputMint: USDC_MINT, receivedRaw: '480995' }), capture: newCapture() });

    const history = await send(listeners, 'FLUXIO_INTERNAL_GET_HISTORY', { networkKey: 'solana' });
    expect(history.error).toBeUndefined();
    const entry = history.response.entries.find((e) => e.signatureOrHash === 'CappedOutSwapSig1');
    expect(entry.outputAmountFormatted).toBe('0.480995'); // filled on THIS render, despite the exhausted polling budget
    expect(entry.receivedIsReal).toBe(true);
    expect(localStore.get('fluxio_tx_history').solana[0].receivedRealRaw).toBe('480995');
  }, E2E_TIMEOUT_MS);

  it('koreksi c: a parser-refusing transaction (on-chain err in meta) -> entry stays confirmed, receivedRealRaw absent', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const { signature, lastValidBlockHeight } = await executeConfirmedSwap(listeners, {
      transactionValue: fakeParsedSwapTx({ err: { InstructionError: [3, { Custom: 6001 }] } })
    });

    const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature, lastValidBlockHeight });
    expect(status.error).toBeUndefined();
    expect(status.response.status).toBe('confirmed');
    expect(status.response.receivedRealRaw).toBeNull();
    const stored = localStore.get('fluxio_tx_history').solana[0];
    expect(stored.status).toBe('confirmed');
    expect(stored.receivedRealRaw).toBeUndefined();
  }, E2E_TIMEOUT_MS);

  it('an OLD-shape confirmed entry (recorded before 0205, no new fields) renders the estimate exactly as before', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    localStore.set('fluxio_tx_history', {
      solana: [{
        networkKey: 'solana',
        type: 'swap',
        signatureOrHash: 'OldConfirmedSwapSig1',
        inputMint: SOL_MINT,
        inputSymbol: 'SOL',
        inputAmountRaw: '5000000',
        inputDecimals: 9,
        outputMint: USDC_MINT,
        outputSymbol: 'USDC',
        outputAmountRaw: '485118',
        outputDecimals: 6,
        timestamp: Date.now() - 60_000,
        status: 'confirmed',
        lastValidBlockHeight: 1000
      }]
    });
    installSwapFetchMock({ capture: newCapture() }); // getTransaction answers null — the retry finds nothing

    const history = await send(listeners, 'FLUXIO_INTERNAL_GET_HISTORY', { networkKey: 'solana' });
    expect(history.error).toBeUndefined();
    const entry = history.response.entries.find((e) => e.signatureOrHash === 'OldConfirmedSwapSig1');
    expect(entry.outputAmountFormatted).toBe('0.485118');
    expect(entry.receivedIsReal).toBe(false);
    expect(localStore.get('fluxio_tx_history').solana[0].status).toBe('confirmed');
  }, E2E_TIMEOUT_MS);

  it('koreksi d: a simulation failing with InsufficientFundsForRent gets the friendly SOL-and-rent sentence', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    installSwapFetchMock({
      simulateValue: { err: { InsufficientFundsForRent: { account_index: 1 } }, logs: [], unitsConsumed: 0 },
      capture: newCapture()
    });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toMatch(/SWAP_SIMULATION_FAILED/);
    expect(result.error).toMatch(/Not enough SOL to cover the network fee and account rent/);
  }, E2E_TIMEOUT_MS);
});

/**
 * Prompt 0203 Revisi 3 — real-money display bug: Jupiter's
 * quote.platformFee.amount is ALWAYS output-denominated, so an
 * INPUT-side fee shown at the input's decimals came out ~10x wrong
 * ("0.042124 USDC" for a real 0.004088 USDC fee — the chain itself
 * charged the correct input-side amount). The display/record value for
 * an input-side fee is now computed from the input amount.
 */
describe('background.bundle.js — input-side fee display (prompt 0203 Revisi 3)', () => {
  it('an INPUT-side fee is displayed and recorded from the input amount — never Jupiter\'s output-denominated platformFee.amount', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = { [SOL_MINT]: FEE_ACCOUNT }; // fee account on the INPUT mint -> feeSide 'input'
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    installSwapFetchMock({ withFeeQuote: true, feeAccountMint: SOL_MINT, capture: newCapture() }); // mock quote's platformFee.amount stays 8643 — output-denominated, wrong currency for an input-side display; feeAccountMint follows the injected map (prompt 0209 guard)

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    expect(quote.response.feeSide).toBe('input');
    // 0.01 SOL in = 10,000,000 raw; 85 bps -> 85,000 raw at the INPUT's
    // 9 decimals. The mock quote's 8643 must NOT surface anywhere.
    expect(quote.response.feeAmountFormatted).toBe('0.000085000');

    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    const entry = localStore.get('fluxio_tx_history').solana[0];
    expect(entry.platformFee).toEqual({ feeBps: 85, amountRaw: '85000', side: 'input' });
  }, E2E_TIMEOUT_MS);
});

/**
 * Prompt 0206 butir 5 — the capped priority fee. The one promise the
 * Review screen's static "Network fee (max)" row rests on: every Jupiter
 * build (the Review preview AND the Confirm execute, which is a SEPARATE
 * build from a fresh quote) carries the identical
 * priorityLevelWithMaxLamports cap, so no signed transaction can ever
 * pay more priority fee than the row showed.
 */
describe('background.bundle.js — capped priority fee (prompt 0206 butir 5)', () => {
  it('PREVIEW and EXECUTE builds both send the IDENTICAL capped priorityLevelWithMaxLamports param', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = {};
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.response.quoteId });
    expect(preview.error).toBeUndefined();
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();

    // Two real builds happened: the preview's and the execute's (the
    // execute builds from its own fresh quote — still the same cap).
    expect(capture.swapBuildBodies.length).toBe(2);
    const expectedCap = { priorityLevelWithMaxLamports: { maxLamports: 150000, priorityLevel: 'high' } };
    expect(capture.swapBuildBodies[0].prioritizationFeeLamports).toEqual(expectedCap);
    expect(capture.swapBuildBodies[1].prioritizationFeeLamports).toEqual(expectedCap);
    expect(capture.swapBuildBodies[0].prioritizationFeeLamports).toEqual(capture.swapBuildBodies[1].prioritizationFeeLamports);
  }, E2E_TIMEOUT_MS);
});

/**
 * Prompt 0206 butir 2 — token naming without any new network calls: the
 * verified list GET_SWAP_TOKENS already fetches is snapshotted (naming
 * fields ONLY, no logoUri — the owner cancelled remote logos) into
 * chrome.storage.local at most once per 24h, and the dashboard/Activity
 * use it as a LAST-RESORT name source (custom > registry > snapshot >
 * "Unknown"; a mint nothing recognizes stays "Unknown" on purpose).
 */
describe('background.bundle.js — token metadata snapshot + naming (prompt 0206 butir 2)', () => {
  const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
  const MYSTERY_MINT = 'MysteryMint111111111111111111111111111111111';
  const VERIFIED_LIST = [
    { id: SOL_MINT, symbol: 'SOL', name: 'Wrapped SOL', decimals: 9, icon: 'https://example.invalid/sol.png' },
    { id: USDC_MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6, icon: 'https://example.invalid/usdc.png' },
    { id: JUP_MINT, symbol: 'JUP', name: 'Jupiter', decimals: 6, icon: 'https://example.invalid/jup.png' }
  ];

  function tokenAccount(mint, amount, decimals) {
    return { account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } } };
  }

  it('GET_SWAP_TOKENS writes the naming-only snapshot (symbol/name/decimals per mint, NO logoUri)', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ verifiedList: VERIFIED_LIST, capture: newCapture() });

    const tokens = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_TOKENS');
    expect(tokens.error).toBeUndefined();
    expect(capture.verifiedListFetches).toBe(1);

    const snapshot = localStore.get('fluxio_token_metadata');
    expect(snapshot).toBeDefined();
    expect(typeof snapshot.updatedAt).toBe('number');
    expect(snapshot.byMint[JUP_MINT]).toEqual({ symbol: 'JUP', name: 'Jupiter', decimals: 6 });
    // The SOL entry keeps the same "Solana" display name the picker shows.
    expect(snapshot.byMint[SOL_MINT].name).toBe('Solana');
    for (const meta of Object.values(snapshot.byMint)) {
      expect(meta).not.toHaveProperty('logoUri');
      expect(meta).not.toHaveProperty('icon');
    }
  }, E2E_TIMEOUT_MS);

  it('the 24h brake: a fresh existing snapshot is NOT rewritten; a stale (>24h) one IS', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    installSwapFetchMock({ verifiedList: VERIFIED_LIST, capture: newCapture() });

    // Fresh snapshot (1s old) with a sentinel body — must survive untouched.
    const freshAt = Date.now() - 1000;
    localStore.set('fluxio_token_metadata', { updatedAt: freshAt, byMint: { SentinelMint: { symbol: 'KEEP', name: 'Keep Me', decimals: 0 } } });
    await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_TOKENS');
    expect(localStore.get('fluxio_token_metadata')).toEqual({
      updatedAt: freshAt,
      byMint: { SentinelMint: { symbol: 'KEEP', name: 'Keep Me', decimals: 0 } }
    });

    // Stale snapshot (25h old) — the next GET_SWAP_TOKENS rewrites it.
    localStore.set('fluxio_token_metadata', { updatedAt: Date.now() - 25 * 60 * 60 * 1000, byMint: { SentinelMint: { symbol: 'KEEP', name: 'Keep Me', decimals: 0 } } });
    await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_TOKENS');
    const rewritten = localStore.get('fluxio_token_metadata');
    expect(rewritten.byMint.SentinelMint).toBeUndefined();
    expect(rewritten.byMint[JUP_MINT]).toEqual({ symbol: 'JUP', name: 'Jupiter', decimals: 6 });
    expect(Date.now() - rewritten.updatedAt).toBeLessThan(60_000);
  }, E2E_TIMEOUT_MS);

  it('GET_TOKEN_BALANCES: only "Unknown" Solana entries get named from the snapshot; registry names win; unrecognized mints stay "Unknown"', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    localStore.set('fluxio_token_metadata', {
      updatedAt: Date.now(),
      byMint: {
        [JUP_MINT]: { symbol: 'JUP', name: 'Jupiter', decimals: 6 },
        // A poisoned snapshot entry for USDT — must NEVER be consulted,
        // because the built-in registry (prompt 0206's new USDT entry)
        // already names that mint before the snapshot is even read.
        [USDT_MINT]: { symbol: 'WRONG', name: 'Wrong Name', decimals: 6 }
      }
    });
    installSwapFetchMock({
      tokenAccountsValue: [
        tokenAccount(USDT_MINT, '1087538', 6), // registry (USDT added in 0206)
        tokenAccount(JUP_MINT, '2500000', 6), // snapshot-only
        tokenAccount(MYSTERY_MINT, '42', 0) // nothing knows it
      ],
      capture: newCapture()
    });

    const result = await send(listeners, 'FLUXIO_INTERNAL_GET_TOKEN_BALANCES', { networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    const bySymbol = Object.fromEntries(result.response.tokens.map((t) => [t.address, t]));
    expect(bySymbol[USDT_MINT].symbol).toBe('USDT'); // registry, not the poisoned snapshot
    expect(bySymbol[USDT_MINT].name).toBe('Tether USD');
    expect(bySymbol[JUP_MINT].symbol).toBe('JUP'); // snapshot filled the Unknown
    expect(bySymbol[JUP_MINT].name).toBe('Jupiter');
    expect(bySymbol[MYSTERY_MINT].symbol).toBe('Unknown'); // stays unknown, deliberately
  }, E2E_TIMEOUT_MS);

  it('GET_HISTORY: an OLD swap entry stored with "Unknown" symbols is renamed at render time (registry then snapshot) without touching the stored entry', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    localStore.set('fluxio_token_metadata', {
      updatedAt: Date.now(),
      byMint: { [JUP_MINT]: { symbol: 'JUP', name: 'Jupiter', decimals: 6 } }
    });
    // The real 0205 incident shape: the owner's USDT -> SOL swap recorded
    // with inputSymbol "Unknown" (pre-USDT-registry, pre-snapshot) —
    // receivedRealRaw already present, so no getTransaction retry fires.
    localStore.set('fluxio_tx_history', {
      solana: [
        {
          networkKey: 'solana', type: 'swap', signatureOrHash: 'OldUsdtSwapSig1',
          inputMint: USDT_MINT, inputSymbol: 'Unknown', inputAmountRaw: '1087538', inputDecimals: 6,
          outputMint: SOL_MINT, outputSymbol: 'SOL', outputAmountRaw: '9727189', outputDecimals: 9,
          receivedRealRaw: '9727189', timestamp: Date.now() - 60_000, status: 'confirmed', lastValidBlockHeight: 1000
        },
        {
          networkKey: 'solana', type: 'swap', signatureOrHash: 'OldJupSwapSig1',
          inputMint: SOL_MINT, inputSymbol: 'SOL', inputAmountRaw: '5000000', inputDecimals: 9,
          outputMint: JUP_MINT, outputSymbol: 'Unknown', outputAmountRaw: '2500000', outputDecimals: 6,
          receivedRealRaw: '2500000', timestamp: Date.now() - 30_000, status: 'confirmed', lastValidBlockHeight: 1000
        },
        {
          networkKey: 'solana', type: 'swap', signatureOrHash: 'OldMysterySwapSig1',
          inputMint: SOL_MINT, inputSymbol: 'SOL', inputAmountRaw: '1000000', inputDecimals: 9,
          outputMint: MYSTERY_MINT, outputSymbol: 'Unknown', outputAmountRaw: '42', outputDecimals: 0,
          receivedRealRaw: '42', timestamp: Date.now() - 10_000, status: 'confirmed', lastValidBlockHeight: 1000
        }
      ]
    });
    installSwapFetchMock({ capture: newCapture() });

    const history = await send(listeners, 'FLUXIO_INTERNAL_GET_HISTORY', { networkKey: 'solana' });
    expect(history.error).toBeUndefined();
    const byId = Object.fromEntries(history.response.entries.map((e) => [e.signatureOrHash, e]));
    expect(byId.OldUsdtSwapSig1.inputSymbol).toBe('USDT'); // the built-in registry names it now
    expect(byId.OldJupSwapSig1.outputSymbol).toBe('JUP'); // snapshot fallback
    expect(byId.OldMysterySwapSig1.outputSymbol).toBe('Unknown'); // stays unknown, deliberately

    // No destructive migration: the STORED entries still say "Unknown".
    const stored = localStore.get('fluxio_tx_history').solana;
    expect(stored.find((e) => e.signatureOrHash === 'OldUsdtSwapSig1').inputSymbol).toBe('Unknown');
    expect(stored.find((e) => e.signatureOrHash === 'OldJupSwapSig1').outputSymbol).toBe('Unknown');
  }, E2E_TIMEOUT_MS);
});

/**
 * Prompt 0209 — the swap fee-account guard (owner decisions 1, 2, 4;
 * born from the 0208 incident, swap lesson #8: the embedded treasury
 * USDC ATA was closed while a build carrying its address sat in review).
 * Placement B: GET_SWAP_QUOTE verifies a fee pair's account BEFORE
 * calling Jupiter's /quote (structured SWAP_FEE_ACCOUNT_UNAVAILABLE
 * refusal, no quote request) and EXECUTE re-verifies before the fresh
 * re-quote; a failed Jupiter build on a fee pair re-checks once more,
 * cache bypassed, and maps to the honest code when the account is bad
 * or unverifiable. VALID results cache 60s per worker; invalid and
 * unverified are never cached. Non-fee pairs must cost ZERO extra RPC.
 */
describe('background.bundle.js — swap fee-account guard (prompt 0209)', () => {
  it('INVALID (missing account): GET_SWAP_QUOTE refuses with SWAP_FEE_ACCOUNT_UNAVAILABLE, zero Jupiter calls, nothing signed or broadcast', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = { [USDC_MINT]: FEE_ACCOUNT };
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ feeAccountInfoValue: null, capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    expect(quote.response.code).toBe('SWAP_FEE_ACCOUNT_UNAVAILABLE');
    expect(quote.response.quoteId).toBeUndefined();
    expect(capture.quoteUrls).toHaveLength(0); // refused BEFORE /quote (owner decision 1)
    expect(capture.swapBuildBodies).toHaveLength(0);
    expect(capture.rpcMethods).not.toContain('simulateTransaction');
    expect(capture.rpcMethods).not.toContain('sendTransaction');
    expect(capture.accountInfoCalls).toBeGreaterThanOrEqual(1);
  }, E2E_TIMEOUT_MS);

  it('INVALID (wrong mint): an account that EXISTS but holds another mint is refused — existence alone is never enough', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = { [USDC_MINT]: FEE_ACCOUNT };
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({
      feeAccountInfoValue: validFeeAccountInfoValue('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), // USDT, not USDC — fase 1's real case C shape
      capture: newCapture()
    });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    expect(quote.response.code).toBe('SWAP_FEE_ACCOUNT_UNAVAILABLE');
    expect(capture.quoteUrls).toHaveLength(0);
  }, E2E_TIMEOUT_MS);

  it('INVALID (wrong owner): a token account with the right mint but another owner is refused', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = { [USDC_MINT]: FEE_ACCOUNT };
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({
      feeAccountInfoValue: validFeeAccountInfoValue(USDC_MINT, REF_SOL_ADDRESS), // right mint, wrong owner
      capture: newCapture()
    });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    expect(quote.response.code).toBe('SWAP_FEE_ACCOUNT_UNAVAILABLE');
    expect(capture.quoteUrls).toHaveLength(0);
  }, E2E_TIMEOUT_MS);

  it('VALID: the full fee flow is unchanged, and the 60s VALID cache means a second quote + the execute cost NO further getAccountInfo', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = { [USDC_MINT]: FEE_ACCOUNT };
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ withFeeQuote: true, capture: newCapture() });

    const quote1 = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote1.error).toBeUndefined();
    expect(quote1.response.quoteId).toBeDefined();
    const quote2 = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS); // the popup's 15s refresh
    expect(quote2.error).toBeUndefined();
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote2.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    expect(result.response.signature).toBe('FakeSwapSig1');
    expect(capture.accountInfoCalls).toBe(1); // first check verified on chain; refresh AND execute hit the VALID cache
    expect(capture.swapBuildBody.feeAccount).toBe(FEE_ACCOUNT); // the fee itself is untouched by the guard
  }, E2E_TIMEOUT_MS);

  it('VALID cache expires after its 60s TTL: a quote past the window re-verifies on chain', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = { [USDC_MINT]: FEE_ACCOUNT };
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ withFeeQuote: true, capture: newCapture() });

    const realNow = Date.now;
    let offsetMs = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + offsetMs);
    try {
      const quote1 = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
      expect(quote1.error).toBeUndefined();
      expect(capture.accountInfoCalls).toBe(1);
      offsetMs = 61_000; // one second past SWAP_FEE_ACCOUNT_VALID_TTL_MS
      const quote2 = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
      expect(quote2.error).toBeUndefined();
      expect(capture.accountInfoCalls).toBe(2); // cache expired — verified again
    } finally {
      nowSpy.mockRestore();
    }
  }, E2E_TIMEOUT_MS);

  it('NON-FEE pair: zero getAccountInfo calls ever (owner decision b of prompt 0209 — structurally free)', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = {};
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    expect(capture.accountInfoCalls ?? 0).toBe(0);
    expect(capture.rpcMethods).not.toContain('getAccountInfo');
  }, E2E_TIMEOUT_MS);

  it('UNVERIFIED (RPC down at check time): the swap PROCEEDS with feeAccount still sent to Jupiter (owner decision 2, opsi ii)', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = { [USDC_MINT]: FEE_ACCOUNT };
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({
      withFeeQuote: true,
      feeAccountInfoValue: () => {
        throw new Error('rpc transport down');
      },
      capture: newCapture()
    });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    expect(quote.response.quoteId).toBeDefined(); // proceeded to a real quote despite the failed check
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toBeUndefined();
    expect(capture.swapBuildBody.feeAccount).toBe(FEE_ACCOUNT); // fee never silently skipped
  }, E2E_TIMEOUT_MS);

  it('BUILD FAILS + re-check finds the account GONE: the failure maps to SWAP_FEE_ACCOUNT_UNAVAILABLE, not the generic build error', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = { [USDC_MINT]: FEE_ACCOUNT };
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    let checks = 0;
    const capture = installSwapFetchMock({
      withFeeQuote: true,
      buildFailure: true,
      feeAccountInfoValue: () => (++checks === 1 ? validFeeAccountInfoValue() : null), // valid at quote time, GONE by the post-build re-check
      capture: newCapture()
    });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toContain('SWAP_FEE_ACCOUNT_UNAVAILABLE');
    expect(result.error).not.toContain('SWAP_SEND_FAILED');
    expect(checks).toBeGreaterThanOrEqual(2); // the re-check really ran, cache bypassed
    expect(capture.rpcMethods).not.toContain('sendTransaction'); // nothing signed, nothing broadcast
  }, E2E_TIMEOUT_MS);

  it('BUILD FAILS + re-check says VALID: the original SWAP_SEND_FAILED classification stands (the build failed for another reason)', async () => {
    globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ = { [USDC_MINT]: FEE_ACCOUNT };
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installSwapFetchMock({ withFeeQuote: true, buildFailure: true, capture: newCapture() });

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'solana' });
    expect(result.error).toContain('SWAP_SEND_FAILED');
    expect(result.error).not.toContain('SWAP_FEE_ACCOUNT_UNAVAILABLE');
    expect(capture.accountInfoCalls).toBe(2); // quote check + the cache-bypassed re-check
    expect(capture.rpcMethods).not.toContain('sendTransaction');
  }, E2E_TIMEOUT_MS);
});

/**
 * Prompt 0210 — chain-only Jupiter-swap recognition through GET_HISTORY
 * (owner opsi B). A swap made on another device/install has no local
 * record; it must render as a Swap row (amounts from the user's own
 * chain deltas, symbols named by the existing custom > registry >
 * snapshot lookup), a FAILED one as the honest fee-only note, a local
 * record must still win outright, and recognition must cost ZERO extra
 * RPC (exactly one getTransaction per signature — the history fetch
 * itself; the real-received resolver must NOT re-fetch a chain entry).
 */
describe('background.bundle.js — chain-only swap recognition in GET_HISTORY (prompt 0210)', () => {
  const JUP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  const CHAIN_SWAP_SIG = 'ChainOnlySwapSig1111111111111111111111111111';

  /** Minimal REAL-shaped jsonParsed Jupiter swap tx: REF pays 0.01 SOL (+fee), receives 1.008265 USDC into an existing ATA. */
  function jupiterChainTx({ err = null } = {}) {
    return {
      slot: 450847817,
      blockTime: 1_790_000_000,
      transaction: {
        message: {
          accountKeys: [
            { pubkey: REF_SOL_ADDRESS, signer: true, writable: true, source: 'transaction' },
            { pubkey: 'RefUsdcAtaAddr11111111111111111111111111111', signer: false, writable: true, source: 'transaction' },
            { pubkey: JUP_PROGRAM, signer: false, writable: false, source: 'transaction' },
            { pubkey: '11111111111111111111111111111111', signer: false, writable: false, source: 'transaction' }
          ],
          instructions: [
            { programId: '11111111111111111111111111111111' },
            { programId: JUP_PROGRAM, accounts: [], data: '' }
          ]
        },
        signatures: [CHAIN_SWAP_SIG]
      },
      meta: {
        err,
        fee: 5000,
        preBalances: [1_000_000_000, 2_039_280, 1, 1],
        postBalances: [989_995_000, 2_039_280, 1, 1],
        preTokenBalances: [
          { accountIndex: 1, mint: USDC_MINT, owner: REF_SOL_ADDRESS, uiTokenAmount: { amount: '0', decimals: 6, uiAmountString: '0' } }
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: USDC_MINT, owner: REF_SOL_ADDRESS, uiTokenAmount: { amount: '1008265', decimals: 6, uiAmountString: '1.008265' } }
        ]
      }
    };
  }

  /** History-focused fetch mock: signatures list + one transaction; counts getTransaction calls. */
  function installHistoryFetchMock({ tx, sigErr = null }) {
    const capture = { getTransactionCalls: 0, rpcMethods: [] };
    globalThis.fetch = async (url, options = {}) => {
      const { method, params } = JSON.parse(options.body);
      capture.rpcMethods.push(method);
      if (method === 'getSignaturesForAddress') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: [{ signature: CHAIN_SWAP_SIG, slot: tx.slot, err: sigErr, blockTime: tx.blockTime }] });
      }
      if (method === 'getTransaction') {
        capture.getTransactionCalls += 1;
        expect(params[0]).toBe(CHAIN_SWAP_SIG);
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: tx });
      }
      throw new Error(`Unexpected RPC method ${method} against ${String(url)}`);
    };
    return capture;
  }

  it('a chain-only Jupiter swap renders as type swap: SOL pay from the lamport delta (fee excluded), USDC receive named by the REGISTRY, exactly ONE getTransaction', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installHistoryFetchMock({ tx: jupiterChainTx() });

    const history = await send(listeners, 'FLUXIO_INTERNAL_GET_HISTORY', { networkKey: 'solana' });
    expect(history.error).toBeUndefined();
    const entry = history.response.entries.find((e) => e.signatureOrHash === CHAIN_SWAP_SIG);
    expect(entry.type).toBe('swap');
    expect(entry.status).toBe('confirmed');
    expect(entry.inputSymbol).toBe('SOL');
    expect(entry.inputAmountFormatted).toBe('0.010000000'); // 10,000,000 lamports at 9 decimals — the fee is NOT in the figure
    expect(entry.outputSymbol).toBe('USDC'); // 'Unknown' from the chain, named by the built-in registry at render time
    expect(entry.outputAmountFormatted).toBe('1.008265');
    expect(entry.chainNote).toBeNull();
    // ZERO extra RPC: the one getTransaction IS the history fetch; the
    // real-received resolver must not have re-fetched this chain entry.
    expect(capture.getTransactionCalls).toBe(1);
  }, E2E_TIMEOUT_MS);

  it('a LOCAL swap record with the same signature still wins outright — the chain entry only contributes status', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    localStore.set('fluxio_tx_history', {
      solana: [
        {
          networkKey: 'solana', type: 'swap', signatureOrHash: CHAIN_SWAP_SIG,
          inputMint: SOL_MINT, inputSymbol: 'SOL', inputAmountRaw: '12300000', inputDecimals: 9,
          outputMint: USDC_MINT, outputSymbol: 'USDC', outputAmountRaw: '999999', outputDecimals: 6,
          receivedRealRaw: '999999', timestamp: Date.now() - 60_000, status: 'pending', lastValidBlockHeight: 1000
        }
      ]
    });
    const capture = installHistoryFetchMock({ tx: jupiterChainTx() });

    const history = await send(listeners, 'FLUXIO_INTERNAL_GET_HISTORY', { networkKey: 'solana' });
    expect(history.error).toBeUndefined();
    const entry = history.response.entries.find((e) => e.signatureOrHash === CHAIN_SWAP_SIG);
    expect(entry.type).toBe('swap');
    expect(entry.inputAmountFormatted).toBe('0.012300000'); // the LOCAL record's numbers, not the chain-derived 0.01
    expect(entry.outputAmountFormatted).toBe('0.999999');
    expect(entry.status).toBe('confirmed'); // chain's more-final status still applies (mergeHistory rule)
    expect(capture.getTransactionCalls).toBe(1);
  }, E2E_TIMEOUT_MS);

  it('a chain-only swap that FAILED on chain: type swap, no amounts, the honest fee-only note, and still exactly one getTransaction', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const err = { InstructionError: [1, { Custom: 14 }] };
    const capture = installHistoryFetchMock({ tx: jupiterChainTx({ err }), sigErr: err });

    const history = await send(listeners, 'FLUXIO_INTERNAL_GET_HISTORY', { networkKey: 'solana' });
    expect(history.error).toBeUndefined();
    const entry = history.response.entries.find((e) => e.signatureOrHash === CHAIN_SWAP_SIG);
    expect(entry.type).toBe('swap');
    expect(entry.status).toBe('failed');
    expect(entry.inputAmountFormatted).toBeNull();
    expect(entry.outputAmountFormatted).toBeNull();
    expect(entry.chainNote).toBe('Swap failed on chain. Only the network fee was charged.');
    expect(capture.getTransactionCalls).toBe(1);
  }, E2E_TIMEOUT_MS);
});

/**
 * Prompt 0219 tahap A — EVM (BNB Chain) swap QUOTES through the real
 * bundle, with a self-contained fetch mock (this describe deliberately
 * does NOT reuse installSwapFetchMock, so the 48 Solana tests above stay
 * byte-identical). Fixtures are the REAL archived 0218 Kyber responses.
 * Execution is impossible by design: EXECUTE_SWAP refuses 'bnb' before
 * any signer/build code — proven here by the error AND by the fetch mock
 * never seeing a Jupiter call or a sendTransaction.
 */
describe('background.bundle.js — EVM swap quotes, tahap A (prompt 0219)', () => {
  const FIXTURE_DIR = path.join(__dirname, '..', '..', '..', 'prompt', 'evidence', '0218-evm-swap-spike');
  const KYBER_FIXTURE = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'kyber-bnb2usdt.json'), 'utf8'));
  const USDT_BEP20 = '0x55d398326f99059fF775485246999027B3197955';

  function installEvmSwapFetchMock(kyberFixture = KYBER_FIXTURE) {
    const capture = { kyberUrls: [], liteApiCalls: 0, evmRpcMethods: [], solanaSendCalls: 0 };
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.includes('lite-api.jup.ag')) {
        capture.liteApiCalls += 1;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (u.startsWith('https://aggregator-api.kyberswap.com/bsc/api/v1/routes')) {
        capture.kyberUrls.push(u);
        return { ok: true, status: 200, json: async () => kyberFixture };
      }
      const { method } = JSON.parse(options.body);
      if (method === 'sendTransaction') capture.solanaSendCalls += 1;
      if (method === 'eth_blockNumber') return rpc('0xffffff'); // 0232 R3: resolver received (jauh di atas receipt mana pun)
      if (method === 'eth_getBlockByNumber') {
        capture.evmRpcMethods.push(method);
        // The 0213-proven BSC shape: baseFeePerGas "0x0".
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { baseFeePerGas: '0x0' } }) };
      }
      if (method === 'eth_maxPriorityFeePerGas') {
        capture.evmRpcMethods.push(method);
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x2faf080' }) };
      }
      throw new Error(`Unexpected request in EVM tahap-A test: ${method ?? u}`);
    };
    return capture;
  }

  const EVM_QUOTE_PARAMS = {
    networkKey: 'bnb',
    inputMint: 'native',
    outputMint: USDT_BEP20,
    amount: '0.001',
    inputDecimals: 18,
    outputDecimals: 18,
    slippageBps: 50,
    inputSymbol: 'BNB',
    outputSymbol: 'USDT'
  };

  it('GET_SWAP_TOKENS bnb: native BNB first + the registry USDT, and Jupiter is never consulted', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmSwapFetchMock();

    const result = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_TOKENS', { networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    const tokens = result.response.tokens;
    expect(tokens[0]).toMatchObject({ address: 'native', symbol: 'BNB', decimals: 18 });
    expect(tokens.some((t) => t.address === USDT_BEP20 && t.symbol === 'USDT' && t.decimals === 18)).toBe(true);
    expect(capture.liteApiCalls).toBe(0);

    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('GET_SWAP_QUOTE bnb: the popup-shaped response from the REAL fixture — exact out amount, our own floor() minimum received, no fee fields', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmSwapFetchMock();

    const result = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', EVM_QUOTE_PARAMS);
    expect(result.error).toBeUndefined();
    const q = result.response;
    expect(q.quoteId).toBeTruthy();
    expect(q.inAmountFormatted).toBe('0.001000000000000000');
    expect(q.outAmountFormatted).toBe('0.753258826981658902'); // fixture raw, 18 decimals
    // minimum received computed OUR side (Kyber routes applies no
    // slippage): floor(753258826981658902 * 9950 / 10000) — the exact
    // BigInt value, independently recomputed, is ...750607.
    expect(q.minReceivedFormatted).toBe('0.749492532846750607');
    // The Fluxio fee rides on every EVM quote since 0221 (owner
    // keputusan): displayed fee = floor(amountIn x 85 / 10000) in the
    // PAY currency — 1e15 wei -> 8.5e12 wei = 0.0000085 BNB.
    expect(q.feeIncluded).toBe(true);
    expect(q.feeBps).toBe(85);
    expect(q.feeSide).toBe('input');
    expect(q.feeAmountFormatted).toBe('0.000008500000000000');
    // Denomination lock (caught by 0219's own visual pass): the popup's
    // formatPriceImpact multiplies by 100, so this must be a FRACTION
    // like Jupiter's. Since 0221 Revisi 1 the impact is computed against
    // the input NET of the 0,85% fee — this LEGACY 0218 fixture's legs
    // predate the fee (outUsd is not net of it), so the net basis lands
    // ~-0.0084 here: still a fraction, display-clamped to '<0.01%'.
    // Real fee-carrying quotes are locked in the tahap-B success test.
    expect(Number(q.priceImpactPct)).toBeLessThan(0);
    expect(Number(q.priceImpactPct)).toBeGreaterThan(-0.02);
    expect(capture.kyberUrls.length).toBe(1);
    expect(capture.kyberUrls[0]).toContain('amountIn=1000000000000000');
    expect(capture.liteApiCalls).toBe(0);

    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('GET_SWAP_QUOTE bnb: USD legs with outUsd > inUsd yield a NEGATIVE priceImpactPct fraction (0219 Revisi 2 — the display clamp is the popup\'s job, the raw value stays honest)', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    // Deep-clone the real fixture and SWAP its USD legs so the output is
    // marked worth more than the input — the exact shape behind the
    // owner's live "-0.07%" screen (Kyber feeds vs a momentarily better
    // route).
    const flipped = JSON.parse(JSON.stringify(KYBER_FIXTURE));
    const summary = flipped.data.routeSummary;
    [summary.amountInUsd, summary.amountOutUsd] = [summary.amountOutUsd, summary.amountInUsd];
    installEvmSwapFetchMock(flipped);

    const result = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', EVM_QUOTE_PARAMS);
    expect(result.error).toBeUndefined();
    const impact = Number(result.response.priceImpactPct);
    expect(impact).toBeLessThan(0);
    expect(impact).toBeGreaterThan(-0.02); // still a fraction, never a percent (the 0203 denomination lock); ~-0.0087 since the 0221 Revisi 1 net-fee basis stacks on the flipped legs

    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('PREVIEW_SWAP_FEES bnb: Max network fee = floor(gas x 1,2) x maxFeePerGas with the 0213 RPC shape (baseFee 0x0, tip 0x2faf080)', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    installEvmSwapFetchMock();

    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', EVM_QUOTE_PARAMS);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.response.quoteId });
    expect(preview.error).toBeUndefined();
    expect(preview.response.kind).toBe('evm');
    expect(preview.response.nativeSymbol).toBe('BNB');
    expect(preview.response.gasLimit).toBe('322597'); // floor(268831 * 12 / 10)
    expect(preview.response.maxFeePerGas).toBe('50000000'); // 0 * 2 + 0,05 gwei
    expect(preview.response.maxFeeWei).toBe('16129850000000');
    expect(preview.response.maxFeeFormatted).toBe('0.000016129850000000');

    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('EXECUTE_SWAP bnb TOKEN TO TOKEN (direction gate, revised by tahap C): refused with the coming-soon EVM_SWAP_NOT_AVAILABLE — no re-quote, no broadcast, quote cache untouched', async () => {
    // Consciously REVISED by prompt 0223 (not deleted): through tahap B
    // this locked EVERY token-in direction out; tahap C opens token-in to
    // NATIVE out (USDT to BNB via the approve flow), so the gate this
    // test now locks is the remaining one — token to token.
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmSwapFetchMock();

    const OTHER_BEP20 = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'; // any non-native 0x address — the gate reads only the refs
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', {
      ...EVM_QUOTE_PARAMS,
      inputMint: USDT_BEP20,
      outputMint: OTHER_BEP20,
      inputSymbol: 'USDT',
      outputSymbol: 'USDC'
    });
    const kyberCallsAfterQuote = capture.kyberUrls.length;
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'bnb' });
    expect(result.error).toContain('EVM_SWAP_NOT_AVAILABLE');
    expect(result.error).toContain('Swapping a token to another token is coming soon'); // teks 0227 K6 (revisi sadar — jaringan tidak lagi disebut)
    expect(result.error).toContain('No funds moved');
    expect(capture.kyberUrls.length).toBe(kyberCallsAfterQuote); // no re-quote, no build
    expect(capture.liteApiCalls).toBe(0);
    expect(capture.solanaSendCalls).toBe(0);
    // The fence fires before the cache is consumed: a replayed EXECUTE on
    // the same id refuses the same way (the id would read SWAP_QUOTE_
    // EXPIRED had the cache been eaten).
    const replay = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'bnb' });
    expect(replay.error).toContain('EVM_SWAP_NOT_AVAILABLE');

    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);
});

/**
 * Prompt 0220 — EVM swap EXECUTE, tahap B (native-in / BNB to token).
 * Every pagar (a) to (h) gets its own failing test proving NOTHING was
 * broadcast. "The signer was not called" is asserted via
 * eth_sendRawTransaction count 0: in executeEvmSwap the sign call is
 * IMMEDIATELY followed by the broadcast with no branch between them (and
 * a broadcast attempt — success or RPC rejection — always passes through
 * this fetch mock), so zero broadcasts is a faithful signer-not-reached
 * proof for every guard, all of which throw BEFORE the sign line.
 * Fixtures are the REAL archived 0220 quote+build pair (routerAddress,
 * value and amounts all genuinely consistent), and the receipt's
 * Transfer log follows the REAL 0213 Revisi 3 shape.
 */
describe('background.bundle.js — EVM swap EXECUTE, tahap B (prompt 0220; fixtures moved to the 0221 FEE pair — every quote carries the Fluxio fee since then)', () => {
  const FIXTURE_DIR_0221 = path.join(__dirname, '..', '..', '..', 'prompt', 'evidence', '0221-evm-swap-fee');
  const QUOTE_FIXTURE = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0221, 'quote-fee-bnb2usdt.json'), 'utf8'));
  const BUILD_FIXTURE = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0221, 'build-fee-bnb2usdt.json'), 'utf8'));
  const USDT_BEP20 = '0x55d398326f99059fF775485246999027B3197955';
  const REF_EVM_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'; // reference mnemonic's EVM account 0 (pinned in backgroundResetWalletBundle)
  const EVM_TX_HASH = '0x' + 'ab'.repeat(32);
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const OUT_RAW = 361378711868759859n; // the 0221 fee build fixture's own amountOut (quote minus 1 raw)
  const OUT_RAW_QUOTE = 361378711868759860n;

  const EXEC_QUOTE_PARAMS = {
    networkKey: 'bnb',
    inputMint: 'native',
    outputMint: USDT_BEP20,
    amount: '0.0005',
    inputDecimals: 18,
    outputDecimals: 18,
    slippageBps: 50,
    inputSymbol: 'BNB',
    outputSymbol: 'USDT'
  };

  function pad64(addr) {
    return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  }
  /** Receipt log in the REAL 0213 shape: USDT contract, Transfer topic, padded recipient, raw value hex. */
  function usdtTransferLog(value = OUT_RAW) {
    return {
      address: USDT_BEP20.toLowerCase(),
      topics: [TRANSFER_TOPIC, pad64('0x8894e0a0c962cb723c1976a4421c95949be2d4e3'), pad64(REF_EVM_ADDRESS)],
      data: '0x' + value.toString(16).padStart(64, '0')
    };
  }

  /**
   * One fetch mock serving Kyber (routes + build) and the BSC JSON-RPC.
   * Receipts are a QUEUE (last answer repeats); routes can answer
   * differently per call for the re-quote tests.
   */
  function installEvmExecuteMock(opts = {}) {
    const {
      routesResponses = null, // array of {status, json}; default: always the fixture
      buildMutator = null,
      balanceHex = '0x2386f26fc10000', // 0.01 BNB — comfortably enough
      estimateGasHex = '0x41a1f', // 268831, the fixture's own gas
      estimateGasError = null,
      tipHex = '0x2faf080', // 0,05 gwei
      tipHexes = null, // queue (per eth_maxPriorityFeePerGas call, last repeats) — the (g2) tests raise the tip BETWEEN preview and execute
      receipts = [null]
    } = opts;
    const capture = { kyberRoutes: 0, kyberBuilds: 0, methods: [], sendRawParams: [], receiptCalls: 0, tipCalls: 0 };
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.includes('lite-api.jup.ag')) {
        throw new Error('Jupiter must never be touched on the EVM path');
      }
      if (u.startsWith('https://aggregator-api.kyberswap.com/bsc/api/v1/routes')) {
        const idx = capture.kyberRoutes++;
        const r = routesResponses ? routesResponses[Math.min(idx, routesResponses.length - 1)] : { status: 200, json: QUOTE_FIXTURE };
        return { ok: r.status === 200, status: r.status, json: async () => r.json };
      }
      if (u.startsWith('https://aggregator-api.kyberswap.com/bsc/api/v1/route/build')) {
        capture.kyberBuilds++;
        const json = buildMutator ? buildMutator(JSON.parse(JSON.stringify(BUILD_FIXTURE))) : BUILD_FIXTURE;
        return { ok: true, status: 200, json: async () => json };
      }
      const { method, params } = JSON.parse(options.body);
      capture.methods.push(method);
      const rpc = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
      if (method === 'eth_getBlockByNumber') return rpc({ baseFeePerGas: '0x0' });
      if (method === 'eth_maxPriorityFeePerGas') {
        const queue = tipHexes || [tipHex];
        return rpc(queue[Math.min(capture.tipCalls++, queue.length - 1)]);
      }
      if (method === 'eth_getBalance') return rpc(balanceHex);
      if (method === 'eth_getTransactionCount') return rpc('0x3');
      if (method === 'eth_estimateGas') {
        if (estimateGasError) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: estimateGasError }) };
        return rpc(estimateGasHex);
      }
      if (method === 'eth_sendRawTransaction') {
        capture.sendRawParams.push(params[0]);
        return rpc(EVM_TX_HASH);
      }
      if (method === 'eth_getTransactionReceipt') {
        const idx = Math.min(capture.receiptCalls++, receipts.length - 1);
        return rpc(receipts[idx]);
      }
      throw new Error(`Unexpected RPC in EVM execute test: ${method}`);
    };
    return capture;
  }

  async function quoteBnbToUsdt(listeners) {
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', EXEC_QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    return quote.response.quoteId;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it('pagar (a) unlock: EXECUTE bnb on a locked wallet is SWAP_LOCKED with zero RPC and zero broadcasts', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    const capture = installEvmExecuteMock();
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: 'anything', networkKey: 'bnb' });
    expect(result.error).toContain('SWAP_LOCKED');
    expect(capture.methods.length).toBe(0);
    expect(capture.sendRawParams.length).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('pagar (b) quote id: an unknown/expired id is SWAP_QUOTE_EXPIRED with zero Kyber calls and zero broadcasts', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmExecuteMock();
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: 'bogus', networkKey: 'bnb' });
    expect(result.error).toContain('SWAP_QUOTE_EXPIRED');
    expect(capture.kyberRoutes).toBe(0);
    expect(capture.kyberBuilds).toBe(0);
    expect(capture.sendRawParams.length).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('pagar (c) re-quote drop: a fresh quote more than 0,1% worse returns SWAP_QUOTE_CHANGED with a NEW live id, the old id dead, nothing broadcast', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const worse = JSON.parse(JSON.stringify(QUOTE_FIXTURE));
    worse.data.routeSummary.amountOut = ((OUT_RAW * 98n) / 100n).toString(); // -2%
    const capture = installEvmExecuteMock({ routesResponses: [{ status: 200, json: QUOTE_FIXTURE }, { status: 200, json: worse }] });
    const quoteId = await quoteBnbToUsdt(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.quoteChanged).toBe(true);
    expect(result.response.code).toBe('SWAP_QUOTE_CHANGED');
    expect(result.response.quote.quoteId).not.toBe(quoteId);
    expect(capture.kyberBuilds).toBe(0);
    expect(capture.sendRawParams.length).toBe(0);
    // Old id is dead; the NEW id still answers PREVIEW.
    const replay = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(replay.error).toContain('SWAP_QUOTE_EXPIRED');
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: result.response.quote.quoteId });
    expect(preview.error).toBeUndefined();
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('pagar (c) re-quote failure: returns requoteFailed, the displayed id stays ALIVE, nothing broadcast', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmExecuteMock({ routesResponses: [{ status: 200, json: QUOTE_FIXTURE }, { status: 500, json: {} }] });
    const quoteId = await quoteBnbToUsdt(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.requoteFailed).toBe(true);
    expect(capture.sendRawParams.length).toBe(0);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId });
    expect(preview.error).toBeUndefined(); // still alive — popup goes back to Review
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('sanity guard (keputusan 5): a fresh price cache implying a 10x off-market quote refuses with EVM_SWAP_QUOTE_SUSPICIOUS, nothing broadcast', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmExecuteMock();
    localStore.set('fluxio_portfolio_price_cache', {
      pricesByCoinId: {
        binancecoin: { usd: 7338 }, // 10x the real price — the quote's USD legs can't reconcile
        'binance-bridged-usdt-bnb-smart-chain': { usd: 0.999222 }
      },
      fetchedAt: Date.now()
    });
    const quoteId = await quoteBnbToUsdt(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toContain('EVM_SWAP_QUOTE_SUSPICIOUS');
    expect(result.error).toContain('No funds moved');
    expect(capture.kyberBuilds).toBe(0);
    expect(capture.sendRawParams.length).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('sanity guard skips cleanly when the cache is STALE (older than 30s) — the same absurd prices no longer block', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    installEvmExecuteMock({ receipts: [null] });
    localStore.set('fluxio_portfolio_price_cache', {
      pricesByCoinId: { binancecoin: { usd: 7338 }, 'binance-bridged-usdt-bnb-smart-chain': { usd: 0.999222 } },
      fetchedAt: Date.now() - 31000
    });
    const quoteId = await quoteBnbToUsdt(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.signature).toBe(EVM_TX_HASH); // went through — check skipped, not failed
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('pagar (d) build mismatch: a router address differing from the quote is EVM_SWAP_BUILD_MISMATCH, nothing broadcast', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmExecuteMock({
      buildMutator: (json) => {
        json.data.routerAddress = '0x' + '11'.repeat(20);
        return json;
      }
    });
    const quoteId = await quoteBnbToUsdt(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toContain('EVM_SWAP_BUILD_MISMATCH');
    expect(capture.sendRawParams.length).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('pagar (e) balance FIRST: 0 balance refuses with the honest EVM_SWAP_INSUFFICIENT_BALANCE before eth_estimateGas ever runs (the raw node jargon of 0220 fase 1 butir 3 never reaches the user)', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmExecuteMock({ balanceHex: '0x0' });
    const quoteId = await quoteBnbToUsdt(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toContain('EVM_SWAP_INSUFFICIENT_BALANCE');
    expect(result.error).toContain('You do not have enough BNB');
    expect(capture.methods).not.toContain('eth_estimateGas');
    expect(capture.sendRawParams.length).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('pagar (f) simulation: a node-reported revert is EVM_SWAP_SIMULATION_FAILED, nothing broadcast', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmExecuteMock({ estimateGasError: { code: 3, message: 'execution reverted' } });
    const quoteId = await quoteBnbToUsdt(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toContain('EVM_SWAP_SIMULATION_FAILED');
    expect(result.error).toContain('execution reverted');
    expect(capture.sendRawParams.length).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('pagar (f) gas cap: an estimate whose buffered limit exceeds 1.000.000 is EVM_SWAP_GAS_LIMIT_ABOVE_CAP, nothing broadcast', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmExecuteMock({ estimateGasHex: '0xd59f8' }); // 875.000 -> x1,2 = 1.050.000 > cap
    const quoteId = await quoteBnbToUsdt(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toContain('EVM_SWAP_GAS_LIMIT_ABOVE_CAP');
    expect(capture.sendRawParams.length).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('pagar (g) fee cap: a 4 gwei network tip is EVM_SWAP_GAS_PRICE_ABOVE_CAP (cap 3 gwei), nothing broadcast', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmExecuteMock({ tipHex: '0xee6b2800', balanceHex: '0x16345785d8a0000' }); // 4 gwei tip, 0.1 BNB balance so pagar (e) passes
    const quoteId = await quoteBnbToUsdt(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toContain('EVM_SWAP_GAS_PRICE_ABOVE_CAP');
    expect(capture.sendRawParams.length).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('pagar (g2) ceiling (0220 Revisi 3; code split by 0223 Revisi 3 tambahan): a fresh fee ABOVE the displayed Max network fee returns EVM_SWAP_FEE_ABOVE_DISPLAYED with a new live id — nothing broadcast, nothing signed', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    // PREVIEW sees 0,05 gwei (ceiling 322.597 x 5e7 = 16.129.850.000.000
    // wei — the number the user READ); EXECUTE's fresh read sees 0,1 gwei
    // (fresh fee 32.259.700.000.000 — double the displayed ceiling, yet
    // far under the 3 gwei hard cap, so ONLY the new ceiling catches it).
    const capture = installEvmExecuteMock({ tipHexes: ['0x2faf080', '0x5f5e100'] });
    const quoteId = await quoteBnbToUsdt(listeners);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId });
    expect(preview.response.maxFeeWei).toBe('16129850000000');

    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.quoteChanged).toBe(true);
    expect(result.response.code).toBe('EVM_SWAP_FEE_ABOVE_DISPLAYED'); // g2's OWN code since 0223 Revisi 3 tambahan — the quote itself may not have moved
    expect(result.response.quote.quoteId).not.toBe(quoteId);
    expect(capture.sendRawParams.length).toBe(0);
    // The new id is live: its own PREVIEW answers (Review re-renders with
    // the NEW fee from the fresh tip).
    const preview2 = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: result.response.quote.quoteId });
    expect(preview2.error).toBeUndefined();
    expect(preview2.response.maxFeeWei).toBe('32259700000000');

    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('pagar (g2) pass-through: a fresh fee AT the displayed ceiling executes exactly as before (the success path is unchanged)', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const receipt = { status: '0x1', gasUsed: '0x41a1f', effectiveGasPrice: '0x2faf080', logs: [usdtTransferLog()] };
    const capture = installEvmExecuteMock({ receipts: [receipt] });
    const quoteId = await quoteBnbToUsdt(listeners);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId });
    expect(preview.response.maxFeeWei).toBe('16129850000000');
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.signature).toBe(EVM_TX_HASH);
    expect(capture.sendRawParams.length).toBeGreaterThanOrEqual(1);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('pagar (b2) fee echo (0221): a fresh quote whose extraFee does not confirm OUR fee settings is EVM_SWAP_FEE_MISMATCH — nothing built, nothing broadcast, displayed id stays alive', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const tampered = JSON.parse(JSON.stringify(QUOTE_FIXTURE));
    tampered.data.routeSummary.extraFee = { ...tampered.data.routeSummary.extraFee, feeReceiver: '0x' + '11'.repeat(20) };
    const capture = installEvmExecuteMock({ routesResponses: [{ status: 200, json: QUOTE_FIXTURE }, { status: 200, json: tampered }] });
    const quoteId = await quoteBnbToUsdt(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toContain('EVM_SWAP_FEE_MISMATCH');
    expect(result.error).toContain('No funds moved');
    expect(capture.kyberBuilds).toBe(0);
    expect(capture.sendRawParams.length).toBe(0);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId });
    expect(preview.error).toBeUndefined(); // peek only — the displayed quote survives for a retry
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('SUCCESS path: broadcast + identical-bytes re-send, session state, single-use id, then SWAP_STATUS confirms with the REAL received amount parsed from the Transfer log', async () => {
    const { listeners, sessionStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const receipt = { status: '0x1', gasUsed: '0x41a1f', effectiveGasPrice: '0x2faf080', logs: [usdtTransferLog()] };
    const capture = installEvmExecuteMock({ receipts: [null, receipt] });
    // The quote response carries the fee fields the Review row renders
    // (0221): floor(5e14 x 85 / 10000) = 4.25e12 wei = 0.00000425 BNB.
    const quoteRes = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', EXEC_QUOTE_PARAMS);
    expect(quoteRes.response.feeIncluded).toBe(true);
    expect(quoteRes.response.feeBps).toBe(85);
    expect(quoteRes.response.feeSide).toBe('input');
    expect(quoteRes.response.feeAmountFormatted).toBe('0.000004250000000000');
    // Price impact on the NET-fee basis (0221 Revisi 1, owner keputusan):
    // on the REAL fee fixture it must equal the ROUTE's own impact — the
    // no-fee sibling fixture is the reference (|diff| < 0.0005) — and
    // must never read as the ~0.0085 fee itself.
    const NOFEE_FIXTURE = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0221, 'quote-nofee-bnb2usdt.json'), 'utf8'));
    const nf = NOFEE_FIXTURE.data.routeSummary;
    const routeOnlyImpact = (Number(nf.amountInUsd) - Number(nf.amountOutUsd)) / Number(nf.amountInUsd);
    const feeQuoteImpact = Number(quoteRes.response.priceImpactPct);
    expect(Math.abs(feeQuoteImpact - routeOnlyImpact)).toBeLessThan(0.0005);
    expect(feeQuoteImpact).toBeLessThan(0.0085);
    const quoteId = quoteRes.response.quoteId;

    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.signature).toBe(EVM_TX_HASH);
    expect(result.response.explorerUrl).toContain(EVM_TX_HASH);
    expect(capture.kyberRoutes).toBe(2); // the displayed quote + the fresh one
    expect(capture.kyberBuilds).toBe(1);
    expect(capture.methods).toContain('eth_estimateGas');
    expect(capture.methods).toContain('eth_getTransactionCount');

    // Active-swap state persisted to chrome.storage.session (swap lesson 2
    // in EVM form) — signed bytes server-side only.
    const state = sessionStore.get('fluxio_active_swap');
    expect(state).toMatchObject({ kind: 'evm', networkKey: 'bnb', signature: EVM_TX_HASH });
    expect(state.rawSignedTx.startsWith('0x')).toBe(true);

    // The loop's first iteration re-sends the IDENTICAL bytes (receipt
    // still null on its first verdict check).
    await sleep(150);
    expect(capture.sendRawParams.length).toBeGreaterThanOrEqual(2);
    expect(new Set(capture.sendRawParams).size).toBe(1); // every broadcast byte-identical — same hash, at most one execution

    // Single use: the id is consumed.
    const replay = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(replay.error).toContain('SWAP_QUOTE_EXPIRED');

    // SWAP_STATUS (networkKey bnb): receipt 0x1 -> confirmed + the REAL
    // received amount from the Transfer log, exactly OUT_RAW.
    const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature: EVM_TX_HASH, networkKey: 'bnb' });
    expect(status.error).toBeUndefined();
    expect(status.response.status).toBe('confirmed');
    expect(status.response.err).toBeNull();
    expect(status.response.receivedRealRaw).toBe(OUT_RAW.toString());

    // Explorer-link lock (0220 Revisi 2, caught live on the FIRST real
    // EVM swap): the Activity entry's BscScan URL must be CLEAN — the
    // old unconditional solanaExplorerUrl appended "?cluster=undefined".
    const history = await send(listeners, 'FLUXIO_INTERNAL_GET_HISTORY', { networkKey: 'bnb' });
    expect(history.error).toBeUndefined();
    const swapEntry = history.response.entries.find((e) => e.signatureOrHash === EVM_TX_HASH);
    expect(swapEntry.explorerUrl).toBe(`https://bscscan.com/tx/${EVM_TX_HASH}`);
    expect(swapEntry.explorerUrl).not.toContain('?');

    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('FAILED ON CHAIN: a 0x0 receipt yields status failed with err set (the popup maps it to the honest fee-only text) and the local entry fails', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmExecuteMock({ receipts: [{ status: '0x0', gasUsed: '0x41a1f', logs: [] }] });
    const quoteId = await quoteBnbToUsdt(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature: EVM_TX_HASH, networkKey: 'bnb' });
    expect(status.response.status).toBe('failed');
    expect(status.response.err).toBeTruthy();
    const entry = (localStore.get('fluxio_tx_history')?.bnb || []).find((e) => e.signatureOrHash === EVM_TX_HASH);
    expect(entry.status).toBe('failed');
    expect(capture.sendRawParams.length).toBeGreaterThanOrEqual(1);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('HONEST PENDING: no receipt keeps SWAP_STATUS at pending (never a verdict), and a past-window active state is cleared by the loop WITHOUT failing the entry', async () => {
    const { listeners, sessionStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installEvmExecuteMock({ receipts: [null] });

    // A pending status is honestly pending.
    const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature: EVM_TX_HASH, networkKey: 'bnb' });
    expect(status.response.status).toBe('pending');
    expect(status.response.expired).toBe(false);

    // Inject an active EVM state already past the 10-minute window; the
    // loop must clear it without re-sending and without any failure write.
    sessionStore.set('fluxio_active_swap', {
      kind: 'evm',
      networkKey: 'bnb',
      signature: EVM_TX_HASH,
      rawSignedTx: '0xdead',
      startedAt: Date.now() - 700000,
      attempts: 3
    });
    const active = await send(listeners, 'FLUXIO_INTERNAL_GET_ACTIVE_SWAP');
    expect(active.response.active).toBe(true);
    expect(active.response.kind).toBe('evm');
    await sleep(150);
    expect(sessionStore.has('fluxio_active_swap')).toBe(false); // window over — state cleared
    expect(capture.sendRawParams.length).toBe(0); // and nothing was re-sent

    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);
});

/**
 * Tahap C (prompt 0223) — token-in (USDT to BNB) with the K1 exact-amount
 * approve, driven end to end on the REAL 0223 fixtures
 * (prompt/evidence/0223-evm-swap-token-in/: a live USDT->BNB quote with
 * the fee echo, and its live build with transactionValue "0"). Every
 * guard test proves the swap leg broadcasts NOTHING when it fires.
 */
describe('background.bundle.js — EVM swap token-in + approve, tahap C (prompt 0223)', () => {
  const FIXTURE_DIR_0223 = path.join(__dirname, '..', '..', '..', 'prompt', 'evidence', '0223-evm-swap-token-in');
  const QUOTE_FIXTURE_TOKENIN = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0223, 'quote-usdt2bnb-fee.json'), 'utf8'));
  const BUILD_FIXTURE_TOKENIN = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0223, 'build-usdt2bnb-fee.json'), 'utf8'));
  const USDT_BEP20 = '0x55d398326f99059fF775485246999027B3197955';
  const AMOUNT_IN_RAW = 500000000000000000n; // the fixture's own 0.5 USDT
  const OUT_RAW_TOKENIN = 692616267379370n; // the quote fixture's amountOut

  const TOKENIN_QUOTE_PARAMS = {
    networkKey: 'bnb',
    inputMint: USDT_BEP20,
    outputMint: 'native',
    amount: '0.5',
    inputDecimals: 18,
    outputDecimals: 18,
    slippageBps: 50,
    inputSymbol: 'USDT',
    outputSymbol: 'BNB'
  };

  /**
   * Fetch mock for the two-leg flow: Kyber routes/build from the 0223
   * fixtures, plus the BSC JSON-RPC with eth_call routed by SELECTOR
   * (allowance 0xdd62ed3e, balanceOf 0x70a08231). Receipts are a queue
   * whose entries may be FUNCTIONS (awaited) so a test can interleave an
   * action — e.g. locking the wallet — exactly before a receipt lands;
   * `capture.receiptValueOverride` (when set) wins over the queue, so the
   * worker-restart test can flip the approve receipt after a re-import.
   */
  function installTokenInMock(opts = {}) {
    const {
      allowanceHex = '0x0',
      allowanceHexes = null, // 0228 Revisi 1: antrean per panggilan dd62ed3e (kompat mundur: allowanceHex statis)
      tokenBalanceHex = '0x' + (10n ** 18n).toString(16), // 1 USDT held
      routesResponses = null,
      buildMutator = null,
      balanceHex = '0x2386f26fc10000', // 0.01 BNB — covers both ceilings
      balanceByBlock = {}, // 0223 Revisi 1: explicit-block eth_getBalance answers for the K4 reads
      approveEstimateHex = '0xbb80', // 48.000 gas
      swapEstimateHex = '0x41a1f', // 268.831, the fixture's own gas
      swapEstimateError = null, // 0223 Revisi 1: a node-reported revert for the SWAP simulation only
      tipHex = '0x2faf080', // 0,05 gwei
      tipHexes = null,
      receipts = [null],
      sendRawHashes = ['0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(32)]
    } = opts;
    const capture = {
      kyberRoutes: 0, kyberBuilds: 0, methods: [], sendRawParams: [],
      estimateCalls: [], callDatas: [], receiptCalls: 0, tipCalls: 0,
      nonceCalls: 0, receiptValueOverride: undefined,
      kyberUrls: [], buildBodies: []
    };
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.includes('lite-api.jup.ag')) {
        throw new Error('Jupiter must never be touched on the EVM path');
      }
      if (u.startsWith('https://aggregator-api.kyberswap.com/bsc/api/v1/routes')) {
        capture.kyberUrls.push(u);
        const idx = capture.kyberRoutes++;
        const r = routesResponses ? routesResponses[Math.min(idx, routesResponses.length - 1)] : { status: 200, json: QUOTE_FIXTURE_TOKENIN };
        return { ok: r.status === 200, status: r.status, json: async () => r.json };
      }
      if (u.startsWith('https://aggregator-api.kyberswap.com/bsc/api/v1/route/build')) {
        capture.kyberBuilds++;
        capture.buildBodies.push(JSON.parse(options.body));
        const json = buildMutator ? buildMutator(JSON.parse(JSON.stringify(BUILD_FIXTURE_TOKENIN))) : BUILD_FIXTURE_TOKENIN;
        return { ok: true, status: 200, json: async () => json };
      }
      const { method, params } = JSON.parse(options.body);
      capture.methods.push(method);
      const rpc = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
      if (method === 'eth_getBlockByNumber') return rpc({ baseFeePerGas: '0x0' });
      if (method === 'eth_maxPriorityFeePerGas') {
        const queue = tipHexes || [tipHex];
        return rpc(queue[Math.min(capture.tipCalls++, queue.length - 1)]);
      }
      if (method === 'eth_call') {
        const data = String(params[0]?.data || '');
        capture.callDatas.push(data);
        if (data.startsWith('0xdd62ed3e')) {
          const queue = allowanceHexes || [allowanceHex];
          const idx = Math.min((capture.allowanceCalls = (capture.allowanceCalls || 0) + 1) - 1, queue.length - 1);
          return rpc('0x' + BigInt(queue[idx]).toString(16).padStart(64, '0'));
        }
        if (data.startsWith('0x70a08231')) return rpc('0x' + BigInt(tokenBalanceHex).toString(16).padStart(64, '0'));
        throw new Error(`Unexpected eth_call selector in token-in test: ${data.slice(0, 10)}`);
      }
      if (method === 'eth_getBalance') {
        const tag = String(params[1] ?? 'latest');
        return rpc(balanceByBlock[tag] != null ? balanceByBlock[tag] : balanceHex);
      }
      if (method === 'eth_getTransactionCount') {
        capture.nonceCalls++;
        return rpc('0x6');
      }
      if (method === 'eth_estimateGas') {
        capture.estimateCalls.push(params[0]);
        const isApprove = String(params[0]?.data || '').startsWith('0x095ea7b3');
        if (!isApprove && swapEstimateError) {
          return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: swapEstimateError }) };
        }
        return rpc(isApprove ? approveEstimateHex : swapEstimateHex);
      }
      if (method === 'eth_sendRawTransaction') {
        capture.sendRawParams.push(params[0]);
        return rpc(sendRawHashes[Math.min(capture.sendRawParams.length - 1, sendRawHashes.length - 1)]);
      }
      if (method === 'eth_getTransactionReceipt') {
        if (capture.receiptValueOverride !== undefined) return rpc(capture.receiptValueOverride);
        const idx = Math.min(capture.receiptCalls++, receipts.length - 1);
        const r = receipts[idx];
        const value = typeof r === 'function' ? await r() : r;
        return rpc(value);
      }
      throw new Error(`Unexpected RPC in token-in test: ${method}`);
    };
    return capture;
  }

  async function quoteUsdtToBnb(listeners) {
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', TOKENIN_QUOTE_PARAMS);
    expect(quote.error).toBeUndefined();
    // 0231 Revisi 2 (owner P1): token-in kini FAIL CLOSED tanpa plafon
    // tampil, dan popup memang selalu PREVIEW di Review — helper ini
    // meniru alur nyata itu untuk setiap tes di describe ini.
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.response.quoteId });
    expect(preview.error).toBeUndefined();
    return quote.response.quoteId;
  }
  async function readActive(listeners) {
    const active = await send(listeners, 'FLUXIO_INTERNAL_GET_ACTIVE_SWAP');
    expect(active.error).toBeUndefined();
    return active.response;
  }

  it('allowance 0: the approve signs FIRST (nonce from ONE RPC read), then the swap signs locally at nonce + 1 after the approve receipt is 0x1 — two distinct broadcasts, stage ends at swap', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installTokenInMock({ receipts: [{ status: '0x1' }, null] });
    const quoteId = await quoteUsdtToBnb(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBe('approve');
    expect(result.response.twoStep).toBe(true);
    await vi.waitFor(async () => {
      const active = await readActive(listeners);
      expect(active.stage).toBe('swap');
    });
    // Two different signed payloads went out: the approve, then the swap.
    expect(capture.sendRawParams.length).toBeGreaterThanOrEqual(2);
    expect(capture.sendRawParams[0]).not.toBe(capture.sendRawParams[1]);
    // The swap nonce was computed LOCALLY (approve nonce + 1): exactly ONE
    // eth_getTransactionCount in the whole two-leg flow.
    expect(capture.nonceCalls).toBe(1);
    // The approve simulation ran against the TOKEN with real approve
    // calldata; the swap simulation ran against the ROUTER.
    expect(capture.estimateCalls[0].to.toLowerCase()).toBe(USDT_BEP20.toLowerCase());
    expect(capture.estimateCalls[0].data.startsWith('0x095ea7b3')).toBe(true);
    const routerAddr = BUILD_FIXTURE_TOKENIN.data.routerAddress.toLowerCase();
    expect(capture.estimateCalls.some((c) => String(c.to).toLowerCase() === routerAddr)).toBe(true);
    const active = await readActive(listeners);
    expect(active.swapHash).toBe('0x' + 'bb'.repeat(32));
    expect(active.explorerUrl).toContain('bscscan.com');
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('allowance already >= amountIn (K1): NO approve — one transaction, nonce from the RPC, Activity records inputMint = the token address', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installTokenInMock({
      allowanceHex: '0x' + AMOUNT_IN_RAW.toString(16),
      receipts: [null]
    });
    const quoteId = await quoteUsdtToBnb(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBeUndefined();
    expect(result.response.signature).toBe('0x' + 'aa'.repeat(32));
    expect(capture.sendRawParams.length).toBe(1);
    expect(capture.kyberBuilds).toBe(1);
    expect(capture.nonceCalls).toBe(1);
    // No approve was ever simulated or signed.
    expect(capture.estimateCalls.every((c) => !String(c.data || '').startsWith('0x095ea7b3'))).toBe(true);
    const entry = localStore.get('fluxio_tx_history').bnb[0];
    expect(entry.type).toBe('swap');
    expect(entry.inputMint).toBe(USDT_BEP20);
    expect(entry.outputMint).toBe('native');
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('approve receipt 0x0: the swap is NEVER signed — one broadcast total, stage halted with APPROVE_FAILED', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installTokenInMock({ receipts: [{ status: '0x0' }] });
    const quoteId = await quoteUsdtToBnb(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBe('approve');
    await vi.waitFor(async () => {
      const active = await readActive(listeners);
      expect(active.stage).toBe('halted');
      expect(active.haltReason).toBe('APPROVE_FAILED');
    });
    expect(capture.sendRawParams.length).toBe(1);
    expect(capture.kyberBuilds).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('quote shifts > 0,1% after the approve: halted with SWAP_QUOTE_CHANGED_AFTER_APPROVE, no build, no second broadcast (the approve stays, K2)', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const worse = JSON.parse(JSON.stringify(QUOTE_FIXTURE_TOKENIN));
    worse.data.routeSummary.amountOut = ((OUT_RAW_TOKENIN * 98n) / 100n).toString(); // -2%
    const capture = installTokenInMock({
      // call 1 = GET_SWAP_QUOTE, call 2 = EXECUTE's pre-approve freshness
      // check, call 3 = the continuation's own post-approve re-quote.
      routesResponses: [
        { status: 200, json: QUOTE_FIXTURE_TOKENIN },
        { status: 200, json: QUOTE_FIXTURE_TOKENIN },
        { status: 200, json: worse }
      ],
      receipts: [{ status: '0x1' }]
    });
    const quoteId = await quoteUsdtToBnb(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBe('approve');
    await vi.waitFor(async () => {
      const active = await readActive(listeners);
      expect(active.stage).toBe('halted');
      expect(active.haltReason).toBe('SWAP_QUOTE_CHANGED_AFTER_APPROVE');
    });
    expect(capture.sendRawParams.length).toBe(1);
    expect(capture.kyberBuilds).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('g2 swap ceiling (lesson 10): a tip raised between PREVIEW and the continuation halts the swap leg unsigned — the stored displayed ceiling is a hard cap', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installTokenInMock({
      // tip call 1 = PREVIEW (stores the swap ceiling), 2 = the approve
      // leg's own fee read, 3 = the continuation (raised 2x -> above cap).
      tipHexes: ['0x2faf080', '0x2faf080', '0x2faf080', '0x5f5e100'], // +1: preview di helper (0231 R2)
      receipts: [{ status: '0x1' }]
    });
    const quoteId = await quoteUsdtToBnb(listeners);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId });
    expect(preview.error).toBeUndefined();
    expect(preview.response.tokenIn).toBe(true);
    expect(preview.response.approveNeeded).toBe(true);
    // Combined row = approve ceiling + swap ceiling, both > 0.
    expect(BigInt(preview.response.maxFeeWei)).toBe(BigInt(preview.response.approveMaxFeeWei) + BigInt(preview.response.swapMaxFeeWei));
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBe('approve');
    await vi.waitFor(async () => {
      const active = await readActive(listeners);
      expect(active.stage).toBe('halted');
      // g2's OWN fee reason (0223 Revisi 3 tambahan) — never the
      // misleading quote-changed one: the amounts did not move here.
      expect(active.haltReason).toBe('EVM_SWAP_FEE_ABOVE_DISPLAYED');
    });
    expect(capture.sendRawParams.length).toBe(1); // approve only — the swap never signed
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('g2 on the EXECUTE side (0223 Revisi 3 tambahan): allowance sufficient, tip raised after PREVIEW — the response carries EVM_SWAP_FEE_ABOVE_DISPLAYED (not SWAP_QUOTE_CHANGED) with a NEW live quote, nothing signed', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installTokenInMock({
      allowanceHex: '0x' + AMOUNT_IN_RAW.toString(16), // approve skipped — the single-transaction path
      // tip call 1 = PREVIEW (stores the swap ceiling), 2 = EXECUTE's live
      // fee read (raised 4x: ceiling 268831x2x5e7 < gasLimit 322597x2e8).
      tipHexes: ['0x2faf080', '0x2faf080', '0xbebc200'], // +1: preview di helper (0231 R2)
      receipts: [null]
    });
    const quoteId = await quoteUsdtToBnb(listeners);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId });
    expect(preview.error).toBeUndefined();
    expect(preview.response.approveNeeded).toBe(false);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.quoteChanged).toBe(true);
    expect(result.response.code).toBe('EVM_SWAP_FEE_ABOVE_DISPLAYED');
    expect(result.response.quote.quoteId).not.toBe(quoteId);
    expect(capture.sendRawParams.length).toBe(0); // nothing signed, nothing broadcast
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('locked session at the continuation (K2 condition ii): the wallet locks BEFORE the approve receipt lands — honest halt, the swap never signed', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installTokenInMock({
      receipts: [async () => {
        // The lock completes BEFORE the receipt resolves — deterministic,
        // no sleep-based racing.
        await send(listeners, 'FLUXIO_INTERNAL_LOCK');
        return { status: '0x1' };
      }]
    });
    const quoteId = await quoteUsdtToBnb(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBe('approve');
    await vi.waitFor(async () => {
      const active = await readActive(listeners);
      expect(active.stage).toBe('halted');
      expect(active.haltReason).toBe('SWAP_NOT_SENT');
    });
    expect(capture.sendRawParams.length).toBe(1);
    expect(capture.kyberBuilds).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('worker restart + alarm wake path: a FRESH bundle instance continues the staged swap and signs it with NO message and NO click — session hydrated from storage, nonce still local', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installTokenInMock({ receipts: [null] });
    const quoteId = await quoteUsdtToBnb(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBe('approve');
    const sendsBefore = capture.sendRawParams.length; // approve (+ maybe one re-send)

    // "Worker dies": a fresh bundle instance takes over this globalThis —
    // the old loop exits via the generation token; the staged state and
    // the unlocked session BOTH live in chrome.storage.session, exactly
    // like a real MV3 restart. The approve receipt now reads 0x1 — and the
    // override serves EVERY receipt read, so the signed swap confirms
    // immediately too: the fresh instance runs the WHOLE rest of the flow
    // (continuation, swap broadcast, verdict, state cleared).
    capture.receiptValueOverride = { status: '0x1' };
    await importFreshBundle();
    // Fire the re-broadcast alarm — one of the three sanctioned wake paths
    // (module init already nudges too; the alarm is the one under test).
    for (const fire of listeners.onAlarm || []) {
      fire({ name: 'fluxio-swap-rebroadcast' });
    }
    // A NEW broadcast happened without any click or message driving it,
    // and the Activity entry reached its confirmed verdict end to end.
    await vi.waitFor(() => {
      expect(capture.sendRawParams.length).toBeGreaterThan(sendsBefore);
      const entries = localStore.get('fluxio_tx_history')?.bnb || [];
      const swapEntry = entries.find((e) => e.type === 'swap');
      expect(swapEntry?.inputMint).toBe(USDT_BEP20);
      expect(swapEntry?.status).toBe('confirmed');
    });
    expect(capture.sendRawParams[capture.sendRawParams.length - 1]).not.toBe(capture.sendRawParams[0]);
    expect(capture.nonceCalls).toBe(1); // the swap nonce stayed LOCAL across the restart
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('K4 same-block correction (0223 Revisi 1): approve and swap in ONE block — the real received adds the approve gas back, exact to the wei', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    // Receipt field shapes mirror the real 0221 receipt (hex blockNumber /
    // gasUsed / effectiveGasPrice). Both legs land in block 0x79f4d31.
    // The approve figures are the REAL attempt-1 receipt's own (0223
    // Revisi 3 butir f, hash 0x4b20…7ddf reconciled on two endpoints):
    // block 128272398 = 0x7a5480e, gasUsed 46.194 = 0xb472, 0,05 gwei.
    const APPROVE_RECEIPT = { status: '0x1', blockNumber: '0x7a5480e', gasUsed: '0xb472', effectiveGasPrice: '0x2faf080' };
    const SWAP_RECEIPT = { status: '0x1', blockNumber: '0x7a5480e', gasUsed: '0x31e8c', effectiveGasPrice: '0x2faf080', logs: [] }; // 204.428 gas
    const EXPECTED_RECEIVED = 692616267379369n; // the build fixture's own amountOut — inside the K4 bounds
    const BEFORE = 10000000000000000n; // 0.01 BNB at block N-1
    const DELTA = EXPECTED_RECEIVED - 204428n * 50000000n - 46194n * 50000000n; // the chain delta carries BOTH legs' gas
    const capture = installTokenInMock({
      receipts: [APPROVE_RECEIPT, SWAP_RECEIPT],
      balanceByBlock: {
        '0x7a5480d': '0x' + BEFORE.toString(16),
        '0x7a5480e': '0x' + (BEFORE + DELTA).toString(16)
      }
    });
    const quoteId = await quoteUsdtToBnb(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBe('approve');
    await vi.waitFor(() => {
      const entries = localStore.get('fluxio_tx_history')?.bnb || [];
      const swapEntry = entries.find((e) => e.type === 'swap');
      expect(swapEntry?.status).toBe('confirmed');
      expect(swapEntry?.approveBlockNumber).toBe('0x7a5480e');
      expect(swapEntry?.receivedRealRaw).toBe(EXPECTED_RECEIVED.toString());
    });
    expect(capture.sendRawParams.length).toBeGreaterThanOrEqual(2);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('genuine revert at the continuation (0223 Revisi 1; REVISI SADAR 0228 Revisi 1: revert hanya vonis bila allowance segar sudah menyamai amountIn — allowance basi kini RETRY, bukan halt): halts SWAP_NOT_SENT on the first tick with the allowance PROPAGATED', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installTokenInMock({
      // EXECUTE membaca 0 (kaki approve jalan); pembacaan pasca-revert
      // membaca amountIn PENUH (state sudah sampai) -> revert = nyata.
      allowanceHexes: ['0x0', '0x0', '0x' + (500000000000000000n).toString(16)], // +1 depan: preview helper
      receipts: [{ status: '0x1' }],
      swapEstimateError: { code: 3, message: 'execution reverted: TransferHelper: TRANSFER_FROM_FAILED' }
    });
    const quoteId = await quoteUsdtToBnb(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBe('approve');
    await vi.waitFor(async () => {
      const active = await readActive(listeners);
      expect(active.stage).toBe('halted');
      expect(active.haltReason).toBe('SWAP_NOT_SENT');
    });
    expect(capture.kyberBuilds).toBe(1); // the one continuation build — a retry loop would have made more
    expect(capture.sendRawParams.length).toBe(1); // approve only
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('K8 (0223 Revisi 3): a fresh quote 0,3% lower but still above the displayed minimum PROCEEDS, with the build slippage re-derived — and the fresh-quote URL is byte-identical to the Review quote URL', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const OUT_DISPLAYED = OUT_RAW_TOKENIN; // 692616267379370
    const lower = JSON.parse(JSON.stringify(QUOTE_FIXTURE_TOKENIN));
    const OUT_FRESH = (OUT_DISPLAYED * 997n) / 1000n; // -0,3%: below the old 0,1% band, ABOVE the 0,5% minimum
    lower.data.routeSummary.amountOut = OUT_FRESH.toString();
    const capture = installTokenInMock({
      routesResponses: [
        { status: 200, json: QUOTE_FIXTURE_TOKENIN }, // GET_SWAP_QUOTE (Review)
        { status: 200, json: lower }, // EXECUTE's pre-approve freshness check (min gate too)
        { status: 200, json: lower } // the continuation's own re-quote
      ],
      receipts: [{ status: '0x1' }, null]
    });
    const quoteId = await quoteUsdtToBnb(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBe('approve'); // the old 0,1% band would have bounced this BEFORE the approve
    await vi.waitFor(async () => {
      const active = await readActive(listeners);
      expect(active.stage).toBe('swap');
    });
    // The build ran with the K8 re-derived slippage:
    // min(50, floor((fresh − displayedMin) × 10000 / fresh)).
    const displayedMin = (OUT_DISPLAYED * 9950n) / 10000n;
    const expectedBps = Number(((OUT_FRESH - displayedMin) * 10000n) / OUT_FRESH);
    expect(expectedBps).toBeLessThan(50); // the derived floor is the binding one here
    expect(capture.kyberBuilds).toBe(1);
    expect(capture.buildBodies[0].slippageTolerance).toBe(expectedBps);
    // Owner test (d): the fresh quote is built by the SAME function with
    // the SAME parameters — the routes URLs are byte-identical.
    expect(capture.kyberUrls.length).toBe(3);
    expect(capture.kyberUrls[1]).toBe(capture.kyberUrls[0]);
    expect(capture.kyberUrls[2]).toBe(capture.kyberUrls[0]);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('K8: a fresh quote 0,6% lower (below the displayed minimum) halts with SWAP_QUOTE_CHANGED_AFTER_APPROVE and never builds', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const lower = JSON.parse(JSON.stringify(QUOTE_FIXTURE_TOKENIN));
    lower.data.routeSummary.amountOut = ((OUT_RAW_TOKENIN * 994n) / 1000n).toString(); // -0,6% < the 0,5% minimum
    const capture = installTokenInMock({
      routesResponses: [
        { status: 200, json: QUOTE_FIXTURE_TOKENIN },
        { status: 200, json: QUOTE_FIXTURE_TOKENIN }, // pre-approve check passes on the identical quote
        { status: 200, json: lower } // the continuation sees the real drop
      ],
      receipts: [{ status: '0x1' }]
    });
    const quoteId = await quoteUsdtToBnb(listeners);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    expect(result.error).toBeUndefined();
    await vi.waitFor(async () => {
      const active = await readActive(listeners);
      expect(active.stage).toBe('halted');
      expect(active.haltReason).toBe('SWAP_QUOTE_CHANGED_AFTER_APPROVE');
    });
    expect(capture.kyberBuilds).toBe(0);
    expect(capture.sendRawParams.length).toBe(1); // approve only
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('Activity (0223 Revisi 3): approve confirmed + halt leaves EXACTLY one Approval entry CONFIRMED and zero Swap entries — the spent gas has a trace', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const lower = JSON.parse(JSON.stringify(QUOTE_FIXTURE_TOKENIN));
    lower.data.routeSummary.amountOut = ((OUT_RAW_TOKENIN * 994n) / 1000n).toString();
    const capture = installTokenInMock({
      routesResponses: [
        { status: 200, json: QUOTE_FIXTURE_TOKENIN },
        { status: 200, json: QUOTE_FIXTURE_TOKENIN },
        { status: 200, json: lower }
      ],
      // The REAL attempt-1 approve receipt figures (butir f).
      receipts: [{ status: '0x1', blockNumber: '0x7a5480e', gasUsed: '0xb472', effectiveGasPrice: '0x2faf080' }]
    });
    const quoteId = await quoteUsdtToBnb(listeners);
    await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    await vi.waitFor(async () => {
      const active = await readActive(listeners);
      expect(active.stage).toBe('halted');
    });
    const history = await send(listeners, 'FLUXIO_INTERNAL_GET_HISTORY', { networkKey: 'bnb' });
    expect(history.error).toBeUndefined();
    const approvals = history.response.entries.filter((e) => e.type === 'approval');
    const swaps = history.response.entries.filter((e) => e.type === 'swap');
    expect(approvals.length).toBe(1);
    expect(swaps.length).toBe(0);
    expect(approvals[0].status).toBe('confirmed');
    expect(approvals[0].tokenSymbol).toBe('USDT');
    expect(approvals[0].amountFormatted).toBe('0.500000000000000000'); // formatUnits keeps the full 18 decimals; the popup trims at render (trimAmount)
    expect(approvals[0].explorerUrl).toContain('bscscan.com');
    expect(approvals[0].explorerUrl.includes('cluster')).toBe(false);
    expect(capture.sendRawParams.length).toBe(1);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('Activity: the full two-leg success leaves ONE Approval and ONE Swap entry, both confirmed', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installTokenInMock({
      receipts: [
        { status: '0x1', blockNumber: '0x7a5480e', gasUsed: '0xb472', effectiveGasPrice: '0x2faf080' }, // the real approve figures
        { status: '0x1', blockNumber: '0x7a54810', gasUsed: '0x31e8c', effectiveGasPrice: '0x2faf080', logs: [] } // swap, later block
      ]
    });
    const quoteId = await quoteUsdtToBnb(listeners);
    await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'bnb' });
    await vi.waitFor(async () => {
      const history = await send(listeners, 'FLUXIO_INTERNAL_GET_HISTORY', { networkKey: 'bnb' });
      expect(history.error).toBeUndefined();
      const approvals = history.response.entries.filter((e) => e.type === 'approval');
      const swaps = history.response.entries.filter((e) => e.type === 'swap');
      expect(approvals.length).toBe(1);
      expect(swaps.length).toBe(1);
      expect(approvals[0].status).toBe('confirmed');
      expect(swaps[0].status).toBe('confirmed');
    });
    expect(capture.sendRawParams.length).toBeGreaterThanOrEqual(2);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);
});


// ---- 0227 (owner keputusan 0225 K1-K8): Ethereum + Base EXECUTE ----------
// Fixtures: the REAL 0225 full payloads (prompt/evidence/0225-evm-swap-
// spike-eth-base/) — dilarang fixture karangan (PRASYARAT 0227 butir 6).

describe('background.bundle.js — EVM swap on Ethereum and Base (prompt 0227, 0225 K1/K2/K4/K5/K8)', () => {
  const FIXTURE_DIR_0225 = path.join(__dirname, '..', '..', '..', 'prompt', 'evidence', '0225-evm-swap-spike-eth-base');
  const FIX = {
    ethereum: {
      quoteNative: JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-quote-eth-native2usdc.json'), 'utf8')),
      buildNative: JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-build-eth-native2usdc.json'), 'utf8')),
      quoteTokenIn: JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-quote-eth-usdc2native.json'), 'utf8')),
      buildTokenIn: JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-build-eth-usdc2native.json'), 'utf8')),
      slug: 'ethereum',
      usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      nativeAmount: '0.002',
      nativeValue: 2000000000000000n,
      explorerHost: 'etherscan.io',
      chainId: 1n
    },
    base: {
      quoteNative: JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-quote-base-native2usdc.json'), 'utf8')),
      buildNative: JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-build-base-native2usdc.json'), 'utf8')),
      quoteTokenIn: JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-quote-base-usdc2native.json'), 'utf8')),
      buildTokenIn: JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-build-base-usdc2native.json'), 'utf8')),
      slug: 'base',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      nativeAmount: '0.001',
      nativeValue: 1000000000000000n,
      explorerHost: 'basescan.org',
      chainId: 8453n
    }
  };

  /**
   * Minimal RLP reader for a SIGNED type-2 tx (0x02 || rlp(list)) — just
   * enough to read the first items (chainId, nonce, ..., value at index
   * 6) so the tests can prove what was actually signed without pulling
   * ethers into this package. Nested lists (accessList) are beyond index
   * 6 and never reached.
   */
  function readSignedType2Items(rawHex, upTo = 7) {
    const bytes = Buffer.from(rawHex.replace(/^0x/, ''), 'hex');
    expect(bytes[0]).toBe(0x02);
    let i = 1;
    // Outer list header.
    const listPrefix = bytes[i++];
    if (listPrefix >= 0xf8) {
      i += listPrefix - 0xf7; // long list: skip the length bytes
    } else {
      expect(listPrefix).toBeGreaterThanOrEqual(0xc0);
    }
    const items = [];
    while (items.length < upTo && i < bytes.length) {
      const b = bytes[i];
      if (b < 0x80) {
        items.push(BigInt(b));
        i += 1;
      } else if (b < 0xb8) {
        const len = b - 0x80;
        let v = 0n;
        for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(bytes[i + 1 + k]);
        items.push(v);
        i += 1 + len;
      } else if (b < 0xc0) {
        const lenOfLen = b - 0xb7;
        let len = 0;
        for (let k = 0; k < lenOfLen; k++) len = len * 256 + bytes[i + 1 + k];
        let v = 0n;
        for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(bytes[i + 1 + lenOfLen + k]);
        items.push(v);
        i += 1 + lenOfLen + len;
      } else {
        break; // a nested list (accessList) — nothing past here is needed
      }
    }
    return items; // [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value]
  }

  /** One fetch mock per network: Kyber (slug URLs) + the network's JSON-RPC, same shape as installTokenInMock above. */
  function installNetworkMock(net, opts = {}) {
    const {
      quoteJson = net.quoteNative,
      buildJson = net.buildNative,
      allowanceHex = '0x0',
      tokenBalanceHex = '0x' + (10n ** 6n).toString(16), // 1.0 USDC held (6 decimals)
      balanceHex = '0x2386f26fc10000', // 0.01 native — covers every ceiling
      balanceByBlock = {},
      blockNumberHexes = ['0xffffff'], // 0232 R3: antrean eth_blockNumber (entri terakhir berulang); default jauh di atas receipt supaya lock lama tetap
      tipHex = '0x2faf080', // 0,05 gwei (under every cap)
      receipts = [null],
      sendRawHashes = ['0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(32)]
    } = opts;
    const capture = { kyberUrls: [], kyberBuilds: 0, methods: [], sendRawParams: [], estimateCalls: [], receiptCalls: 0, nonceCalls: 0 };
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.includes('lite-api.jup.ag')) throw new Error('Jupiter must never be touched on the EVM path');
      if (u.startsWith(`https://aggregator-api.kyberswap.com/${net.slug}/api/v1/routes`)) {
        capture.kyberUrls.push(u);
        return { ok: true, status: 200, json: async () => quoteJson };
      }
      if (u.startsWith(`https://aggregator-api.kyberswap.com/${net.slug}/api/v1/route/build`)) {
        capture.kyberBuilds++;
        return { ok: true, status: 200, json: async () => buildJson };
      }
      if (u.includes('aggregator-api.kyberswap.com')) throw new Error(`Wrong Kyber slug for ${net.slug}: ${u}`);
      const { method, params } = JSON.parse(options.body);
      capture.methods.push(method);
      const rpc = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
      if (method === 'eth_getBlockByNumber') return rpc({ baseFeePerGas: '0x0' });
      if (method === 'eth_blockNumber') {
        const idx = Math.min((capture.blockNumberCalls = (capture.blockNumberCalls || 0) + 1) - 1, blockNumberHexes.length - 1);
        return rpc(blockNumberHexes[idx]);
      }
      if (method === 'eth_maxPriorityFeePerGas') return rpc(tipHex);
      if (method === 'eth_call') {
        const data = String(params[0]?.data || '');
        if (data.startsWith('0xdd62ed3e')) return rpc('0x' + BigInt(allowanceHex).toString(16).padStart(64, '0'));
        if (data.startsWith('0x70a08231')) return rpc('0x' + BigInt(tokenBalanceHex).toString(16).padStart(64, '0'));
        throw new Error(`Unexpected eth_call selector: ${data.slice(0, 10)}`);
      }
      if (method === 'eth_getBalance') {
        const tag = String(params[1] ?? 'latest');
        return rpc(balanceByBlock[tag] != null ? balanceByBlock[tag] : balanceHex);
      }
      if (method === 'eth_getTransactionCount') {
        capture.nonceCalls++;
        return rpc('0x6');
      }
      if (method === 'eth_estimateGas') {
        capture.estimateCalls.push(params[0]);
        return rpc('0x41a1f'); // 268.831 — under every per-network gas cap x1,2
      }
      if (method === 'eth_sendRawTransaction') {
        capture.sendRawParams.push(params[0]);
        return rpc(sendRawHashes[Math.min(capture.sendRawParams.length - 1, sendRawHashes.length - 1)]);
      }
      if (method === 'eth_getTransactionReceipt') {
        const idx = Math.min(capture.receiptCalls++, receipts.length - 1);
        return rpc(receipts[idx]);
      }
      throw new Error(`Unexpected RPC in 0227 test: ${method}`);
    };
    return capture;
  }

  async function quoteNativeIn(listeners, netKey) {
    const net = FIX[netKey];
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', {
      networkKey: netKey,
      inputMint: 'native',
      outputMint: net.usdc,
      amount: net.nativeAmount,
      inputDecimals: 18,
      outputDecimals: 6,
      slippageBps: 50,
      inputSymbol: 'ETH',
      outputSymbol: 'USDC'
    });
    expect(quote.error).toBeUndefined();
    return quote.response.quoteId;
  }
  async function quoteTokenIn(listeners, netKey) {
    const net = FIX[netKey];
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', {
      networkKey: netKey,
      inputMint: net.usdc,
      outputMint: 'native',
      amount: '0.5',
      inputDecimals: 6,
      outputDecimals: 18,
      slippageBps: 50,
      inputSymbol: 'USDC',
      outputSymbol: 'ETH'
    });
    expect(quote.error).toBeUndefined();
    // 0231 Revisi 2 (owner P1): popup selalu PREVIEW di Review dan token-in
    // kini fail closed tanpa plafon tampil — helper meniru alur nyata.
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.response.quoteId });
    expect(preview.error).toBeUndefined();
    return quote.response.quoteId;
  }

  for (const netKey of ['ethereum', 'base']) {
    it(`${netKey}: EXECUTE native-in broadcasts exactly ONE tx with the network's own chainId, the router as to, value = amountIn, fee echo passing — proven from the SIGNED bytes`, async () => {
      const net = FIX[netKey];
      const { listeners, localStore } = installFakeChromeForBackground();
      await importFreshBundle();
      await importWallet(listeners);
      const capture = installNetworkMock(net);
      const quoteId = await quoteNativeIn(listeners, netKey);
      const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: netKey });
      expect(result.error).toBeUndefined();
      expect(result.response.signature).toBe('0x' + 'aa'.repeat(32));
      expect(result.response.explorerUrl).toContain(net.explorerHost);
      expect(capture.sendRawParams.length).toBe(1);
      expect(capture.kyberBuilds).toBe(1);
      expect(capture.kyberUrls.every((u) => u.includes(`/${net.slug}/`))).toBe(true);
      const [chainId, nonce, , , , to, value] = readSignedType2Items(capture.sendRawParams[0]);
      expect(chainId).toBe(net.chainId); // 0225 K5: from NETWORKS, never 56
      expect(nonce).toBe(6n);
      expect('0x' + to.toString(16).padStart(40, '0')).toBe(net.buildNative.data.routerAddress.toLowerCase());
      expect(value).toBe(net.nativeValue); // value = amountIn EXACTLY
      const entry = localStore.get('fluxio_tx_history')[netKey][0];
      expect(entry.type).toBe('swap');
      expect(entry.inputMint).toBe('native');
      delete globalThis.fetch;
      delete globalThis.chrome;
    }, E2E_TIMEOUT_MS);
  }

  it('cap ethereum (0225 K2): a 11 gwei fee refuses with EVM_SWAP_GAS_PRICE_ABOVE_CAP and zero broadcasts (10 gwei is the ethereum cap)', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installNetworkMock(FIX.ethereum, { tipHex: '0x28fa6ae00' }); // 11 gwei
    const quoteId = await quoteNativeIn(listeners, 'ethereum');
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'ethereum' });
    expect(result.error).toContain('EVM_SWAP_GAS_PRICE_ABOVE_CAP');
    expect(result.error).toContain('No funds moved');
    expect(capture.sendRawParams.length).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('cap base (0225 K2): a 0,6 gwei fee refuses on base (0,5 gwei cap) while the SAME fee passes the bnb cap untouched — per-network, never shared', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installNetworkMock(FIX.base, { tipHex: '0x23c34600' }); // 0,6 gwei
    const quoteId = await quoteNativeIn(listeners, 'base');
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.error).toContain('EVM_SWAP_GAS_PRICE_ABOVE_CAP');
    expect(capture.sendRawParams.length).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('sanity guard K4, token-in on bnb NOW CHECKED (behavior change, recorded): absurd cached prices refuse with EVM_SWAP_QUOTE_SUSPICIOUS before any allowance read, zero broadcasts', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    // The 0223 bnb token-in fixture through the 0223 mock shape: reuse the
    // 0225 mock is wrong-slugged for bnb, so serve the bnb fixture inline.
    const QUOTE_BNB_TOKENIN = JSON.parse(readFileSync(path.join(__dirname, '..', '..', '..', 'prompt', 'evidence', '0223-evm-swap-token-in', 'quote-usdt2bnb-fee.json'), 'utf8'));
    const USDT_BEP20_LOCAL = '0x55d398326f99059fF775485246999027B3197955';
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.startsWith('https://aggregator-api.kyberswap.com/bsc/api/v1/routes')) {
        return { ok: true, status: 200, json: async () => QUOTE_BNB_TOKENIN };
      }
      throw new Error(`No RPC expected before the sanity refusal: ${u.slice(0, 60)}`);
    };
    localStore.set('fluxio_portfolio_price_cache', {
      pricesByCoinId: {
        // 10x USDT price: the input leg reads ~$5 while the output leg
        // reads ~$0,5 — far beyond 5%. Pre-0227 this SKIPPED (the native
        // output side resolved no coin id at all).
        'binance-bridged-usdt-bnb-smart-chain': { usd: 10 },
        binancecoin: { usd: 733.8 }
      },
      fetchedAt: Date.now()
    });
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', {
      networkKey: 'bnb', inputMint: USDT_BEP20_LOCAL, outputMint: 'native', amount: '0.5',
      inputDecimals: 18, outputDecimals: 18, slippageBps: 50, inputSymbol: 'USDT', outputSymbol: 'BNB'
    });
    expect(quote.error).toBeUndefined();
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'bnb' });
    expect(result.error).toContain('EVM_SWAP_QUOTE_SUSPICIOUS');
    expect(result.error).toContain('No funds moved');
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('sanity guard K4, token-in on ethereum: USDC price 10x off refuses the same way (usd-coin via the registry, native side via the per-network map)', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installNetworkMock(FIX.ethereum, { quoteJson: FIX.ethereum.quoteTokenIn, buildJson: FIX.ethereum.buildTokenIn });
    localStore.set('fluxio_portfolio_price_cache', {
      pricesByCoinId: {
        'usd-coin': { usd: 10 }, // absurd — input leg ~$5 vs output ~$0,5
        ethereum: { usd: 2407 }
      },
      fetchedAt: Date.now()
    });
    const quoteId = await quoteTokenIn(listeners, 'ethereum');
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'ethereum' });
    expect(result.error).toContain('EVM_SWAP_QUOTE_SUSPICIOUS');
    expect(capture.sendRawParams.length).toBe(0);
    expect(capture.kyberBuilds).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('approve RESET (0225 K8) on base: allowance 0x3d090 (250000) under amountIn 500000 sends THREE legs — approve(0), approve(amountIn), swap — at LOCAL nonces 6, 7, 8 with three Activity entries (reset row amount 0)', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installNetworkMock(FIX.base, {
      quoteJson: FIX.base.quoteTokenIn,
      buildJson: FIX.base.buildTokenIn,
      allowanceHex: '0x3d090', // 250000 raw: 0 < allowance < 500000
      receipts: [{ status: '0x1' }, { status: '0x1' }, null]
    });
    const quoteId = await quoteTokenIn(listeners, 'base');
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBe('approveReset');
    expect(result.response.threeStep).toBe(true);
    await vi.waitFor(async () => {
      const active = await send(listeners, 'FLUXIO_INTERNAL_GET_ACTIVE_SWAP');
      expect(active.response.stage).toBe('swap');
    });
    // THREE DISTINCT signed payloads at consecutive LOCAL nonces — any
    // 4th send is the loop's identical-bytes re-broadcast of the swap leg
    // (by design, swap lesson 1), never a new signature.
    const uniquePayloads = [...new Set(capture.sendRawParams)];
    expect(uniquePayloads.length).toBe(3);
    expect(capture.sendRawParams.length).toBeGreaterThanOrEqual(3);
    expect(capture.sendRawParams.slice(3).every((raw) => uniquePayloads.includes(raw))).toBe(true);
    expect(capture.nonceCalls).toBe(1);
    const legs = uniquePayloads.map((raw) => readSignedType2Items(raw, 8));
    expect(legs.map((l) => l[1])).toEqual([6n, 7n, 8n]); // nonceReset, +1, +2
    expect(legs.every((l) => l[0] === 8453n)).toBe(true);
    // Leg 1 approve(0) at the TOKEN, leg 2 approve(500000) at the token,
    // leg 3 the swap at the ROUTER — read from the simulations' own
    // calldata (the same bytes the signed legs carry).
    // 0231 R2: estimateCalls[0] kini milik PREVIEW di helper (estimasi
    // reset yang sama persis) — indeks kaki EXECUTE bergeser +1.
    const approveZero = capture.estimateCalls[1];
    expect(String(approveZero.to).toLowerCase()).toBe(FIX.base.usdc.toLowerCase());
    expect(String(approveZero.data).startsWith('0x095ea7b3')).toBe(true);
    expect(String(approveZero.data).endsWith('0'.repeat(64))).toBe(true);
    const approveAmount = capture.estimateCalls[2];
    expect(String(approveAmount.to).toLowerCase()).toBe(FIX.base.usdc.toLowerCase());
    expect(String(approveAmount.data).endsWith(BigInt(500000).toString(16).padStart(64, '0'))).toBe(true);
    const swapSim = capture.estimateCalls[3];
    expect(String(swapSim.to).toLowerCase()).toBe(FIX.base.buildTokenIn.data.routerAddress.toLowerCase());
    // Three Activity entries: reset (amount 0, kind reset), approve, swap.
    const entries = localStore.get('fluxio_tx_history').base;
    expect(entries.length).toBe(3);
    const reset = entries.find((e) => e.approvalKind === 'reset');
    expect(reset.type).toBe('approval');
    expect(reset.amountRaw).toBe('0');
    expect(entries.filter((e) => e.type === 'approval').length).toBe(2);
    expect(entries.find((e) => e.type === 'swap').inputMint).toBe(FIX.base.usdc);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('(0232 R3, fixture insiden Base) received TIDAK terkunci dari receipt muda: baca #1 (latest = blok, l1Fee 22.257.870.609) menahan est., baca #2 (latest >= blok+2, l1Fee kanonis 99.847.647.673) MENIMPA dan mengunci 124.311.206.770.766 persis', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    // Angka L1 = PERSIS insiden (muda 22.257.870.609, kanonis 99.847.647.673
    // — selisih 77.589.777.064). Skala received disesuaikan ke bounds fixture
    // quote (min 206.041.825.518.336) karena bounds entry berasal dari quote;
    // penyimpangan sadar dari angka insiden 124.311.206.770.766, mekanisme
    // yang dikunci identik. Baca #1 DI DALAM bounds (kode lama akan mengunci
    // angka salah itu) — kode baru menahannya.
    const R = 207000000000000n;
    const gasUsed = 264328n;
    const effPrice = 6000000n;
    const l1Muda = 22257870609n;
    const l1Kanonis = 99847647673n;
    const before = 2161158372072305n;
    const after = before + R - gasUsed * effPrice - l1Kanonis;
    const blockHex = '0x' + (52946450).toString(16);
    const capture = installNetworkMock(FIX.base, {
      quoteJson: FIX.base.quoteTokenIn,
      buildJson: FIX.base.buildTokenIn,
      allowanceHex: '0x' + (10n ** 6n).toString(16), // satu kaki (approve dilewati)
      // Persis pola insiden: l1 muda terbaca SEKALI di awal, semua bacaan
      // berikutnya kanonis. Jumlah run resolver sebelum status pertama tidak
      // deterministik (loop punya bacaan receipt sendiri + tick langsung),
      // jadi asersi di bawah mengunci PROPERTI pembunuh insiden: nilai yang
      // terkunci TIDAK PERNAH angka berbasis l1 muda, dan final = kanonis.
      receipts: [
        { status: '0x1', blockNumber: blockHex, gasUsed: '0x' + gasUsed.toString(16), effectiveGasPrice: '0x' + effPrice.toString(16), l1Fee: '0x' + l1Muda.toString(16), logs: [] },
        { status: '0x1', blockNumber: blockHex, gasUsed: '0x' + gasUsed.toString(16), effectiveGasPrice: '0x' + effPrice.toString(16), l1Fee: '0x' + l1Kanonis.toString(16), logs: [] }
      ],
      balanceByBlock: {
        ['0x' + (52946450).toString(16)]: '0x' + after.toString(16),
        ['0x' + (52946449).toString(16)]: '0x' + before.toString(16)
      },
      blockNumberHexes: ['0x' + (52946450).toString(16), '0x' + (52946450).toString(16), '0x' + (52946452).toString(16)]
    });
    const quoteId = await quoteTokenIn(listeners, 'base');
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    const angkaMuda = (R - 77589777064n).toString(); // nilai yang kode LAMA kunci pada insiden
    const status1 = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature: result.response.signature, networkKey: 'base' });
    expect(status1.response.status).toBe('confirmed');
    expect(status1.response.receivedRealRaw === angkaMuda).toBe(false); // TIDAK PERNAH angka l1 muda
    const status2 = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature: result.response.signature, networkKey: 'base' });
    const status3 = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature: result.response.signature, networkKey: 'base' });
    expect(status3.response.receivedRealRaw).toBe(R.toString()); // final SELALU kanonis
    expect([null, undefined, R.toString()]).toContain(status2.response.receivedRealRaw); // tidak pernah angka muda di titik mana pun
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('(0232 R3) dua pembacaan berturut dengan l1Fee IDENTIK mengunci walau latest belum blok+2 (aturan kedua)', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const R = 207000000000000n;
    const gasUsed = 264328n;
    const effPrice = 6000000n;
    const l1 = 99847647673n;
    const before = 2161158372072305n;
    const after = before + R - gasUsed * effPrice - l1;
    const blockHex = '0x' + (52946450).toString(16);
    const capture = installNetworkMock(FIX.base, {
      quoteJson: FIX.base.quoteTokenIn,
      buildJson: FIX.base.buildTokenIn,
      allowanceHex: '0x' + (10n ** 6n).toString(16),
      receipts: [
        { status: '0x1', blockNumber: blockHex, gasUsed: '0x' + gasUsed.toString(16), effectiveGasPrice: '0x' + effPrice.toString(16), l1Fee: '0x' + l1.toString(16), logs: [] }
      ],
      balanceByBlock: {
        ['0x' + (52946450).toString(16)]: '0x' + after.toString(16),
        ['0x' + (52946449).toString(16)]: '0x' + before.toString(16)
      },
      blockNumberHexes: ['0x' + (52946450).toString(16)] // latest tidak pernah maju
    });
    const quoteId = await quoteTokenIn(listeners, 'base');
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    // Pembacaan #1 = tick loop langsung pasca EXECUTE (pending tersimpan);
    // status di bawah = pembacaan #2 dengan l1 identik -> terkunci lewat
    // ATURAN KEDUA (latest tidak pernah mencapai blok+2, aturan pertama
    // mustahil — dibuktikan lewat jumlah panggilan eth_blockNumber).
    const s1 = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature: result.response.signature, networkKey: 'base' });
    expect(s1.response.receivedRealRaw).toBe(R.toString());
    expect(capture.blockNumberCalls).toBe(2); // dua run resolver, latest selalu = blok
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('(0232 R3) Ethereum (tanpa oracle l1) TETAP mengunci di pembacaan pertama — output token via log Transfer (fixture 0xc29a: 2.358.766 raw)', async () => {
    const { listeners, localStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const ethReceipts = [null]; // dimutasi setelah alamat diketahui (handler membaca live)
    const capture = installNetworkMock(FIX.ethereum, {
      quoteJson: FIX.ethereum.quoteNative,
      buildJson: FIX.ethereum.buildNative,
      receipts: ethReceipts
    });
    const quoteId = await quoteNativeIn(listeners, 'ethereum');
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'ethereum' });
    expect(result.error).toBeUndefined();
    // Bangun receipt dengan log Transfer USDC ke dompet (alamat dari entry
    // history yang baru saja ditulis) lalu arahkan mock receipt ke sana.
    const entry = (localStore.get('fluxio_tx_history').ethereum || []).find((e) => e.type === 'swap');
    expect(entry).toBeTruthy();
    const owner = entry.ownerAddress.toLowerCase().replace('0x', '').padStart(64, '0');
    ethReceipts[0] = {
      status: '0x1',
      blockNumber: '0x1909a36',
      gasUsed: '0x3e0cd',
      effectiveGasPrice: '0x3a9f5106',
      logs: [
        { address: FIX.ethereum.usdc, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), '0x' + owner], data: '0x' + (2358766n).toString(16).padStart(64, '0') }
      ]
    };
    const status1 = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature: result.response.signature, networkKey: 'ethereum' });
    expect(status1.response.status).toBe('confirmed');
    expect(status1.response.receivedRealRaw).toBe('2358766'); // pembacaan PERTAMA langsung terkunci — perilaku ethereum tidak berubah
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('received native on base ADDS the receipt\'s own l1Fee (0226-proven field): SWAP_STATUS returns the exact K4 figure', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const R = 207000000000000n; // inside [minReceived, 2x out] for the base token-in fixture
    const gasUsed = 300000n;
    const effPrice = 50000000n;
    const l1Fee = 2195885060n; // the REAL 0226 Base receipt figure
    const before = 10n ** 16n;
    const after = before + R - gasUsed * effPrice - l1Fee;
    const capture = installNetworkMock(FIX.base, {
      quoteJson: FIX.base.quoteTokenIn,
      buildJson: FIX.base.buildTokenIn,
      allowanceHex: '0x' + (10n ** 6n).toString(16), // covers amountIn: single-leg swap
      receipts: [
        {
          status: '0x1',
          blockNumber: '0x10',
          gasUsed: '0x' + gasUsed.toString(16),
          effectiveGasPrice: '0x' + effPrice.toString(16),
          l1Fee: '0x' + l1Fee.toString(16),
          logs: []
        }
      ],
      balanceByBlock: {
        '0x10': '0x' + after.toString(16),
        '0xf': '0x' + before.toString(16)
      }
    });
    const quoteId = await quoteTokenIn(listeners, 'base');
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature: result.response.signature, networkKey: 'base' });
    expect(status.error).toBeUndefined();
    expect(status.response.status).toBe('confirmed');
    // delta + gas + l1Fee — without the l1Fee term this would undercount
    // by exactly 2.195.885.060 wei (the 0226 lesson in swap form).
    expect(status.response.receivedRealRaw).toBe(R.toString());
    expect(capture.sendRawParams.length).toBe(1);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);
});


// ---- 0227 Revisi 1 (owner opsi 1): the bounce fix + the L1 fee preview ----

describe('background.bundle.js — g2 constructive + L1 fee preview (prompt 0227 Revisi 1)', () => {
  const FIXTURE_DIR_R1 = path.join(__dirname, '..', '..', '..', 'prompt', 'evidence', '0225-evm-swap-spike-eth-base');
  const Q_BASE = JSON.parse(readFileSync(path.join(FIXTURE_DIR_R1, 'kyber-quote-base-native2usdc.json'), 'utf8'));
  const B_BASE = JSON.parse(readFileSync(path.join(FIXTURE_DIR_R1, 'kyber-build-base-native2usdc.json'), 'utf8'));
  const Q_ETH = JSON.parse(readFileSync(path.join(FIXTURE_DIR_R1, 'kyber-quote-eth-native2usdc.json'), 'utf8'));
  const USDC_BASE_R1 = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const USDC_ETH_R1 = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const L1_FEE = 11195561607n; // the REAL fase 1 oracle answer
  const L1_SELECTOR = '0x49948e0e';

  /** Same compact signed-tx reader as the 0227 describe above (scoped there). */
  function readTx(rawHex, upTo = 7) {
    const bytes = Buffer.from(rawHex.replace(/^0x/, ''), 'hex');
    expect(bytes[0]).toBe(0x02);
    let i = 1;
    const listPrefix = bytes[i++];
    if (listPrefix >= 0xf8) i += listPrefix - 0xf7;
    const items = [];
    while (items.length < upTo && i < bytes.length) {
      const b = bytes[i];
      if (b < 0x80) {
        items.push(BigInt(b));
        i += 1;
      } else if (b < 0xb8) {
        const len = b - 0x80;
        let v = 0n;
        for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(bytes[i + 1 + k]);
        items.push(v);
        i += 1 + len;
      } else if (b < 0xc0) {
        const lenOfLen = b - 0xb7;
        let len = 0;
        for (let k = 0; k < lenOfLen; k++) len = len * 256 + bytes[i + 1 + k];
        let v = 0n;
        for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(bytes[i + 1 + lenOfLen + k]);
        items.push(v);
        i += 1 + lenOfLen + len;
      } else break;
    }
    return items;
  }

  /** Mock with a BASE FEE QUEUE (per eth_getBlockByNumber call) + the L1 oracle. */
  function installR1Mock({ slug, quoteJson, buildJson, baseFeeHexes, tipHex = '0xf4240', estimateGasHex = '0x41a1f' }) {
    const capture = { kyberBuilds: 0, sendRawParams: [], blockCalls: 0, l1Calls: 0, callDatas: [] };
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.startsWith(`https://aggregator-api.kyberswap.com/${slug}/api/v1/routes`)) {
        return { ok: true, status: 200, json: async () => quoteJson };
      }
      if (u.startsWith(`https://aggregator-api.kyberswap.com/${slug}/api/v1/route/build`)) {
        capture.kyberBuilds++;
        return { ok: true, status: 200, json: async () => buildJson };
      }
      const { method, params } = JSON.parse(options.body);
      const rpc = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
      if (method === 'eth_getBlockByNumber') {
        const idx = Math.min(capture.blockCalls++, baseFeeHexes.length - 1);
        return rpc({ baseFeePerGas: baseFeeHexes[idx] });
      }
      if (method === 'eth_maxPriorityFeePerGas') return rpc(tipHex);
      if (method === 'eth_call') {
        const data = String(params[0]?.data || '');
        capture.callDatas.push(data);
        if (data.startsWith(L1_SELECTOR)) {
          capture.l1Calls++;
          return rpc('0x' + L1_FEE.toString(16));
        }
        throw new Error(`Unexpected eth_call selector in R1 test: ${data.slice(0, 10)}`);
      }
      if (method === 'eth_getBalance') return rpc('0x2386f26fc10000');
      if (method === 'eth_getTransactionCount') return rpc('0x1');
      if (method === 'eth_estimateGas') return rpc(estimateGasHex);
      if (method === 'eth_sendRawTransaction') {
        capture.sendRawParams.push(params[0]);
        return rpc('0x' + 'aa'.repeat(32));
      }
      if (method === 'eth_getTransactionReceipt') return rpc(null);
      throw new Error(`Unexpected RPC in R1 test: ${method}`);
    };
    return capture;
  }

  it('the REAL bounce, fixed constructively: PREVIEW at baseFee 5e6 then EXECUTE at 6e6 SIGNS at exactly floor(ceiling / gasLimit) = 11.000.000 wei instead of bouncing — proven from the signed bytes (chainId 8453, value 1e15)', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    // Block reads: #1 PREVIEW (5e6), later reads EXECUTE (6e6 — a +20%
    // baseFee move, bigger than the owner's real 18% wobble).
    const capture = installR1Mock({ slug: 'base', quoteJson: Q_BASE, buildJson: B_BASE, baseFeeHexes: ['0x4c4b40', '0x5b8d80'] });
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', {
      networkKey: 'base', inputMint: 'native', outputMint: USDC_BASE_R1, amount: '0.001',
      inputDecimals: 18, outputDecimals: 6, slippageBps: 50, inputSymbol: 'ETH', outputSymbol: 'USDC'
    });
    expect(quote.error).toBeUndefined();
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.response.quoteId });
    expect(preview.error).toBeUndefined();
    // Gas ceiling 396.597 x 11e6 = 4.362.567.000.000; the DISPLAYED total
    // additionally carries the L1 estimate (K2) — but the ENFORCED gas
    // ceiling stays gas only, which the signed fee below proves.
    expect(preview.response.l1FeeWei).toBe(L1_FEE.toString());
    expect(BigInt(preview.response.maxFeeWei)).toBe(4362567000000n + L1_FEE);
    expect(capture.l1Calls).toBe(1);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    expect(result.response.quoteChanged).toBeUndefined(); // TIDAK bounce lagi
    expect(result.response.signature).toBe('0x' + 'aa'.repeat(32));
    expect(capture.sendRawParams.length).toBe(1);
    const [chainId, , tip, maxFee, gasLimit, , value] = readTx(capture.sendRawParams[0]);
    expect(chainId).toBe(8453n);
    expect(value).toBe(1000000000000000n);
    expect(gasLimit).toBe(396597n); // estimate 268.831 < build gas 330.498 -> x1,2 of the build gas
    expect(maxFee).toBe(11000000n); // floor(4.362.567.000.000 / 396.597) — the CUT fee, exactly the ceiling rate
    expect(tip <= maxFee).toBe(true);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('gas that TRULY rose still refuses: a ceiling rate below the fresh inclusion floor returns EVM_SWAP_FEE_ABOVE_DISPLAYED with a new live id, nothing signed', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    // PREVIEW at baseFee 5e6 (ceiling rate 11e6), EXECUTE at baseFee 3e7:
    // inclusion floor 3e7 + 1e6 = 3,1e7 > 11e6 -> refuse, nothing signed.
    const capture = installR1Mock({ slug: 'base', quoteJson: Q_BASE, buildJson: B_BASE, baseFeeHexes: ['0x4c4b40', '0x1c9c380'] });
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', {
      networkKey: 'base', inputMint: 'native', outputMint: USDC_BASE_R1, amount: '0.001',
      inputDecimals: 18, outputDecimals: 6, slippageBps: 50, inputSymbol: 'ETH', outputSymbol: 'USDC'
    });
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.response.quoteId });
    expect(preview.error).toBeUndefined();
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    expect(result.response.quoteChanged).toBe(true);
    expect(result.response.code).toBe('EVM_SWAP_FEE_ABOVE_DISPLAYED');
    expect(capture.sendRawParams.length).toBe(0);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('the L1 oracle is NEVER called for ethereum (detection by constant): PREVIEW answers gas only, zero oracle eth_call, zero Kyber build', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installR1Mock({ slug: 'ethereum', quoteJson: Q_ETH, buildJson: null, baseFeeHexes: ['0x8a0e9d0'] }); // baseFee 144,8 juta (fase 1)
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', {
      networkKey: 'ethereum', inputMint: 'native', outputMint: USDC_ETH_R1, amount: '0.002',
      inputDecimals: 18, outputDecimals: 6, slippageBps: 50, inputSymbol: 'ETH', outputSymbol: 'USDC'
    });
    expect(quote.error).toBeUndefined();
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.response.quoteId });
    expect(preview.error).toBeUndefined();
    expect(preview.response.l1FeeWei).toBe('0');
    expect(capture.l1Calls).toBe(0);
    expect(capture.kyberBuilds).toBe(0);
    expect(capture.callDatas.length).toBe(0); // no eth_call at all on this path
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('tip floor (0231): the endpoint answering tip 0x0 on base gets the 1e6 floor INSIDE the PREVIEW ceiling, so the cutter never rejects its own transaction — signed tip read from the bytes', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    // Same stable baseFee both reads; the ONLY difference from the real
    // fixtures is the endpoint tip collapsing to 0x0 — the floor must
    // reproduce the exact numbers every real Base tx signed (tip 1e6,
    // maxFee 11e6) and PREVIEW and EXECUTE must agree without a bounce.
    const capture = installR1Mock({ slug: 'base', quoteJson: Q_BASE, buildJson: B_BASE, baseFeeHexes: ['0x4c4b40'], tipHex: '0x0' });
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', {
      networkKey: 'base', inputMint: 'native', outputMint: USDC_BASE_R1, amount: '0.001',
      inputDecimals: 18, outputDecimals: 6, slippageBps: 50, inputSymbol: 'ETH', outputSymbol: 'USDC'
    });
    expect(quote.error).toBeUndefined();
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.response.quoteId });
    expect(preview.error).toBeUndefined();
    expect(BigInt(preview.response.maxFeeWei)).toBe(4362567000000n + L1_FEE); // identical to the real tip 1e6 fixture
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    expect(result.response.quoteChanged).toBeUndefined();
    expect(capture.sendRawParams.length).toBe(1);
    const [chainId, , tip, maxFee] = readTx(capture.sendRawParams[0]);
    expect(chainId).toBe(8453n);
    expect(tip).toBe(1000000n); // the FLOOR, not the endpoint 0
    expect(maxFee).toBe(11000000n);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);

  it('tip floor (0231): the downstream cap still wins — a Base baseFee spike makes baseFee x2 + floor exceed the 0.5 gwei cap and EXECUTE refuses with EVM_SWAP_GAS_PRICE_ABOVE_CAP, nothing signed', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installR1Mock({ slug: 'base', quoteJson: Q_BASE, buildJson: B_BASE, baseFeeHexes: ['0x11e1a300'], tipHex: '0x0' }); // 3e8 x2 + 1e6 = 601e6 > 5e8
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', {
      networkKey: 'base', inputMint: 'native', outputMint: USDC_BASE_R1, amount: '0.001',
      inputDecimals: 18, outputDecimals: 6, slippageBps: 50, inputSymbol: 'ETH', outputSymbol: 'USDC'
    });
    expect(quote.error).toBeUndefined();
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId: quote.response.quoteId, networkKey: 'base' });
    expect(String(result.error)).toContain('EVM_SWAP_GAS_PRICE_ABOVE_CAP');
    expect(capture.sendRawParams.length).toBe(0); // nothing broadcast
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, E2E_TIMEOUT_MS);
});


// ---- 0228 Revisi 1 (owner approved): spurious revert right after the
// approve + the haltDetail forensic trace — reproduced from the REAL Base
// incident responses (20 Oktober: estimateGas reverted on a stale replica
// while the approve receipt 0x1 was already in hand; the clean replay
// measured 293.067 gas with the live allowance).

describe('background.bundle.js — post-approve stale-state revert + haltDetail (prompt 0228 Revisi 1)', () => {
  const R1_TIMEOUT_MS = 60000; // kasus (a) menunggu satu interval resend 15s — di atas pola 0194
  const FIXTURE_DIR_0228 = path.join(__dirname, '..', '..', '..', 'prompt', 'evidence', '0225-evm-swap-spike-eth-base');
  const Q_BASE_TOKENIN_R1 = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0228, 'kyber-quote-base-usdc2native.json'), 'utf8'));
  const B_BASE_TOKENIN_R1 = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0228, 'kyber-build-base-usdc2native.json'), 'utf8'));
  const USDC_BASE_R1 = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const REAL_ESTIMATE_HEX = '0x478cb'; // 293.067 — angka replay nyata 0228

  /**
   * Mock dengan ANTREAN per kategori (persis insiden): allowance per
   * eth_call dd62ed3e, estimateGas SWAP per panggilan (error revert atau
   * gas), receipts boleh FUNGSI (pola 0223 — kasus (c) memundurkan
   * startedAt lewat sessionStore sebelum receipt 0x1 dijawab).
   */
  function installStaleStateMock({ allowanceHexes, swapEstimates, receipts, sessionStore, baseFeeHexes = null }) {
    const capture = { sendRawParams: [], allowanceCalls: 0, swapEstimateCalls: 0, receiptCalls: 0, nonceCalls: 0, blockCalls: 0 };
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.startsWith('https://aggregator-api.kyberswap.com/base/api/v1/routes')) {
        return { ok: true, status: 200, json: async () => Q_BASE_TOKENIN_R1 };
      }
      if (u.startsWith('https://aggregator-api.kyberswap.com/base/api/v1/route/build')) {
        return { ok: true, status: 200, json: async () => B_BASE_TOKENIN_R1 };
      }
      const { method, params } = JSON.parse(options.body);
      const rpc = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
      const rpcError = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: 3, message } }) });
      if (method === 'eth_getBlockByNumber') {
        // 0231 Revisi 1: antrean baseFee per panggilan (entri terakhir
        // berulang) supaya fee bisa NAIK antara PREVIEW dan continuation —
        // mekanisme insiden plafon nyata hari itu.
        const bf = baseFeeHexes ? baseFeeHexes[Math.min(capture.blockCalls++, baseFeeHexes.length - 1)] : '0x4c4b40';
        return rpc({ baseFeePerGas: bf }); // default 5e6 — kondisi nyata Base
      }
      if (method === 'eth_maxPriorityFeePerGas') return rpc('0xf4240'); // 1e6
      if (method === 'eth_call') {
        const data = String(params[0]?.data || '');
        if (data.startsWith('0xdd62ed3e')) {
          const idx = Math.min(capture.allowanceCalls++, allowanceHexes.length - 1);
          return rpc('0x' + BigInt(allowanceHexes[idx]).toString(16).padStart(64, '0'));
        }
        if (data.startsWith('0x70a08231')) return rpc('0x' + (10n ** 6n).toString(16).padStart(64, '0')); // 1 USDC dipegang
        if (data.startsWith('0x49948e0e')) return rpc('0x' + (8624798885n).toString(16)); // l1Fee nyata fase 1
        throw new Error(`Unexpected eth_call selector: ${data.slice(0, 10)}`);
      }
      if (method === 'eth_getBalance') return rpc('0x523c4cd415a4d'); // 1.447.170.078.712.077 wei — saldo nyata
      if (method === 'eth_getTransactionCount') {
        capture.nonceCalls++;
        return rpc('0x2'); // nonce nyata saat insiden
      }
      if (method === 'eth_estimateGas') {
        const isApprove = String(params[0]?.data || '').startsWith('0x095ea7b3');
        if (isApprove) return rpc('0xdbb0'); // 56.240 — estimasi approve nyata fase 1
        const idx = Math.min(capture.swapEstimateCalls++, swapEstimates.length - 1);
        const e = swapEstimates[idx];
        return e.error ? rpcError(e.error) : rpc(e.gas);
      }
      if (method === 'eth_sendRawTransaction') {
        capture.sendRawParams.push(params[0]);
        return rpc('0x' + (capture.sendRawParams.length === 1 ? 'aa' : 'bb').repeat(32));
      }
      if (method === 'eth_getTransactionReceipt') {
        const idx = Math.min(capture.receiptCalls++, receipts.length - 1);
        const r = receipts[idx];
        const value = typeof r === 'function' ? await r() : r;
        return rpc(value);
      }
      throw new Error(`Unexpected RPC in 0228 test: ${method}`);
    };
    return capture;
  }

  async function quoteBaseTokenIn(listeners) {
    const quote = await send(listeners, 'FLUXIO_INTERNAL_GET_SWAP_QUOTE', {
      networkKey: 'base', inputMint: USDC_BASE_R1, outputMint: 'native', amount: '0.5',
      inputDecimals: 6, outputDecimals: 18, slippageBps: 50, inputSymbol: 'USDC', outputSymbol: 'ETH'
    });
    expect(quote.error).toBeUndefined();
    return quote.response.quoteId;
  }

  it('(a) the REAL incident, fixed: estimateGas reverts while the fresh allowance still reads 0 (stale replica) -> RETRY, the next tick estimates 293.067 clean and the swap SIGNS at the local nonce approve + 1', async () => {
    const { listeners, sessionStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const infoSpy = vi.spyOn(console, 'info'); // 0231 (catatan 20): jejak sukses
    const capture = installStaleStateMock({
      // (1) EXECUTE: allowance 0 -> kaki approve; (2) pasca-revert: MASIH 0
      // (belum terpropagasi) -> retry, BUKAN halt; (3) tak terpakai.
      allowanceHexes: ['0x0', '0x0', '0x0', '0xf4240'], // +1 di depan: PREVIEW membaca allowance sekali
      // DUA revert = KEDUA endpoint Base (fetchRpcWithFallback mencoba
      // fallback pada error JSON-RPC — insiden nyata berarti kedua replika
      // sama-sama basi), lalu estimasi bersih di tick berikutnya.
      swapEstimates: [{ error: 'execution reverted' }, { error: 'execution reverted' }, { gas: REAL_ESTIMATE_HEX }],
      receipts: [{ status: '0x1' }],
      sessionStore
    });
    const quoteId = await quoteBaseTokenIn(listeners);
    await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId }); // 0231 R2: popup selalu preview; fail closed menuntut plafon ada
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBe('approve');
    // Tick 1: revert + allowance basi -> false (retry); tick 2 (15s
    // kemudian): estimasi bersih -> swap tersign. Receipt mock 0x1 juga
    // menuntaskan verdict kaki swap, jadi state bisa langsung BERSIH —
    // yang ditunggu adalah tanda tangan kedua, bukan stage.
    await vi.waitFor(() => {
      expect([...new Set(capture.sendRawParams)].length).toBe(2);
    }, { timeout: 40000, interval: 1000 });
    expect(capture.swapEstimateCalls).toBeGreaterThanOrEqual(3); // 2 revert (dua endpoint, tick 1) + 1 bersih (tick 2)
    // Allowance dibaca ulang saat revert (panggilan ke-2) — bukti K1.
    expect(capture.allowanceCalls).toBeGreaterThanOrEqual(2);
    const unique = [...new Set(capture.sendRawParams)];
    expect(unique.length).toBe(2); // approve + swap, masing-masing sekali ditandatangani
    const legs = unique.map((raw) => {
      const bytes = Buffer.from(raw.slice(2), 'hex');
      expect(bytes[0]).toBe(0x02);
      let i = 1;
      const lp = bytes[i++];
      if (lp >= 0xf8) i += lp - 0xf7;
      const items = [];
      while (items.length < 2 && i < bytes.length) {
        const b = bytes[i];
        if (b < 0x80) { items.push(BigInt(b)); i += 1; }
        else { const len = b - 0x80; let v = 0n; for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(bytes[i + 1 + k]); items.push(v); i += 1 + len; }
      }
      return items; // [chainId, nonce]
    });
    expect(legs.map((l) => l[1])).toEqual([2n, 3n]); // nonce approve 2, swap 3 = +1 LOKAL
    // 0231 (catatan 20): TEPAT SATU baris sukses dengan N = 1 (satu reread
    // stale sebelum tick bersih), tanpa data sensitif.
    const infoLines = infoSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('continuation succeeded after'));
    expect(infoLines).toEqual(['[fluxio swap] continuation succeeded after 1 allowance rereads']);
    infoSpy.mockRestore();
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, R1_TIMEOUT_MS);

  it('(b) control: the allowance ALREADY reads amountIn (state arrived) and the revert persists -> a REAL revert halts SWAP_NOT_SENT with haltDetail.step estimateGas', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const infoSpy = vi.spyOn(console, 'info'); // 0231: jalur TANPA reread tidak boleh meninggalkan baris sukses
    const capture = installStaleStateMock({
      allowanceHexes: ['0x0', '0x0', '0xf4240'], // PREVIEW 0; EXECUTE 0 -> approve; pasca-revert 1e6 >= 5e5
      swapEstimates: [{ error: 'execution reverted' }],
      receipts: [{ status: '0x1' }]
    });
    const quoteId = await quoteBaseTokenIn(listeners);
    await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId }); // 0231 R2: popup selalu preview; fail closed menuntut plafon ada

    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.response.stage).toBe('approve');
    await vi.waitFor(async () => {
      const active = await send(listeners, 'FLUXIO_INTERNAL_GET_ACTIVE_SWAP');
      expect(active.response.stage).toBe('halted');
      expect(active.response.haltReason).toBe('SWAP_NOT_SENT');
      expect(active.response.haltDetail?.step).toBe('estimateGas');
      expect(active.response.haltDetail?.detail).toContain('revert');
      // 0231 (catatan 20): nol reread di jalur ini — counter tidak pernah
      // ikut haltDetail, dan tidak ada baris info sukses.
      expect(active.response.haltDetail?.staleAllowanceRetries).toBeUndefined();
    }, { timeout: 15000, interval: 500 });
    expect(infoSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('continuation succeeded after'))).toEqual([]);
    infoSpy.mockRestore();
    expect(capture.sendRawParams.length).toBe(1); // hanya approve — swap tidak pernah tersign
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, R1_TIMEOUT_MS);

  it('(c) the window closes while the allowance never propagates: halt SWAP_NOT_SENT with haltDetail.step window', async () => {
    const { listeners, sessionStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installStaleStateMock({
      allowanceHexes: ['0x0'], // selalu 0 (tak pernah terpropagasi)
      swapEstimates: [{ error: 'execution reverted' }],
      receipts: [
        () => {
          // Memundurkan startedAt lewat store sesi SEBELUM receipt 0x1
          // dijawab — tick pertama lanjutan langsung menemui jendela
          // tertutup (pola receipt-fungsi 0223).
          const state = sessionStore.get('fluxio_active_swap');
          if (state) sessionStore.set('fluxio_active_swap', { ...state, startedAt: Date.now() - 601000 });
          return { status: '0x1' };
        }
      ]
    });
    const quoteId = await quoteBaseTokenIn(listeners);
    await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId }); // 0231 R2: popup selalu preview; fail closed menuntut plafon ada
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.response.stage).toBe('approve');
    await vi.waitFor(async () => {
      const active = await send(listeners, 'FLUXIO_INTERNAL_GET_ACTIVE_SWAP');
      expect(active.response.stage).toBe('halted');
      expect(active.response.haltReason).toBe('SWAP_NOT_SENT');
      expect(active.response.haltDetail?.step).toBe('window');
    }, { timeout: 40000, interval: 1000 }); // mutasi startedAt baru terbaca di iterasi loop berikutnya (jeda resend 15s)
    expect(capture.sendRawParams.length).toBe(1);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, R1_TIMEOUT_MS);

  it('(f, 0231) a halt AFTER a stale reread carries staleAllowanceRetries in haltDetail — and the counter survives the startedAt mutation (merge write, not clobber)', async () => {
    const { listeners, sessionStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installStaleStateMock({
      allowanceHexes: ['0x0'], // tak pernah terpropagasi -> setiap tick reread menghitung
      swapEstimates: [{ error: 'execution reverted' }],
      receipts: [
        () => {
          // Backdate DI TICK PERTAMA: tick 1 masih menjalani revert +
          // reread (counter 1, merge write mempertahankan startedAt yang
          // dimundurkan), tick 2 membaca jendela tertutup dan halt.
          const state = sessionStore.get('fluxio_active_swap');
          if (state) sessionStore.set('fluxio_active_swap', { ...state, startedAt: Date.now() - 601000 });
          return { status: '0x1' };
        }
      ]
    });
    const quoteId = await quoteBaseTokenIn(listeners);
    await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId }); // 0231 R2: popup selalu preview; fail closed menuntut plafon ada
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.response.stage).toBe('approve');
    await vi.waitFor(async () => {
      const active = await send(listeners, 'FLUXIO_INTERNAL_GET_ACTIVE_SWAP');
      expect(active.response.stage).toBe('halted');
      expect(active.response.haltReason).toBe('SWAP_NOT_SENT');
      expect(active.response.haltDetail?.step).toBe('window');
      expect(active.response.haltDetail?.staleAllowanceRetries).toBe(1);
    }, { timeout: 40000, interval: 1000 });
    expect(capture.sendRawParams.length).toBe(1);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, R1_TIMEOUT_MS);

  it('(g, 0231 Revisi 1 — REPRO pelanggaran plafon, BELUM diperbaiki) PREVIEW dipanggil lalu fee naik: biaya tersign kaki swap HARUS <= plafon tampil atau halt, kode sekarang MELANGGAR', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installStaleStateMock({
      allowanceHexes: ['0x0'], // PREVIEW dan EXECUTE sama sama membaca 0 -> kaki approve
      swapEstimates: [{ gas: REAL_ESTIMATE_HEX }],
      receipts: [{ status: '0x1' }],
      // Blok #1 = PREVIEW (fee rendah, plafon tampil kecil); #2 = kaki
      // approve (masih rendah, lolos); #3+ = continuation (baseFee
      // melonjak 10x, tetap di bawah cap jaringan — mekanisme insiden
      baseFeeHexes: ['0x4c4b40', '0x4c4b40', '0x2faf080']
    });
    const quoteId = await quoteBaseTokenIn(listeners);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId });
    expect(preview.error).toBeUndefined();
    const displayedTotalWei = BigInt(preview.response.maxFeeWei);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    // Tunggu lanjutan: entah swap tersign (broadcast kedua) atau halt.
    let active;
    await vi.waitFor(async () => {
      active = await send(listeners, 'FLUXIO_INTERNAL_GET_ACTIVE_SWAP');
      const done = active.response?.stage === 'halted' || capture.sendRawParams.length >= 2 || active.response?.stage === 'swap' || active.response == null;
      expect(done).toBe(true);
    }, { timeout: 40000, interval: 1000 });
    if (capture.sendRawParams.length >= 2) {
      // Swap TERSIGN — janji plafon (pelajaran swap 10): biaya tersign
      // kaki swap tidak boleh melampaui TOTAL yang dilihat pengguna.
      const bytes = Buffer.from(capture.sendRawParams[1].slice(2), 'hex');
      expect(bytes[0]).toBe(0x02);
      let i = 1;
      const lp = bytes[i++];
      if (lp >= 0xf8) i += lp - 0xf7;
      const items = [];
      while (items.length < 5 && i < bytes.length) {
        const b = bytes[i];
        if (b < 0x80) { items.push(BigInt(b)); i += 1; }
        else { const len = b - 0x80; let v = 0n; for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(bytes[i + 1 + k]); items.push(v); i += 1 + len; }
      }
      const maxFee = items[3];
      const gasLimit = items[4];
      expect(gasLimit * maxFee <= displayedTotalWei).toBe(true);
    } else {
      expect(active.response.haltReason).toBe('EVM_SWAP_FEE_ABOVE_DISPLAYED');
    }
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, R1_TIMEOUT_MS);

  // 0231 Revisi 2 (owner P1): tes (h) Revisi 1 dulunya it.fails — bukti
  // akar bahwa state tanpa plafon menandatangani TANPA BATAS (insiden 22
  // Oktober: 5,64x angka yang dilihat pemilik). Kini FAIL CLOSED: tanpa
  // plafon tampil, TIDAK ADA yang ditandatangani sama sekali — EXECUTE
  // memantul ke Review (yang akan preview ulang) dengan kode fee.
  it('(h, 0231 Revisi 2) EXECUTE token masuk TANPA preview: tidak ada tanda tangan sama sekali — bounce EVM_SWAP_FEE_ABOVE_DISPLAYED, nol broadcast (dulu it.fails yang menandatangani 5,64x)', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installStaleStateMock({
      allowanceHexes: ['0x0'],
      swapEstimates: [{ gas: REAL_ESTIMATE_HEX }],
      receipts: [{ status: '0x1' }],
      baseFeeHexes: ['0x4c4b40', '0x2faf080']
    });
    const quoteId = await quoteBaseTokenIn(listeners);
    // SENGAJA tanpa PREVIEW — kondisi insiden (plafon tidak pernah ada).
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    expect(result.response.quoteChanged).toBe(true);
    expect(result.response.code).toBe('EVM_SWAP_FEE_ABOVE_DISPLAYED');
    expect(result.response.quote?.quoteId).toBeTruthy(); // quote baru hidup untuk Review
    expect(capture.sendRawParams.length).toBe(0); // NOL broadcast — tidak ada approve pun
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, R1_TIMEOUT_MS);

  it('(i, 0231 Revisi 2 — bukti INVESTIGASI 1) PREVIEW token masuk lalu EXECUTE id yang sama: state.displayedSwapMaxFeeWei HARUS = plafon kaki swap yang dikirim ke popup', async () => {
    const { listeners, sessionStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installStaleStateMock({
      allowanceHexes: ['0x0'],
      swapEstimates: [{ gas: REAL_ESTIMATE_HEX }],
      receipts: [{ status: '0x1' }]
    });
    const quoteId = await quoteBaseTokenIn(listeners);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId });
    expect(preview.error).toBeUndefined();
    expect(preview.response.tokenIn).toBe(true);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    expect(result.response.stage).toBe('approve');
    const state = sessionStore.get('fluxio_active_swap');
    expect(state.displayedSwapMaxFeeWei).toBe(preview.response.swapMaxFeeWei);
    expect(state.displayedApproveMaxFeeWei).toBe(preview.response.approveMaxFeeWei);
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, R1_TIMEOUT_MS);

  it('(j, 0231 R2) plafon HILANG di tengah jalan (state korup): continuation TIDAK menandatangani — halt EVM_SWAP_FEE_ABOVE_DISPLAYED step ceiling, hanya approve yang pernah broadcast', async () => {
    const { listeners, sessionStore } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installStaleStateMock({
      // Tick 1 tertahan (revert + allowance basi -> retry) supaya mutasi
      // state dari receipt fn terbaca di tick 2 — pola tes (c).
      allowanceHexes: ['0x0'],
      swapEstimates: [{ error: 'execution reverted' }, { error: 'execution reverted' }, { gas: REAL_ESTIMATE_HEX }],
      receipts: [
        () => {
          const state = sessionStore.get('fluxio_active_swap');
          if (state) sessionStore.set('fluxio_active_swap', { ...state, displayedSwapMaxFeeWei: null });
          return { status: '0x1' };
        }
      ]
    });
    const quoteId = await quoteBaseTokenIn(listeners);
    await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId });
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.response.stage).toBe('approve');
    await vi.waitFor(async () => {
      const active = await send(listeners, 'FLUXIO_INTERNAL_GET_ACTIVE_SWAP');
      expect(active.response.stage).toBe('halted');
      expect(active.response.haltReason).toBe('EVM_SWAP_FEE_ABOVE_DISPLAYED');
      expect(active.response.haltDetail?.step).toBe('ceiling');
      expect(active.response.haltDetail?.detail).toBe('ceiling missing');
      expect(active.response.haltDetail?.preview?.previewedAt).toBeTruthy(); // forensik K3 ikut halt
    }, { timeout: 40000, interval: 1000 });
    expect(capture.sendRawParams.length).toBe(1); // hanya approve
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, R1_TIMEOUT_MS);

  it('(k, 0231 R2) fee naik di atas plafon tapi potongan masih bisa masuk blok: CUTTER memotong — tersign = floor(plafon kaki swap / gasLimit), dibaca dari byte', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installStaleStateMock({
      allowanceHexes: ['0x0'],
      swapEstimates: [{ gas: REAL_ESTIMATE_HEX }],
      receipts: [{ status: '0x1' }],
      // PREVIEW + approve pada baseFee 5e6; continuation 9e6 (fresh 19e6).
      baseFeeHexes: ['0x4c4b40', '0x4c4b40', '0x895440']
    });
    const quoteId = await quoteBaseTokenIn(listeners);
    const preview = await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId });
    const swapCeil = BigInt(preview.response.swapMaxFeeWei);
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    await vi.waitFor(() => {
      expect([...new Set(capture.sendRawParams)].length).toBe(2);
    }, { timeout: 40000, interval: 1000 });
    const bytes = Buffer.from(capture.sendRawParams[1].slice(2), 'hex');
    let i = 1;
    const lp = bytes[i++];
    if (lp >= 0xf8) i += lp - 0xf7;
    const items = [];
    while (items.length < 5 && i < bytes.length) {
      const b = bytes[i];
      if (b < 0x80) { items.push(BigInt(b)); i += 1; }
      else { const len = b - 0x80; let v = 0n; for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(bytes[i + 1 + k]); items.push(v); i += 1 + len; }
    }
    const gasLimit = items[4];
    const maxFee = items[3];
    expect(maxFee).toBe(swapCeil / gasLimit); // POTONGAN persis ke plafon tampil
    expect(maxFee < 19000000n).toBe(true); // di bawah fee segar
    expect(maxFee >= 10000000n).toBe(true); // masih >= baseFee 9e6 + tip 1e6
    expect(gasLimit * maxFee <= swapCeil).toBe(true); // janji pelajaran 10
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, R1_TIMEOUT_MS);

  it('(l, 0231 R2 — ANGKA INSIDEN 22 Oktober) baseFee lanjutan 167.045.242 + gasLimit 757.010: potongan jatuh di bawah lantai inklusi — halt dengan alasan fee, TIDAK menandatangani 5,64x seperti insiden', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installStaleStateMock({
      allowanceHexes: ['0x0'],
      // 630.842 x 1,2 = 757.010 — gasLimit tersign insiden, persis.
      swapEstimates: [{ gas: '0x9a03a' }],
      receipts: [{ status: '0x1' }],
      // PREVIEW + approve murah; continuation pada baseFee blok inklusi
      // insiden (167.045.242 — blok 26247713).
      baseFeeHexes: ['0x4c4b40', '0x4c4b40', '0x9f4e87a']
    });
    const quoteId = await quoteBaseTokenIn(listeners);
    await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId });
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.response.stage).toBe('approve');
    await vi.waitFor(async () => {
      const active = await send(listeners, 'FLUXIO_INTERNAL_GET_ACTIVE_SWAP');
      expect(active.response.stage).toBe('halted');
      expect(active.response.haltReason).toBe('EVM_SWAP_FEE_ABOVE_DISPLAYED');
      expect(active.response.haltDetail?.step).toBe('ceiling');
      expect(active.response.haltDetail?.detail).toContain('inclusion floor');
    }, { timeout: 40000, interval: 1000 });
    expect(capture.sendRawParams.length).toBe(1); // approve saja — kaki 5,64x TIDAK pernah tersign lagi
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, R1_TIMEOUT_MS);

  it('(m, 0231 R3) baris jejak EXECUTE muncul TEPAT SEKALI per EXECUTE dan tidak memuat alamat', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const infoSpy = vi.spyOn(console, 'info');
    const capture = installStaleStateMock({
      allowanceHexes: ['0x0'],
      swapEstimates: [{ gas: REAL_ESTIMATE_HEX }],
      receipts: [{ status: '0x1' }]
    });
    const quoteId = await quoteBaseTokenIn(listeners);
    await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId });
    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    expect(result.error).toBeUndefined();
    const execLines = infoSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[fluxio swap] execute'));
    expect(execLines.length).toBe(1); // tepat satu per EXECUTE
    expect(execLines[0]).toContain('execute base quote ' + quoteId);
    expect(execLines[0]).toContain('ceilings reset/approve/swap');
    expect(/0x[0-9a-fA-F]{40}/.test(execLines[0])).toBe(false); // tidak pernah alamat
    expect(capture.sendRawParams.length).toBeGreaterThanOrEqual(1);
    infoSpy.mockRestore();
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, R1_TIMEOUT_MS);

  it('(d) + (e): haltDetail never carries rawSignedTx or calldata, and SWAP_STATUS forwards it', async () => {
    const { listeners } = installFakeChromeForBackground();
    await importFreshBundle();
    await importWallet(listeners);
    const capture = installStaleStateMock({
      allowanceHexes: ['0x0', '0x0', '0xf4240'], // +1 di depan untuk PREVIEW
      swapEstimates: [{ error: 'execution reverted: ' + '0xab'.padEnd(80, 'cd') }], // pesan node membawa blob hex panjang
      receipts: [{ status: '0x1' }]
    });
    const quoteId = await quoteBaseTokenIn(listeners);
    await send(listeners, 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId }); // 0231 R2: popup selalu preview; fail closed menuntut plafon ada

    const result = await send(listeners, 'FLUXIO_INTERNAL_EXECUTE_SWAP', { quoteId, networkKey: 'base' });
    const approveHash = result.response.approveHash;
    let detail;
    await vi.waitFor(async () => {
      const active = await send(listeners, 'FLUXIO_INTERNAL_GET_ACTIVE_SWAP');
      expect(active.response.stage).toBe('halted');
      detail = active.response.haltDetail;
      expect(detail?.step).toBe('estimateGas');
    }, { timeout: 15000, interval: 500 });
    const asText = JSON.stringify(detail);
    // 0231 R2: haltDetail kini juga membawa forensik preview (K3) — batas
    // longgar tapi tetap terikat, dan field preview harus ada.
    expect(asText.length).toBeLessThanOrEqual(700);
    expect(detail?.preview?.previewedAt).toBeTruthy();
    expect(asText.includes(capture.sendRawParams[0])).toBe(false); // tidak pernah rawSignedTx
    expect(asText.includes(B_BASE_TOKENIN_R1.data.data.slice(0, 40))).toBe(false); // tidak pernah calldata
    // (e) SWAP_STATUS meneruskan haltDetail (dipoll dengan hash approve).
    const status = await send(listeners, 'FLUXIO_INTERNAL_SWAP_STATUS', { signature: approveHash, networkKey: 'base' });
    expect(status.error).toBeUndefined();
    expect(status.response.haltDetail?.step).toBe('estimateGas');
    delete globalThis.fetch;
    delete globalThis.chrome;
  }, R1_TIMEOUT_MS);
});
