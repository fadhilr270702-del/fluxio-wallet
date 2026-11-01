import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getSwapQuote,
  getVerifiedTokens,
  buildSwapTransaction,
  resolveFeeAccount,
  computePlatformFeeDisplayRaw,
  SwapValidationError,
  SWAP_FEE_BPS,
  SWAP_FEE_ACCOUNTS,
  SWAP_FEE_ACCOUNT_OWNER,
  SWAP_EXECUTION_ENABLED,
  SWAP_PRIORITY_FEE_CAP_LAMPORTS,
  SWAP_PRIORITY_FEE_LEVEL,
  NATIVE_SOL_MINT
} from '../swapService.js';

const SOL = NATIVE_SOL_MINT;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FEE_ACCOUNT = 'HM2tV6hdcRFvPkcspwWvs9KU7rwKTyEa6UXGPc6v6TFy'; // an arbitrary valid base58 address, not a real fee account
const USER = 'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1';

const QUOTE_RESPONSE = {
  inputMint: SOL,
  inAmount: '1000000000',
  outputMint: USDC,
  outAmount: '150000000',
  otherAmountThreshold: '149250000',
  swapMode: 'ExactIn',
  slippageBps: 50,
  priceImpactPct: '0.01',
  routePlan: []
};

/** Installs a fetch mock keyed by exact URL string (query string included), then by method — mirrors transactionService.test.js's mockRpc, adapted for a plain-REST (not JSON-RPC) API. */
function mockFetch(responsesByUrl) {
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET';
    const entry = responsesByUrl[url]?.[method];
    if (!entry) throw new Error(`Unexpected fetch: ${method} ${url}`);
    if (entry.reject) throw new Error(entry.reject);
    return {
      ok: entry.status == null || entry.status < 400,
      status: entry.status ?? 200,
      json: async () => entry.body
    };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('getSwapQuote', () => {
  it('fetches a real-shaped quote with no fee param when feeBps/feeAccount are omitted', async () => {
    const url = 'https://lite-api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + USDC + '&amount=1000000000&slippageBps=50';
    mockFetch({ [url]: { GET: { body: QUOTE_RESPONSE } } });

    const result = await getSwapQuote({ inputMint: SOL, outputMint: USDC, amountRaw: 1_000_000_000n, slippageBps: 50 });
    expect(result.inAmountRaw).toBe(1_000_000_000n);
    expect(result.outAmountRaw).toBe(150_000_000n);
    expect(result.minReceivedRaw).toBe(149_250_000n);
    expect(result.priceImpactPct).toBeCloseTo(0.01);
    expect(result.feeIncluded).toBe(false);
    expect(result.feeAmountRaw).toBeNull();
    expect(result.raw).toEqual(QUOTE_RESPONSE);
  });

  it('includes platformFeeBps in the request only when both feeBps and feeAccount are given, and reflects platformFee back in the parsed result', async () => {
    const url =
      'https://lite-api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + USDC + '&amount=1000000000&slippageBps=50&platformFeeBps=85';
    const responseWithFee = { ...QUOTE_RESPONSE, platformFee: { amount: '1275000', feeBps: 85 } };
    mockFetch({ [url]: { GET: { body: responseWithFee } } });

    const result = await getSwapQuote({
      inputMint: SOL,
      outputMint: USDC,
      amountRaw: 1_000_000_000n,
      slippageBps: 50,
      feeBps: SWAP_FEE_BPS,
      feeAccount: FEE_ACCOUNT
    });
    expect(result.feeIncluded).toBe(true);
    expect(result.feeBps).toBe(85);
    expect(result.feeAmountRaw).toBe(1_275_000n);
  });

  it('rejects feeBps without a matching feeAccount (and vice versa) rather than silently dropping or guessing', async () => {
    await expect(
      getSwapQuote({ inputMint: SOL, outputMint: USDC, amountRaw: 1n, slippageBps: 50, feeBps: 85 })
    ).rejects.toMatchObject({ code: 'INCOMPLETE_FEE_PARAMS' });
    await expect(
      getSwapQuote({ inputMint: SOL, outputMint: USDC, amountRaw: 1n, slippageBps: 50, feeAccount: FEE_ACCOUNT })
    ).rejects.toMatchObject({ code: 'INCOMPLETE_FEE_PARAMS' });
  });

  it('rejects an invalid mint address', async () => {
    await expect(
      getSwapQuote({ inputMint: 'not-a-mint', outputMint: USDC, amountRaw: 1_000_000n, slippageBps: 50 })
    ).rejects.toMatchObject({ code: 'INVALID_MINT' });
  });

  it('rejects a zero or negative amount', async () => {
    await expect(getSwapQuote({ inputMint: SOL, outputMint: USDC, amountRaw: 0n, slippageBps: 50 })).rejects.toMatchObject({
      code: 'INVALID_AMOUNT'
    });
  });

  it.each([0, -50, 5001, 1.5])('rejects an out-of-range or non-integer slippageBps (%s)', async (bad) => {
    await expect(
      getSwapQuote({ inputMint: SOL, outputMint: USDC, amountRaw: 1_000_000n, slippageBps: bad })
    ).rejects.toMatchObject({ code: 'INVALID_SLIPPAGE' });
  });

  it('surfaces an illiquid-pair error from Jupiter (no route found) as a clear thrown error, not a crash on undefined fields', async () => {
    const url = 'https://lite-api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + USDC + '&amount=1000000000&slippageBps=50';
    mockFetch({
      [url]: { GET: { status: 400, body: { error: 'Could not find any route', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' } } }
    });

    await expect(getSwapQuote({ inputMint: SOL, outputMint: USDC, amountRaw: 1_000_000_000n, slippageBps: 50 })).rejects.toThrow(
      /Could not find any route/
    );
  });

  it('surfaces a transport/API-down failure distinctly ("Could not reach Jupiter")', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network unreachable');
    });

    await expect(getSwapQuote({ inputMint: SOL, outputMint: USDC, amountRaw: 1_000_000_000n, slippageBps: 50 })).rejects.toThrow(
      /Could not reach Jupiter/
    );
  });

  it('throws a clear error on a non-JSON response instead of an unhandled parse exception', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      }
    }));

    await expect(getSwapQuote({ inputMint: SOL, outputMint: USDC, amountRaw: 1_000_000_000n, slippageBps: 50 })).rejects.toThrow(
      /non-JSON response/
    );
  });
});

