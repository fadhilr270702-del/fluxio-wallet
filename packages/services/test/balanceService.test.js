import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getNativeBalance } from '../balanceService.js';
import { NETWORKS } from '@fluxio/constants';

const WALLET = {
  accounts: {
    solana: { address: 'SoLTestAddress1111111111111111111111111111' },
    evm: { address: '0x000000000000000000000000000000000000AA' }
  }
};

/** Installs a fetch mock keyed by exact endpoint URL. Each entry is either
 *  { body } (resolves with that JSON body) or { reject: 'message' } (the
 *  fetch call itself throws, simulating a network failure). */
function mockFetch(responsesByUrl) {
  globalThis.fetch = vi.fn(async (url) => {
    const entry = responsesByUrl[url];
    if (!entry) throw new Error(`Unexpected fetch to ${url}`);
    if (entry.reject) throw new Error(entry.reject);
    return { json: async () => entry.body };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('getNativeBalance — Solana', () => {
  it('converts lamports (a plain JSON number) to SOL correctly', async () => {
    mockFetch({
      [NETWORKS.solana.rpc.default]: { body: { jsonrpc: '2.0', id: 1, result: { value: 1234567890 } } }
    });

    const result = await getNativeBalance('solana', WALLET);
    expect(result.symbol).toBe('SOL');
    expect(result.formatted).toBe('1.234567890');
  });
});

describe('getNativeBalance — Solana Local', () => {
  it('resolves a balance against the local-validator RPC endpoint (same accountType as solana/solana-devnet)', async () => {
    mockFetch({
      [NETWORKS['solana-local'].rpc.default]: { body: { jsonrpc: '2.0', id: 1, result: { value: 2_000_000_000 } } }
    });

    const result = await getNativeBalance('solana-local', WALLET);
    expect(result.symbol).toBe('SOL');
    expect(result.formatted).toBe('2.000000000');
  });
});

describe('getNativeBalance — EVM', () => {
  it('converts exactly 1 ETH of wei (hex string) without precision loss', async () => {
    const oneEthWei = 10n ** 18n;
    mockFetch({
      [NETWORKS.ethereum.rpc.default]: { body: { jsonrpc: '2.0', id: 1, result: `0x${oneEthWei.toString(16)}` } }
    });

    const result = await getNativeBalance('ethereum', WALLET);
    expect(result.symbol).toBe('ETH');
    expect(result.formatted).toBe('1.000000000000000000');
  });

  it('handles a wei value beyond Number.MAX_SAFE_INTEGER exactly (the precision case that motivated BigInt)', async () => {
    // 123.456789012345678901 ETH in wei — deliberately not a round number,
    // and far beyond what a JS Number can represent exactly once expressed
    // in wei (Number.MAX_SAFE_INTEGER ~= 9.007e15; this raw value is
    // ~1.23e20). A Number(hex)/1e18-style conversion would silently
    // corrupt this; BigInt must not.
    const rawWei = 123456789012345678901n;
    expect(rawWei > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true); // sanity-check the test is actually exercising the risky range

    mockFetch({
      [NETWORKS.ethereum.rpc.default]: { body: { jsonrpc: '2.0', id: 1, result: `0x${rawWei.toString(16)}` } }
    });

    const result = await getNativeBalance('ethereum', WALLET);
    expect(result.formatted).toBe('123.456789012345678901');
  });

  it('falls back to the configured fallback endpoint when the default fails', async () => {
    const [defaultUrl, fallbackUrl] = [NETWORKS.ethereum.rpc.default, NETWORKS.ethereum.rpc.fallbacks[0]];
    expect(fallbackUrl).toBeTruthy(); // ethereum has a configured fallback per networks.js

    mockFetch({
      [defaultUrl]: { reject: 'simulated network failure' },
      [fallbackUrl]: { body: { jsonrpc: '2.0', id: 1, result: `0x${(10n ** 18n).toString(16)}` } }
    });

    const result = await getNativeBalance('ethereum', WALLET);
    expect(result.formatted).toBe('1.000000000000000000');
  });

  it('surfaces a JSON-RPC error object as a rejection, trying fallbacks first', async () => {
    mockFetch({
      [NETWORKS.ethereum.rpc.default]: { body: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'rate limited' } } },
      [NETWORKS.ethereum.rpc.fallbacks[0]]: { body: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'also rate limited' } } }
    });

    await expect(getNativeBalance('ethereum', WALLET)).rejects.toThrow(/Could not reach Ethereum/);
  });
});

describe('getNativeBalance — per-network isolation', () => {
  it('one failing network does not affect another succeeding one', async () => {
    mockFetch({
      [NETWORKS.solana.rpc.default]: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000000000 } } },
      [NETWORKS.ethereum.rpc.default]: { reject: 'down' },
      // ethereum has one fallback (also failing here) so it genuinely exhausts all endpoints
      [NETWORKS.ethereum.rpc.fallbacks[0]]: { reject: 'also down' }
    });

    const results = await Promise.allSettled([
      getNativeBalance('solana', WALLET),
      getNativeBalance('ethereum', WALLET)
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[0].value.formatted).toBe('5.000000000');
    expect(results[1].status).toBe('rejected');
  });
});

describe('getNativeBalance — validation', () => {
  it('rejects an unknown network key', async () => {
    await expect(getNativeBalance('dogecoin', WALLET)).rejects.toThrow(/Unknown network/);
  });
});
