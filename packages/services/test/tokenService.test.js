import { describe, it, expect, afterEach, vi } from 'vitest';
import { getTokenBalances, fetchErc20Metadata, fetchSolanaMintInfo } from '../tokenService.js';
import { NETWORKS, getTokensForNetwork } from '@fluxio/constants';
import { formatUnits } from '@fluxio/utils/formatUnits';
import { RpcUnreachableError } from '@fluxio/crypto/rpc';

// Real ABI-encoded fixtures, same provenance as packages/utils/test/abiDecode.test.js
// (generated via ethers' own AbiCoder — see that file's header comment).
const ABI_USDC = '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000045553444300000000000000000000000000000000000000000000000000000000';
const ABI_DECIMALS_6 = '0x0000000000000000000000000000000000000000000000000000000000000006';
const EMPTY = '0x';

const WALLET = {
  accounts: {
    solana: { address: 'SoLTestAddress1111111111111111111111111111' },
    evm: { address: '0x000000000000000000000000000000000000AA' }
  }
};

const DEVNET_USDC = getTokensForNetwork('solana-devnet')[0];
const SEPOLIA_USDC = getTokensForNetwork('ethereum-sepolia')[0];

/** Installs a fetch mock that inspects the JSON-RPC method (and, for
 *  eth_call, the target contract address) to decide a response — a plain
 *  URL-keyed mock (like balanceService.test.js's) can't distinguish
 *  between two different eth_call requests to the same endpoint, which
 *  the EVM tests below need. `handlers` maps a lookup key
 *  ('getTokenAccountsByOwner' for Solana, or an eth_call target address
 *  for EVM) to either { body } or { reject: 'message' }. */