describe('getVerifiedTokens', () => {
  it('normalizes both the older (address/logoURI) and newer (id/icon) Jupiter token-list shapes', async () => {
    mockFetch({
      'https://lite-api.jup.ag/tokens/v2/tag?query=verified': {
        GET: {
          body: [
            { address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: 'https://example.com/usdc.png' },
            { id: SOL, symbol: 'SOL', name: 'Wrapped SOL', decimals: 9, icon: 'https://example.com/sol.png' }
          ]
        }
      }
    });

    const tokens = await getVerifiedTokens();
    expect(tokens).toEqual([
      { address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, logoUri: 'https://example.com/usdc.png' },
      // The native-SOL stand-in mint is renamed "Solana" (prompt 0203
      // Revisi 3, owner report: "SOL Wrapped SOL" reads like a different
      // asset when the user is swapping native SOL) — see
      // normalizeVerifiedToken's own comment.
      { address: SOL, symbol: 'SOL', name: 'Solana', decimals: 9, logoUri: 'https://example.com/sol.png' }
    ]);
  });

  it('drops an entry missing a resolvable address or decimals rather than passing through a broken row', async () => {
    mockFetch({
      'https://lite-api.jup.ag/tokens/v2/tag?query=verified': {
        GET: {
          body: [
            { symbol: 'BROKEN', name: 'No address', decimals: 6 },
            { address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6 }
          ]
        }
      }
    });

    const tokens = await getVerifiedTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].address).toBe(USDC);
  });

  it('rejects a response that is not an array', async () => {
    mockFetch({ 'https://lite-api.jup.ag/tokens/v2/tag?query=verified': { GET: { body: { not: 'an array' } } } });
    await expect(getVerifiedTokens()).rejects.toThrow(/unexpected token-list response/);
  });
});

describe('buildSwapTransaction', () => {
  it('posts the quote response + userPublicKey and returns the unsigned serialized transaction', async () => {
    globalThis.fetch = vi.fn(async (url, options) => {
      expect(url).toBe('https://lite-api.jup.ag/swap/v1/swap');
      const body = JSON.parse(options.body);
      expect(body.userPublicKey).toBe(USER);
      expect(body.quoteResponse).toEqual(QUOTE_RESPONSE);
      expect(body.feeAccount).toBeUndefined();
      return { ok: true, status: 200, json: async () => ({ swapTransaction: 'base64-tx-bytes' }) };
    });

    const result = await buildSwapTransaction({ quoteResponse: QUOTE_RESPONSE, userPublicKey: USER });
    expect(result.swapTransactionBase64).toBe('base64-tx-bytes');
  });

  it('includes feeAccount in the request body when provided', async () => {
    globalThis.fetch = vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      expect(body.feeAccount).toBe(FEE_ACCOUNT);
      return { ok: true, status: 200, json: async () => ({ swapTransaction: 'base64-tx-bytes' }) };
    });

    await buildSwapTransaction({ quoteResponse: QUOTE_RESPONSE, userPublicKey: USER, feeAccount: FEE_ACCOUNT });
  });

  it('rejects an invalid user address', async () => {
    await expect(
      buildSwapTransaction({ quoteResponse: QUOTE_RESPONSE, userPublicKey: 'not-an-address' })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });

  it('rejects a missing/malformed quote response', async () => {
    await expect(buildSwapTransaction({ quoteResponse: null, userPublicKey: USER })).rejects.toMatchObject({
      code: 'INVALID_QUOTE'
    });
    await expect(buildSwapTransaction({ quoteResponse: { foo: 'bar' }, userPublicKey: USER })).rejects.toMatchObject({
      code: 'INVALID_QUOTE'
    });
  });

  it('throws if Jupiter does not return a swapTransaction', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await expect(buildSwapTransaction({ quoteResponse: QUOTE_RESPONSE, userPublicKey: USER })).rejects.toThrow(
      /did not return a swap transaction/
    );
  });

  // Prompt 0200 — the build response's real numbers now ride along (the
  // popup shows them and the expiry check needs lastValidBlockHeight).
  it('returns prioritizationFeeLamports/computeUnitLimit/lastValidBlockHeight from the build response, null when absent', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        swapTransaction: 'base64-tx-bytes',
        prioritizationFeeLamports: 56000,
        computeUnitLimit: 1400000,
        lastValidBlockHeight: 424593183
      })
    }));
    const result = await buildSwapTransaction({ quoteResponse: QUOTE_RESPONSE, userPublicKey: USER });
    expect(result.prioritizationFeeLamports).toBe(56000);
    expect(result.computeUnitLimit).toBe(1400000);
    expect(result.lastValidBlockHeight).toBe(424593183);

    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ swapTransaction: 'x' }) }));
    const bare = await buildSwapTransaction({ quoteResponse: QUOTE_RESPONSE, userPublicKey: USER });
    expect(bare.prioritizationFeeLamports).toBeNull();
    expect(bare.computeUnitLimit).toBeNull();
    expect(bare.lastValidBlockHeight).toBeNull();
  });

  // Prompt 0206 butir 5 (owner opsi A) — every build request caps its
  // priority fee at 150000 lamports / 'high', and an above-cap response
  // is refused before anything could sign it. The cap value itself is
  // asserted literally (not just via the constant) so a silent constant
  // change can't slip past unnoticed.
  it('sends the capped priorityLevelWithMaxLamports param on every build request', async () => {
    expect(SWAP_PRIORITY_FEE_CAP_LAMPORTS).toBe(150000);
    expect(SWAP_PRIORITY_FEE_LEVEL).toBe('high');
    globalThis.fetch = vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      expect(body.prioritizationFeeLamports).toEqual({
        priorityLevelWithMaxLamports: { maxLamports: 150000, priorityLevel: 'high' }
      });
      return { ok: true, status: 200, json: async () => ({ swapTransaction: 'base64-tx-bytes' }) };
    });
    await buildSwapTransaction({ quoteResponse: QUOTE_RESPONSE, userPublicKey: USER });
    // The param rides along regardless of whether a feeAccount does.
    await buildSwapTransaction({ quoteResponse: QUOTE_RESPONSE, userPublicKey: USER, feeAccount: FEE_ACCOUNT });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a build response whose prioritizationFeeLamports exceeds the cap, and accepts one at the cap', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ swapTransaction: 'base64-tx-bytes', prioritizationFeeLamports: SWAP_PRIORITY_FEE_CAP_LAMPORTS + 1 })
    }));
    await expect(buildSwapTransaction({ quoteResponse: QUOTE_RESPONSE, userPublicKey: USER })).rejects.toMatchObject({
      code: 'SWAP_PRIORITY_FEE_ABOVE_CAP'
    });

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ swapTransaction: 'base64-tx-bytes', prioritizationFeeLamports: SWAP_PRIORITY_FEE_CAP_LAMPORTS })
    }));
    const atCap = await buildSwapTransaction({ quoteResponse: QUOTE_RESPONSE, userPublicKey: USER });
    expect(atCap.prioritizationFeeLamports).toBe(SWAP_PRIORITY_FEE_CAP_LAMPORTS);
  });
});