function mockFetch(handlers) {
  globalThis.fetch = vi.fn(async (url, opts) => {
    const body = JSON.parse(opts.body);
    const key = body.method === 'eth_call' ? body.params[0].to.toLowerCase() : body.method;
    const entry = handlers[key];
    if (!entry) throw new Error(`Unexpected RPC call: ${key}`);
    if (entry.reject) throw new Error(entry.reject);
    return { json: async () => entry.body };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('getTokenBalances — Solana (SPL, auto-discovery)', () => {
  it('resolves a known mint against the registry, decimals from the RPC response (not the registry)', async () => {
    mockFetch({
      getTokenAccountsByOwner: {
        body: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            value: [
              {
                account: {
                  data: {
                    parsed: {
                      info: { mint: DEVNET_USDC.address, tokenAmount: { amount: '2500000', decimals: 6 } }
                    }
                  }
                }
              }
            ]
          }
        }
      }
    });

    const result = await getTokenBalances('solana-devnet', WALLET, {});
    expect(result).toEqual([
      {
        symbol: 'USDC',
        name: DEVNET_USDC.name,
        amountRaw: '2500000',
        decimals: 6,
        amountFormatted: '2.500000',
        address: DEVNET_USDC.address
      }
    ]);
  });

  it('shows an unrecognized mint as "Unknown" rather than dropping it', async () => {
    const unknownMint = 'UnknownMint1111111111111111111111111111111';
    mockFetch({
      getTokenAccountsByOwner: {
        body: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            value: [
              { account: { data: { parsed: { info: { mint: unknownMint, tokenAmount: { amount: '10', decimals: 0 } } } } } }
            ]
          }
        }
      }
    });

    const result = await getTokenBalances('solana-devnet', WALLET, {});
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('Unknown');
    expect(result[0].name).toBe('Unkn…1111'); // shortened-mint label, not the registry name
  });

  it('excludes a zero-balance token account', async () => {
    mockFetch({
      getTokenAccountsByOwner: {
        body: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            value: [
              { account: { data: { parsed: { info: { mint: DEVNET_USDC.address, tokenAmount: { amount: '0', decimals: 6 } } } } } }
            ]
          }
        }
      }
    });

    const result = await getTokenBalances('solana-devnet', WALLET, {});
    expect(result).toEqual([]);
  });

  it('propagates an RPC failure as a rejection (solana-devnet has no configured fallback)', async () => {
    mockFetch({ getTokenAccountsByOwner: { reject: 'simulated network failure' } });
    await expect(getTokenBalances('solana-devnet', WALLET, {})).rejects.toThrow(/Could not reach/);
  });

  it('a locally-registered custom token is preferred by mint address, overriding the registry entry', async () => {
    const customName = 'USDC (local override)';
    mockFetch({
      getTokenAccountsByOwner: {
        body: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            value: [
              { account: { data: { parsed: { info: { mint: DEVNET_USDC.address, tokenAmount: { amount: '1000000', decimals: 6 } } } } } }
            ]
          }
        }
      }
    });

    const result = await getTokenBalances('solana-devnet', WALLET, {
      customTokens: [{ symbol: 'USDC', name: customName, decimals: 6, address: DEVNET_USDC.address }]
    });
    expect(result[0].name).toBe(customName);
  });

  it('one malformed token account is skipped without taking the rest of the owner\'s held tokens down with it', async () => {
    mockFetch({
      getTokenAccountsByOwner: {
        body: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            value: [
              // Malformed: tokenAmount.amount isn't a valid BigInt input —
              // would throw and previously would have aborted the whole
              // loop, dropping every other held token in the same
              // response (the EVM sibling of this bug, confirmed live,
              // is what motivated checking the Solana side too).
              { account: { data: { parsed: { info: { mint: 'MalformedMint111111111111111111111111111', tokenAmount: { amount: 'not-a-number', decimals: 6 } } } } } },
              { account: { data: { parsed: { info: { mint: DEVNET_USDC.address, tokenAmount: { amount: '3000000', decimals: 6 } } } } } }
            ]
          }
        }
      }
    });

    const result = await getTokenBalances('solana-devnet', WALLET, {});
    expect(result).toEqual([
      {
        symbol: 'USDC',
        name: DEVNET_USDC.name,
        amountRaw: '3000000',
        decimals: 6,
        amountFormatted: '3.000000',
        address: DEVNET_USDC.address
      }
    ]);
  });
});