// Prompt 0200 (owner decision K2b) — fee only when INPUT or OUTPUT mint
// has a fee account, output side wins, no entry on either side = null
// (and the caller then omits platformFeeBps entirely, since Jupiter's
// /swap rejects a fee-quote without a feeAccount — live-proven in 0199).
describe('resolveFeeAccount', () => {
  const OUT_ACCOUNT = 'HM2tV6hdcRFvPkcspwWvs9KU7rwKTyEa6UXGPc6v6TFy';
  const IN_ACCOUNT = 'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1';

  it('picks the OUTPUT mint entry when present (even when the input mint also has one — output wins)', () => {
    expect(resolveFeeAccount(SOL, USDC, { [USDC]: OUT_ACCOUNT })).toEqual({
      feeAccount: OUT_ACCOUNT,
      feeMint: USDC,
      feeSide: 'output'
    });
    expect(resolveFeeAccount(SOL, USDC, { [USDC]: OUT_ACCOUNT, [SOL]: IN_ACCOUNT })).toEqual({
      feeAccount: OUT_ACCOUNT,
      feeMint: USDC,
      feeSide: 'output'
    });
  });

  it('falls back to the INPUT mint entry when only that side has one', () => {
    expect(resolveFeeAccount(USDC, SOL, { [USDC]: IN_ACCOUNT })).toEqual({
      feeAccount: IN_ACCOUNT,
      feeMint: USDC,
      feeSide: 'input'
    });
  });

  it('returns null when neither side has an entry', () => {
    expect(resolveFeeAccount(SOL, USDC, {})).toBeNull();
    // The emergency build switch ships ON.
    expect(SWAP_EXECUTION_ENABLED).toBe(true);
  });
});

// Prompt 0203 — the map is FILLED now: exactly one entry, USDC -> the
// treasury wallet's own USDC ATA (owner FnjdJ…PiwQ, verified initialized
// on-chain before being recorded — see that prompt's archive). These
// tests lock the exact production values so an accidental edit to either
// address can never slip through silently.
describe('SWAP_FEE_ACCOUNTS (filled, prompt 0203)', () => {
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const TREASURY_USDC_ATA = '6tyoAgzhyGgGNrxyyR68DHvfUySo4kdh1RukgU78Ep2j';
  const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

  it('holds exactly the one USDC entry, frozen, with the exact treasury ATA', () => {
    expect(SWAP_FEE_ACCOUNTS).toEqual({ [USDC_MINT]: TREASURY_USDC_ATA });
    expect(Object.isFrozen(SWAP_FEE_ACCOUNTS)).toBe(true);
  });

  it('SWAP_FEE_ACCOUNT_OWNER is the exact treasury wallet (prompt 0209 — the fee-account guard compares the on-chain parsed owner against it)', () => {
    expect(SWAP_FEE_ACCOUNT_OWNER).toBe('FnjdJcYsQShxUTPJjgVnjjvw5kKsVwfxtFCWBJMjPiwQ');
  });

  it('resolves the treasury ATA for SOL->USDC (output side) and USDC->SOL (input side) using the PRODUCTION map', () => {
    expect(resolveFeeAccount(SOL, USDC)).toEqual({
      feeAccount: TREASURY_USDC_ATA,
      feeMint: USDC_MINT,
      feeSide: 'output'
    });
    expect(resolveFeeAccount(USDC, SOL)).toEqual({
      feeAccount: TREASURY_USDC_ATA,
      feeMint: USDC_MINT,
      feeSide: 'input'
    });
  });

  it('resolves NO fee for a pair without USDC on either side (SOL->BONK), per the 0199/0200 decision', () => {
    expect(resolveFeeAccount(SOL, BONK)).toBeNull();
  });
});

// Prompt 0203 Revisi 3 — real-money display bug: Jupiter's
// quote.platformFee.amount is ALWAYS output-denominated (live quote
// USDC->SOL 0.480995 @85bps answered amount "42064" = 0.85% of its own
// outAmount in LAMPORTS), while the chain charges an input-side fee from
// the INPUT amount (the owner's real swap: treasury +4088 raw USDC =
// floor(480995×85/10000) exactly). These tests pin both sides with the
// REAL numbers from that incident.
describe('computePlatformFeeDisplayRaw', () => {
  it('INPUT side: computes from the input amount — 480995 raw USDC @85bps -> 4088 (the exact on-chain fee), NEVER Jupiter\'s output-denominated 42064', () => {
    const result = computePlatformFeeDisplayRaw({
      feeSide: 'input',
      feeBps: SWAP_FEE_BPS,
      inAmountRaw: 480995n,
      quoteFeeAmountRaw: 42064n // what the real quote said — lamports, wrong currency for display
    });
    expect(result).toBe(4088n);
    expect(result).not.toBe(42064n);
  });

  it('OUTPUT side: passes Jupiter\'s own number through — swap 1\'s 4123 raw USDC, chain-proven (treasury 0.5 -> 0.504123)', () => {
    expect(
      computePlatformFeeDisplayRaw({ feeSide: 'output', feeBps: SWAP_FEE_BPS, inAmountRaw: 5000000n, quoteFeeAmountRaw: 4123n })
    ).toBe(4123n);
    // Cross-check the chain math itself: 0.85% of the gross output
    // 485118 (480995 received + 4123 fee) floors to that same 4123.
    expect((485118n * BigInt(SWAP_FEE_BPS)) / 10000n).toBe(4123n);
  });

  it('BigInt floor, never rounding up: 480995×85/10000 = 4088.4575 -> 4088', () => {
    expect((480995n * 85n) / 10000n).toBe(4088n);
    expect(computePlatformFeeDisplayRaw({ feeSide: 'input', feeBps: 85, inAmountRaw: 480995n, quoteFeeAmountRaw: null })).toBe(4088n);
  });

  it('OUTPUT side with no quote fee returns null (caller renders no fee row)', () => {
    expect(computePlatformFeeDisplayRaw({ feeSide: 'output', feeBps: 85, inAmountRaw: 1n, quoteFeeAmountRaw: null })).toBeNull();
  });
});

describe('SwapValidationError', () => {
  it('is a real Error subclass carrying a machine-readable code', () => {
    const err = new SwapValidationError('SOME_CODE', 'some message');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('SOME_CODE');
    expect(err.name).toBe('SwapValidationError');
  });
});