describe('getTokenBalances — EVM (registry loop, eth_call balanceOf)', () => {
  it('handles a raw token amount beyond Number.MAX_SAFE_INTEGER exactly (the precision case that motivated BigInt)', async () => {
    // 123456.789012 USDC (6 decimals) — deliberately far beyond what a JS
    // Number can hold exactly once expressed in the token's smallest unit.
    const rawAmount = 123456789012345678901n;
    expect(rawAmount > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true); // sanity-check the risky range is actually exercised

    mockFetch({
      [SEPOLIA_USDC.address.toLowerCase()]: {
        body: { jsonrpc: '2.0', id: 1, result: `0x${rawAmount.toString(16)}` }
      }
    });

    const result = await getTokenBalances('ethereum-sepolia', WALLET, {});
    expect(result).toHaveLength(1);
    expect(result[0].amountRaw).toBe(rawAmount.toString());
    expect(result[0].amountFormatted).toBe(formatUnits(rawAmount, SEPOLIA_USDC.decimals));
  });

  it('excludes a zero token balance', async () => {
    mockFetch({ [SEPOLIA_USDC.address.toLowerCase()]: { body: { jsonrpc: '2.0', id: 1, result: '0x0' } } });
    const result = await getTokenBalances('ethereum-sepolia', WALLET, {});
    expect(result).toEqual([]);
  });

  it('a network with no registry/custom tokens returns [] without making any RPC call', async () => {
    globalThis.fetch = vi.fn();
    const result = await getTokenBalances('ethereum-local', WALLET, {});
    expect(result).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('falls back to the configured fallback endpoint when the default eth_call fails', async () => {
    const [defaultUrl, fallbackUrl] = [NETWORKS['ethereum-sepolia'].rpc.default, NETWORKS['ethereum-sepolia'].rpc.fallbacks[0]];
    expect(fallbackUrl).toBeTruthy();

    let call = 0;
    globalThis.fetch = vi.fn(async (url) => {
      call += 1;
      if (url === defaultUrl) throw new Error('simulated network failure');
      if (url === fallbackUrl) return { json: async () => ({ jsonrpc: '2.0', id: 1, result: `0x64` }) };
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const result = await getTokenBalances('ethereum-sepolia', WALLET, {});
    expect(call).toBeGreaterThanOrEqual(2); // default attempted, then fallback
    expect(result[0].amountRaw).toBe('100');
  });

  it('a locally-registered custom token on an otherwise-empty network (e.g. ethereum-local) is checked and returned', async () => {
    const customToken = { symbol: 'DEMO', name: 'Demo Token', decimals: 2, address: '0x1111111111111111111111111111111111aaaa' };
    mockFetch({ [customToken.address.toLowerCase()]: { body: { jsonrpc: '2.0', id: 1, result: '0x2710' } } }); // 10000 raw = 100.00

    const result = await getTokenBalances('ethereum-local', WALLET, { customTokens: [customToken] });
    expect(result).toEqual([
      {
        symbol: 'DEMO',
        name: 'Demo Token',
        amountRaw: '10000',
        decimals: 2,
        amountFormatted: '100.00',
        address: customToken.address
      }
    ]);
  });

  it('a stale custom-token entry pointing at a nonexistent contract (eth_call returns empty "0x") is skipped silently, not treated as an error', async () => {
    // Routine after a local anvil restart: every previously-deployed
    // contract address vanishes, but a chrome.storage.local custom-token
    // entry for it survives the restart untouched. eth_call to an address
    // with no contract deployed doesn't revert — it just returns "0x"
    // (empty return data), which used to make BigInt("0x") throw and take
    // the ENTIRE network's token fetch down with it (confirmed live, not
    // just theorized).
    const deadContract = { symbol: 'DEAD', name: 'Dead Contract', decimals: 6, address: '0x2222222222222222222222222222222222dead' };
    const liveContract = { symbol: 'LIVE', name: 'Live Contract', decimals: 6, address: '0x3333333333333333333333333333333333333f' };
    mockFetch({
      [deadContract.address.toLowerCase()]: { body: { jsonrpc: '2.0', id: 1, result: '0x' } },
      [liveContract.address.toLowerCase()]: { body: { jsonrpc: '2.0', id: 1, result: '0x1e8480' } } // 2,000,000 raw
    });

    const result = await getTokenBalances('ethereum-local', WALLET, { customTokens: [deadContract, liveContract] });
    expect(result).toEqual([
      {
        symbol: 'LIVE',
        name: 'Live Contract',
        amountRaw: '2000000',
        decimals: 6,
        amountFormatted: '2.000000',
        address: liveContract.address
      }
    ]);
  });

  it('an unexpected per-token error (not just an empty "0x" result) is isolated to that one token, not the whole network', async () => {
    const brokenToken = { symbol: 'BROKEN', name: 'Broken Token', decimals: 6, address: '0x4444444444444444444444444444444444444b' };
    const healthyToken = { symbol: 'OK', name: 'Healthy Token', decimals: 6, address: '0x5555555555555555555555555555555555555a' };
    globalThis.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      const to = body.params[0].to.toLowerCase();
      if (to === brokenToken.address.toLowerCase()) {
        // Malformed response shape — .json() itself throws, simulating
        // something neither a clean success nor a clean rejected fetch.
        return { json: async () => { throw new Error('simulated malformed response'); } };
      }
      return { json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x2710' }) }; // 10000 raw
    });

    const result = await getTokenBalances('ethereum-local', WALLET, { customTokens: [brokenToken, healthyToken] });
    expect(result).toEqual([
      {
        symbol: 'OK',
        name: 'Healthy Token',
        amountRaw: '10000',
        decimals: 6,
        amountFormatted: '0.010000',
        address: healthyToken.address
      }
    ]);
  });
});

describe('getTokenBalances — validation', () => {
  it('rejects an unknown network key', async () => {
    await expect(getTokenBalances('dogecoin', WALLET, {})).rejects.toThrow(/Unknown network/);
  });
});

/** Installs a fetch mock for the three ERC-20 metadata eth_calls (symbol/name/decimals), keyed by selector (the last 8 hex chars of `data`) rather than target address — all three calls in fetchErc20Metadata go to the SAME address, only the selector differs. `handlers` maps a selector to either { body } or { reject: 'message' }. */
function mockMetadataFetch(handlers) {
  globalThis.fetch = vi.fn(async (url, opts) => {
    const body = JSON.parse(opts.body);
    const selector = body.params[0].data;
    const entry = handlers[selector];
    if (!entry) throw new Error(`Unexpected selector: ${selector}`);
    if (entry.reject) throw new Error(entry.reject);
    return { json: async () => entry.body };
  });
}

const SYMBOL_SELECTOR = '0x95d89b41';
const NAME_SELECTOR = '0x06fdde03';
const DECIMALS_SELECTOR = '0x313ce567';

describe('fetchErc20Metadata — "Add custom token" auto-fetch', () => {
  it('resolves symbol/name/decimals when all three calls succeed', async () => {
    mockMetadataFetch({
      [SYMBOL_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: ABI_USDC } },
      [NAME_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: ABI_USDC } },
      [DECIMALS_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: ABI_DECIMALS_6 } }
    });

    const result = await fetchErc20Metadata('ethereum-sepolia', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    expect(result).toEqual({ symbol: 'USDC', name: 'USDC', decimals: 6 });
  });

  it('rejects with "No contract found" when all three calls return empty "0x" (a dead/nonexistent address)', async () => {
    mockMetadataFetch({
      [SYMBOL_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: EMPTY } },
      [NAME_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: EMPTY } },
      [DECIMALS_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: EMPTY } }
    });

    await expect(fetchErc20Metadata('ethereum-sepolia', '0x000000000000000000000000000000DeadBeef')).rejects.toThrow(/No contract found/);
  });

  it('still resolves (with nulls for the missing fields) when only decimals succeeds — a contract existing is enough, symbol/name are optional', async () => {
    mockMetadataFetch({
      [SYMBOL_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: EMPTY } },
      [NAME_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: EMPTY } },
      [DECIMALS_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: ABI_DECIMALS_6 } }
    });

    const result = await fetchErc20Metadata('ethereum-sepolia', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    expect(result).toEqual({ symbol: null, name: null, decimals: 6 });
  });

  it('rethrows the original RPC-unreachable error, not "No contract found", when the network itself is down', async () => {
    mockMetadataFetch({
      [SYMBOL_SELECTOR]: { reject: 'simulated network failure' },
      [NAME_SELECTOR]: { reject: 'simulated network failure' },
      [DECIMALS_SELECTOR]: { reject: 'simulated network failure' }
    });

    await expect(fetchErc20Metadata('ethereum-sepolia', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')).rejects.toThrow(/Could not reach/);
  });

  it('is a real, checkable RpcUnreachableError instance when the network is down — not just an Error whose message happens to match', async () => {
    mockMetadataFetch({
      [SYMBOL_SELECTOR]: { reject: 'simulated network failure' },
      [NAME_SELECTOR]: { reject: 'simulated network failure' },
      [DECIMALS_SELECTOR]: { reject: 'simulated network failure' }
    });

    await expect(fetchErc20Metadata('ethereum-sepolia', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')).rejects.toBeInstanceOf(
      RpcUnreachableError
    );
  });

  /**
   * REGRESSION TEST for the real bug found in manual verification of
   * prompt 0119 (see prompt/0119-add-token-ux-two-step.md's own
   * Revision 1): fetchErc20Metadata fires 3 CONCURRENT eth_calls
   * (symbol/name/decimals) against the SAME endpoint. With a genuinely
   * dead local anvil, real Chrome testing found that ONE of the three
   * concurrent requests could still come back with a real (if empty)
   * HTTP response while the other two failed to even connect — and the
   * OLD logic ("No contract found" whenever nothing resolved to real
   * data, with no regard for WHY each field came back empty) silently
   * treated that single "successful but empty" response as proof there's
   * no contract, discarding the two genuine connection failures
   * entirely. Reproduced directly here with a mocked fetch shaped
   * exactly that way — one selector resolves with empty "0x", the other
   * two reject — proven (before the fix landed) to throw "No contract
   * found" instead of the correct "Could not reach" / RpcUnreachableError.
   */
  it('classifies as RPC-unreachable, NOT "No contract found", when even ONE of the three concurrent calls hits a transport failure — a flaky/partially-reachable RPC must never be silently outvoted by a single successful-but-empty response', async () => {
    mockMetadataFetch({
      [SYMBOL_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: EMPTY } }, // this one field genuinely got a (empty) response
      [NAME_SELECTOR]: { reject: 'simulated network failure' },
      [DECIMALS_SELECTOR]: { reject: 'simulated network failure' }
    });

    await expect(fetchErc20Metadata('ethereum-sepolia', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')).rejects.toThrow(/Could not reach/);
    // Re-run against a fresh mock (the first assertion already consumed
    // the 3 mocked calls) to also confirm the TYPE, not just the message.
    mockMetadataFetch({
      [SYMBOL_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: EMPTY } },
      [NAME_SELECTOR]: { reject: 'simulated network failure' },
      [DECIMALS_SELECTOR]: { reject: 'simulated network failure' }
    });
    await expect(fetchErc20Metadata('ethereum-sepolia', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')).rejects.toBeInstanceOf(
      RpcUnreachableError
    );
  });

  it('the same mixed-outcome protection holds regardless of WHICH of the three fields is the one that got a real (empty) response', async () => {
    mockMetadataFetch({
      [SYMBOL_SELECTOR]: { reject: 'simulated network failure' },
      [NAME_SELECTOR]: { reject: 'simulated network failure' },
      [DECIMALS_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: EMPTY } }
    });

    await expect(fetchErc20Metadata('ethereum-sepolia', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')).rejects.toThrow(/Could not reach/);
  });

  it('still resolves normally (does NOT misfire as rpc-unreachable) when one field transport-fails but another field returns REAL, non-empty data — a live, answering node with one flaky field is not the same as an unreachable one', async () => {
    mockMetadataFetch({
      [SYMBOL_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: ABI_USDC } },
      [NAME_SELECTOR]: { reject: 'simulated network failure' },
      [DECIMALS_SELECTOR]: { body: { jsonrpc: '2.0', id: 1, result: ABI_DECIMALS_6 } }
    });

    const result = await fetchErc20Metadata('ethereum-sepolia', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    expect(result).toEqual({ symbol: 'USDC', name: null, decimals: 6 });
  });

  it('rejects an unknown network', async () => {
    await expect(fetchErc20Metadata('dogecoin', '0x000000000000000000000000000000DeadBeef')).rejects.toThrow(/Unknown network/);
  });

  it('rejects a Solana network (not EVM)', async () => {
    await expect(fetchErc20Metadata('solana-devnet', '0x000000000000000000000000000000DeadBeef')).rejects.toThrow(/not an EVM network/);
  });
});

describe('fetchSolanaMintInfo — "Add custom token" auto-fetch', () => {
  it('resolves decimals for a valid mint account', async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: { value: { data: { parsed: { type: 'mint', info: { decimals: 6 } } } } }
      })
    }));

    const result = await fetchSolanaMintInfo('solana-devnet', getTokensForNetwork('solana-devnet')[0].address);
    expect(result).toEqual({ decimals: 6 });
  });

  it('rejects when the account does not exist', async () => {
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: null } }) }));
    await expect(fetchSolanaMintInfo('solana-devnet', 'SoLNonexistent111111111111111111111111111')).rejects.toThrow(/No SPL mint found/);
  });

  it('rejects when the account exists but is not a mint (e.g. a regular token account)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: { value: { data: { parsed: { type: 'account', info: {} } } } }
      })
    }));
    await expect(fetchSolanaMintInfo('solana-devnet', 'SoLTokenAccount111111111111111111111111111')).rejects.toThrow(/No SPL mint found/);
  });

  it('rejects when decimals cannot be read from a parsed mint', async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: { value: { data: { parsed: { type: 'mint', info: {} } } } }
      })
    }));
    await expect(fetchSolanaMintInfo('solana-devnet', 'SoLBadMint1111111111111111111111111111111')).rejects.toThrow(/Could not read decimals/);
  });

  it('propagates an RPC failure as a rejection', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('simulated network failure'); });
    await expect(fetchSolanaMintInfo('solana-devnet', 'SoLAnyAddress11111111111111111111111111111')).rejects.toThrow(/Could not reach/);
  });

  /**
   * Confirms (per prompt 0119's own Revision 1 task 3 — "check whether
   * Solana's classification path has the same flaw, fix it if so, report
   * if not") that fetchSolanaMintInfo does NOT have the EVM side's
   * mixed-outcome bug, and explains why structurally rather than just
   * asserting it: this function makes exactly ONE RPC call
   * (getAccountInfo), never several concurrent ones the way
   * fetchErc20Metadata's symbol/name/decimals calls do — there is no
   * "some of several concurrent requests succeed while others fail"
   * race possible here at all, so a connection failure always propagates
   * as-is, with no classification step of its own to get wrong. Verified
   * directly (not just reasoned about): the thrown error is a real
   * RpcUnreachableError instance, the same structural signal
   * background.js's FLUXIO_INTERNAL_PREVIEW_CUSTOM_TOKEN now checks via
   * `instanceof` for both chains.
   */
  it('propagates a real, checkable RpcUnreachableError instance on RPC failure — confirms no mixed-outcome bug exists here (unlike the EVM side before its fix): this function only ever makes ONE RPC call, so there is no "multiple concurrent calls, some succeed some fail" race to misclassify', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('simulated network failure'); });
    await expect(fetchSolanaMintInfo('solana-devnet', 'SoLAnyAddress11111111111111111111111111111')).rejects.toBeInstanceOf(
      RpcUnreachableError
    );
  });

  it('rejects an unknown network', async () => {
    await expect(fetchSolanaMintInfo('dogecoin', 'SoLAnyAddress11111111111111111111111111111')).rejects.toThrow(/Unknown network/);
  });

  it('rejects an EVM network (not Solana)', async () => {
    await expect(fetchSolanaMintInfo('ethereum-sepolia', 'SoLAnyAddress11111111111111111111111111111')).rejects.toThrow(/not a Solana network/);
  });
});

// Prompt 0206 butir 2 — USDT joined the Solana mainnet registry after the
// 0205 real-money round showed the owner's held USDT labeled "Unknown"
// everywhere. The mint is Tether's own documented Solana contract address
// (tether.to's integration page) — locked here so a registry edit can
// never silently drop or change it.
describe('SOLANA mainnet registry — USDT (prompt 0206)', () => {
  it('carries USDT at Tether\'s documented mint, 6 decimals', () => {
    const usdt = getTokensForNetwork('solana').find((t) => t.symbol === 'USDT');
    expect(usdt).toMatchObject({
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    });
  });
});
