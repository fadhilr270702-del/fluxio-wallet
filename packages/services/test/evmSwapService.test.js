// evmSwapService (prompt 0219, tahap A) — unit tests on the REAL 0218
// fixtures (prompt/evidence/0218-evm-swap-spike/), real data shapes per
// the binding lesson. fetch is mocked; no network is ever touched.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getEvmSwapQuote,
  estimateEvmSwapFeeWei,
  EvmSwapValidationError,
  NATIVE_EVM_SENTINEL,
  EVM_SWAP_EXECUTION_ENABLED,
  EVM_SWAP_FEE_OPTIONS,
  EVM_SWAP_CLIENT_ID,
  EVM_SWAP_GAS_LIMIT_CAP_BY_NETWORK,
  EVM_SWAP_MAX_FEE_PER_GAS_CAP_BY_NETWORK,
  getEvmSwapCaps,
  pickSignedMaxFeePerGas,
  estimateL1FeeWei,
  EVM_L1_FEE_ORACLE_BY_NETWORK,
  getEvmFeePerGas,
  isEvmSwapNetwork,
  EVM_SWAP_NETWORK_KEYS,
  KYBER_CHAIN_SLUGS,
  EVM_SWAP_NATIVE_COIN_IDS,
  EVM_SWAP_REBROADCAST_INTERVAL_MS,
  EVM_SWAP_PENDING_TIMEOUT_MS,
  EVM_SWAP_SANITY_MAX_DEVIATION,
  EVM_SWAP_SANITY_PRICE_MAX_AGE_MS,
  buildEvmSwapTransaction,
  verifyEvmSwapBuild,
  parseErc20ReceivedFromReceipt,
  computeQuoteUsdDeviation,
  verifyEvmFeeEcho,
  computeEvmSwapFeeRaw,
  EVM_SWAP_FEE_RECEIVER,
  getErc20Allowance,
  getErc20Balance,
  buildErc20ApproveCalldata,
  computeEvmNativeReceivedFromBalances,
  getEvmBalanceAtBlock
} from '../evmSwapService.js';
import { getAddress } from 'ethers';
import { getEvmTipFloorWei } from '@fluxio/constants';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', '..', '..', 'prompt', 'evidence', '0218-evm-swap-spike');
const FIX_BNB2USDT = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'kyber-bnb2usdt.json'), 'utf8'));
const FIX_USDT2BNB = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'kyber-usdt2bnb.json'), 'utf8'));
const USDT = '0x55d398326f99059fF775485246999027B3197955';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetchJson(payload, { status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers || {} });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return calls;
}

describe('getEvmSwapQuote — real 0218 fixtures', () => {
  it('BNB -> USDT: parses the exact raw amounts, gas and router from the fixture, and sends the client id (not a key)', async () => {
    const calls = mockFetchJson(FIX_BNB2USDT);
    const q = await getEvmSwapQuote({ networkKey: 'bnb', tokenIn: NATIVE_EVM_SENTINEL, tokenOut: USDT, amountInRaw: 1000000000000000n });
    expect(q.amountInRaw).toBe(1000000000000000n);
    expect(q.amountOutRaw).toBe(753258826981658902n); // exact, from the archived live quote
    expect(q.gasEstimate).toBe(268831n);
    expect(q.routerAddress).toBe('0x6131B5fae19EA4f9D964eAc0408E4408b66337b5');
    expect(calls[0].url).toContain('/bsc/api/v1/routes?');
    expect(calls[0].headers['X-Client-Id']).toBe(EVM_SWAP_CLIENT_ID);
  });

  it('USDT -> BNB: exact raw output from the fixture', async () => {
    mockFetchJson(FIX_USDT2BNB);
    const q = await getEvmSwapQuote({ networkKey: 'bnb', tokenIn: USDT, tokenOut: NATIVE_EVM_SENTINEL, amountInRaw: 2990000000000000000n });
    expect(q.amountOutRaw).toBe(3969127072119130n);
    expect(q.gasEstimate).toBe(287581n);
  });

  it('implied rates land near 753 USDT per BNB both directions (1% tolerance — catches a 1e6 vs 1e18 decimals mistake outright)', async () => {
    mockFetchJson(FIX_BNB2USDT);
    const a = await getEvmSwapQuote({ networkKey: 'bnb', tokenIn: NATIVE_EVM_SENTINEL, tokenOut: USDT, amountInRaw: 1000000000000000n });
    const rateOut = Number(a.amountOutRaw) / 1e18 / (Number(a.amountInRaw) / 1e18);
    expect(rateOut).toBeGreaterThan(753 * 0.99);
    expect(rateOut).toBeLessThan(753 * 1.01);

    mockFetchJson(FIX_USDT2BNB);
    const b = await getEvmSwapQuote({ networkKey: 'bnb', tokenIn: USDT, tokenOut: NATIVE_EVM_SENTINEL, amountInRaw: 2990000000000000000n });
    const ratePaid = Number(b.amountInRaw) / 1e18 / (Number(b.amountOutRaw) / 1e18);
    expect(ratePaid).toBeGreaterThan(753 * 0.99);
    expect(ratePaid).toBeLessThan(753 * 1.01);
  });

  it('returns routeSummary deep-equal to the fixture, untouched (owner keputusan 0219 butir 4 — Kyber build checksum depends on it)', async () => {
    mockFetchJson(FIX_BNB2USDT);
    const q = await getEvmSwapQuote({ networkKey: 'bnb', tokenIn: NATIVE_EVM_SENTINEL, tokenOut: USDT, amountInRaw: 1000000000000000n });
    expect(q.routeSummary).toEqual(FIX_BNB2USDT.data.routeSummary);
  });

  it('rejects any networkKey outside EVM_SWAP_NETWORK_KEYS (ethereum and base are VALID since 0227 — revisi sadar atas tes 0219)', async () => {
    for (const networkKey of ['solana', 'bnb-testnet', 'ethereum-sepolia', 'ethereum-local']) {
      await expect(getEvmSwapQuote({ networkKey, tokenIn: NATIVE_EVM_SENTINEL, tokenOut: USDT, amountInRaw: 1n })).rejects.toMatchObject({
        code: 'SWAP_NETWORK_UNSUPPORTED'
      });
    }
  });

  it('rejects a zero or malformed amount and identical tokens', async () => {
    await expect(getEvmSwapQuote({ networkKey: 'bnb', tokenIn: NATIVE_EVM_SENTINEL, tokenOut: USDT, amountInRaw: 0n })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(getEvmSwapQuote({ networkKey: 'bnb', tokenIn: NATIVE_EVM_SENTINEL, tokenOut: USDT, amountInRaw: 'abc' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(getEvmSwapQuote({ networkKey: 'bnb', tokenIn: USDT, tokenOut: USDT, amountInRaw: 1n })).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('maps an aborted request to SWAP_QUOTE_TIMEOUT', async () => {
    globalThis.fetch = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    await expect(getEvmSwapQuote({ networkKey: 'bnb', tokenIn: NATIVE_EVM_SENTINEL, tokenOut: USDT, amountInRaw: 1n })).rejects.toMatchObject({
      code: 'SWAP_QUOTE_TIMEOUT'
    });
  });

  it('maps a non-200 to SWAP_QUOTE_FAILED', async () => {
    mockFetchJson({}, { status: 500 });
    await expect(getEvmSwapQuote({ networkKey: 'bnb', tokenIn: NATIVE_EVM_SENTINEL, tokenOut: USDT, amountInRaw: 1n })).rejects.toMatchObject({
      code: 'SWAP_QUOTE_FAILED'
    });
  });
});

describe('estimateEvmSwapFeeWei — the 0213 Send math, display only', () => {
  it('BSC shape (baseFee 0x0, tip 0x2faf080): gasLimit = floor(gas x 1,2), maxFeePerGas = tip, exact wei product', async () => {
    globalThis.fetch = async (url, opts = {}) => {
      const body = JSON.parse(opts.body);
      const result = body.method === 'eth_getBlockByNumber' ? { baseFeePerGas: '0x0' } : '0x2faf080';
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    };
    const fees = await estimateEvmSwapFeeWei({ networkKey: 'bnb', gasEstimate: 268831n });
    expect(fees.gasLimit).toBe(322597n); // floor(268831 * 12 / 10)
    expect(fees.maxFeePerGas).toBe(50000000n); // 0 * 2 + 0,05 gwei
    expect(fees.maxFeeWei).toBe(16129850000000n); // 322597 * 50_000_000
  });
});

describe('tahap-B constants (prompt 0220, owner keputusan A1/B1)', () => {
  it('execution is ON (native-in direction gated in background), the fee slot is FILLED and frozen (0221), and the caps/timeouts are the owner-approved figures', () => {
    expect(EVM_SWAP_EXECUTION_ENABLED).toBe(true);
    // 0220 shipped this slot frozen-EMPTY; 0221 (owner keputusan 15
    // Oktober 2026) filled it — the exact contents are locked by the
    // dedicated fee describe below.
    expect(Object.isFrozen(EVM_SWAP_FEE_OPTIONS)).toBe(true);
    expect(EVM_SWAP_REBROADCAST_INTERVAL_MS).toBe(15000);
    expect(EVM_SWAP_PENDING_TIMEOUT_MS).toBe(600000); // 10 menit
    expect(EVM_SWAP_SANITY_MAX_DEVIATION).toBe(0.05);
    expect(EVM_SWAP_SANITY_PRICE_MAX_AGE_MS).toBe(30000);
  });
});

// ---- 0227 (owner keputusan 0225 K1/K2/K4): network list + per-network caps

describe('EVM swap network list + per-network caps (0227, 0225 K1/K2)', () => {
  it('KYBER_CHAIN_SLUGS carries the three 0225-proven slugs and EVM_SWAP_NETWORK_KEYS derives from it', () => {
    expect(KYBER_CHAIN_SLUGS).toEqual({ bnb: 'bsc', ethereum: 'ethereum', base: 'base' });
    expect(EVM_SWAP_NETWORK_KEYS).toEqual(['bnb', 'ethereum', 'base']);
    expect(Object.isFrozen(EVM_SWAP_NETWORK_KEYS)).toBe(true);
  });
  it('isEvmSwapNetwork: true for the three members, false for everything else (prototype keys included)', () => {
    expect(isEvmSwapNetwork('bnb')).toBe(true);
    expect(isEvmSwapNetwork('ethereum')).toBe(true);
    expect(isEvmSwapNetwork('base')).toBe(true);
    expect(isEvmSwapNetwork('solana')).toBe(false);
    expect(isEvmSwapNetwork('ethereum-sepolia')).toBe(false);
    expect(isEvmSwapNetwork('toString')).toBe(false);
  });
  it('getEvmSwapCaps pins the owner K2 figures per network and THROWS on an unknown key', () => {
    expect(getEvmSwapCaps('bnb')).toEqual({ gasLimitCap: 1000000n, maxFeePerGasCap: 3000000000n });
    expect(getEvmSwapCaps('ethereum')).toEqual({ gasLimitCap: 2000000n, maxFeePerGasCap: 10000000000n }); // 10 gwei
    expect(getEvmSwapCaps('base')).toEqual({ gasLimitCap: 1500000n, maxFeePerGasCap: 500000000n }); // 0,5 gwei
    expect(EVM_SWAP_GAS_LIMIT_CAP_BY_NETWORK.ethereum).toBe(2000000n);
    expect(EVM_SWAP_MAX_FEE_PER_GAS_CAP_BY_NETWORK.base).toBe(500000000n);
    expect(() => getEvmSwapCaps('solana')).toThrow(EvmSwapValidationError);
  });
  it('EVM_SWAP_NATIVE_COIN_IDS (0225 K4): bnb -> binancecoin, ethereum and base -> ethereum', () => {
    expect(EVM_SWAP_NATIVE_COIN_IDS).toEqual({ bnb: 'binancecoin', ethereum: 'ethereum', base: 'ethereum' });
  });
});

// ---- Tahap B (prompt 0220): build + verify + parser + sanity ------------

const FIXTURE_DIR_0220 = path.join(__dirname, '..', '..', '..', 'prompt', 'evidence', '0220-evm-swap-execute');
const BUILD_BNB2USDT = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0220, 'build-bnb2usdt.json'), 'utf8'));
const QUOTE_0220_BNB2USDT = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0220, 'quote-bnb2usdt.json'), 'utf8'));
const TESTER = '0x4B2c00fD7647780F1d21694Ce51feA235De7Ca39';

describe('buildEvmSwapTransaction — real 0220 build fixture', () => {
  it('parses calldata, router, transactionValue and amounts exactly, POSTs routeSummary + sender/recipient + slippageTolerance', async () => {
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => BUILD_BNB2USDT };
    };
    const build = await buildEvmSwapTransaction({
      networkKey: 'bnb',
      routeSummary: QUOTE_0220_BNB2USDT.data.routeSummary,
      sender: TESTER,
      recipient: TESTER,
      slippageBps: 50
    });
    expect(calls[0].url).toBe('https://aggregator-api.kyberswap.com/bsc/api/v1/route/build');
    expect(calls[0].body.routeSummary).toEqual(QUOTE_0220_BNB2USDT.data.routeSummary); // UTUH — the checksum rule
    expect(calls[0].body.sender).toBe(TESTER);
    expect(calls[0].body.recipient).toBe(TESTER);
    expect(calls[0].body.slippageTolerance).toBe(50);
    expect(build.calldata).toBe(BUILD_BNB2USDT.data.data);
    expect(build.calldata.startsWith('0xe21fd0e9')).toBe(true); // the archived live selector
    expect(build.routerAddress).toBe('0x6131B5fae19EA4f9D964eAc0408E4408b66337b5');
    expect(build.transactionValueRaw).toBe(1000000000000000n); // native-in: EXACTLY the swap amount
    expect(build.amountInRaw).toBe(1000000000000000n);
    expect(build.amountOutRaw).toBe(733567528839934470n); // the live build echoes the quote minus 1 raw
    expect(build.gasRaw).toBe(268831n);
  });

  it('a non-zero Kyber code is a structured EVM_SWAP_BUILD_FAILED, never a signed anything', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 4008, message: 'Route not found', data: null }) });
    await expect(
      buildEvmSwapTransaction({ networkKey: 'bnb', routeSummary: QUOTE_0220_BNB2USDT.data.routeSummary, sender: TESTER, recipient: TESTER, slippageBps: 50 })
    ).rejects.toMatchObject({ code: 'EVM_SWAP_BUILD_FAILED' });
  });

  it('rejects an out-of-range slippage before any network call (Kyber documented range [0, 2000])', async () => {
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; throw new Error('must not be reached'); };
    await expect(
      buildEvmSwapTransaction({ networkKey: 'bnb', routeSummary: {}, sender: TESTER, recipient: TESTER, slippageBps: 2001 })
    ).rejects.toMatchObject({ code: 'EVM_SWAP_BUILD_FAILED' });
    expect(fetched).toBe(false);
  });
});

describe('verifyEvmSwapBuild — pagar (d), pure, against the real fixture figures', () => {
  const goodBuild = {
    calldata: BUILD_BNB2USDT.data.data,
    routerAddress: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    transactionValueRaw: 1000000000000000n,
    amountInRaw: 1000000000000000n,
    amountOutRaw: 733567528839934470n,
    gasRaw: 268831n
  };
  const expectations = {
    expectedRouterAddress: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    expectedAmountInRaw: 1000000000000000n,
    expectedValueRaw: 1000000000000000n,
    freshAmountOutRaw: 733567528839934471n, // the quote's own figure — the build's minus-1-raw echo passes the 0,1% band
    chainId: 56,
    expectedChainId: 56
  };

  it('the real fixture passes', () => {
    expect(() => verifyEvmSwapBuild({ build: goodBuild, ...expectations })).not.toThrow();
  });

  it('each mismatch throws EVM_SWAP_BUILD_MISMATCH: router, amountIn, value, amountOut drift, chain id, empty calldata', () => {
    const cases = [
      { build: { ...goodBuild, routerAddress: '0x' + '11'.repeat(20) } },
      { build: { ...goodBuild, amountInRaw: 999999999999999n } },
      { build: { ...goodBuild, transactionValueRaw: 1n } },
      { build: { ...goodBuild, amountOutRaw: 700000000000000000n } }, // -4,6% — outside the 0,1% band
      { build: goodBuild, chainId: 97 },
      { build: { ...goodBuild, calldata: '0x' } }
    ];
    for (const override of cases) {
      let thrown = null;
      try {
        verifyEvmSwapBuild({ ...expectations, ...override });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toMatchObject({ code: 'EVM_SWAP_BUILD_MISMATCH' });
    }
  });
});

describe('parseErc20ReceivedFromReceipt — the real 0213 log shape as cetakan', () => {
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const RECIPIENT = TESTER;
  const pad = (addr) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  // The REAL 0213 Revisi 3 receipt log, verbatim shape: address = the
  // USDT contract, topics[0] = Transfer, topics[2] = padded recipient,
  // data = 2.990.000.000.000.000.000 raw (0x…297e9d28866b0000).
  const realShapedLog = {
    address: USDT.toLowerCase(),
    topics: [TRANSFER_TOPIC, pad('0x8894e0a0c962cb723c1976a4421c95949be2d4e3'), pad(RECIPIENT)],
    data: '0x' + (2990000000000000000n).toString(16).padStart(64, '0')
  };

  it('reads the exact raw value from the real-shaped log', () => {
    expect(parseErc20ReceivedFromReceipt({ receipt: { logs: [realShapedLog] }, tokenAddress: USDT, recipient: RECIPIENT })).toBe('2990000000000000000');
  });

  it('sums split transfers, ignores other tokens/recipients, and returns null when nothing matches', () => {
    const otherToken = { ...realShapedLog, address: '0x' + '22'.repeat(20) };
    const otherRecipient = { ...realShapedLog, topics: [TRANSFER_TOPIC, realShapedLog.topics[1], pad('0x' + '33'.repeat(20))] };
    const half = { ...realShapedLog, data: '0x' + (1000000000000000000n).toString(16).padStart(64, '0') };
    expect(
      parseErc20ReceivedFromReceipt({ receipt: { logs: [otherToken, half, otherRecipient, half] }, tokenAddress: USDT, recipient: RECIPIENT })
    ).toBe('2000000000000000000');
    expect(parseErc20ReceivedFromReceipt({ receipt: { logs: [otherToken] }, tokenAddress: USDT, recipient: RECIPIENT })).toBeNull();
    expect(parseErc20ReceivedFromReceipt({ receipt: null, tokenAddress: USDT, recipient: RECIPIENT })).toBeNull();
  });
});

// ---- Fee Fluxio EVM (prompt 0221) ---------------------------------------

const FIXTURE_DIR_0221 = path.join(__dirname, '..', '..', '..', 'prompt', 'evidence', '0221-evm-swap-fee');
const FEE_QUOTE = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0221, 'quote-fee-bnb2usdt.json'), 'utf8'));
const FEE_BUILD = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0221, 'build-fee-bnb2usdt.json'), 'utf8'));

describe('fee Fluxio EVM (prompt 0221) — params, echo, math, constants', () => {
  it('every quote carries the four Kyber fee params in the query, and the REAL 0221 fixture parses with the fee already inside amountOut', async () => {
    const calls = mockFetchJson(FEE_QUOTE);
    const q = await getEvmSwapQuote({ networkKey: 'bnb', tokenIn: NATIVE_EVM_SENTINEL, tokenOut: USDT, amountInRaw: 500000000000000n });
    expect(calls[0].url).toContain('feeAmount=85');
    expect(calls[0].url).toContain('chargeFeeBy=currency_in');
    expect(calls[0].url).toContain('isInBps=true');
    expect(calls[0].url.toLowerCase()).toContain('feereceiver=0xe374bd0c7fa83c726bedc1f99e37737002bca310');
    expect(q.amountOutRaw).toBe(361378711868759860n); // the archived live fee quote — 0,9915x the no-fee sibling
    expect(q.routeSummary.extraFee).toEqual(FEE_QUOTE.data.routeSummary.extraFee); // UTUH, checksum rule
  });

  it('verifyEvmFeeEcho PASSES on the real echoed extraFee (lowercase receiver, string feeAmount, boolean isInBps)', () => {
    expect(() => verifyEvmFeeEcho(FEE_QUOTE.data.routeSummary.extraFee)).not.toThrow();
  });

  it('verifyEvmFeeEcho rejects every mismatch with EVM_SWAP_FEE_MISMATCH (owner keputusan 4 comparison rules)', () => {
    const good = FEE_QUOTE.data.routeSummary.extraFee;
    const cases = [
      null,
      { ...good, feeReceiver: '0x' + '11'.repeat(20) },
      { ...good, feeAmount: '86' },
      { ...good, feeAmount: 85.5 }, // String '85.5' !== '85'
      { ...good, isInBps: false },
      { ...good, chargeFeeBy: 'currency_out' },
      { ...good, feeAmount: '' } // the no-fee echo shape
    ];
    for (const extraFee of cases) {
      let thrown = null;
      try {
        verifyEvmFeeEcho(extraFee);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toMatchObject({ code: 'EVM_SWAP_FEE_MISMATCH' });
    }
  });

  it('computeEvmSwapFeeRaw: the display math is floor(amountIn x 85 / 10000) — 5e14 -> 4.25e12 wei (0.00000425 BNB), 1e15 -> 8.5e12, floor proven on an odd value', () => {
    expect(computeEvmSwapFeeRaw(500000000000000n)).toBe(4250000000000n);
    expect(computeEvmSwapFeeRaw(1000000000000000n)).toBe(8500000000000n);
    expect(computeEvmSwapFeeRaw(999n)).toBe(8n); // floor(999 x 85 / 10000) = floor(8.49)
  });

  it('EVM_SWAP_FEE_RECEIVER: checksum locked (ethers.getAddress identity), not the test wallet, and the frozen options carry it', () => {
    expect(getAddress(EVM_SWAP_FEE_RECEIVER)).toBe(EVM_SWAP_FEE_RECEIVER);
    expect(EVM_SWAP_FEE_RECEIVER.toLowerCase()).not.toBe('0x4B2c00fD7647780F1d21694Ce51feA235De7Ca39'.toLowerCase());
    expect(EVM_SWAP_FEE_OPTIONS).toEqual({ feeAmount: 85, chargeFeeBy: 'currency_in', isInBps: true, feeReceiver: EVM_SWAP_FEE_RECEIVER });
    expect(Object.isFrozen(EVM_SWAP_FEE_OPTIONS)).toBe(true);
  });

  it('the REAL 0221 fee build keeps transactionValue at the FULL amountIn (fee charged inside the router, never from value)', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => FEE_BUILD });
    const build = await buildEvmSwapTransaction({
      networkKey: 'bnb',
      routeSummary: FEE_QUOTE.data.routeSummary,
      sender: TESTER,
      recipient: TESTER,
      slippageBps: 50
    });
    expect(build.transactionValueRaw).toBe(500000000000000n); // FULL 5e14 — live-proven 0221 fase 1
    expect(build.amountInRaw).toBe(500000000000000n);
    expect(build.amountOutRaw).toBe(361378711868759859n); // quote minus 1 raw, the standing Kyber echo pattern
  });
});

describe('computeQuoteUsdDeviation — the sanity guard math (owner butir 5)', () => {
  it('a sane quote deviates well under 5%; a 10x price mismatch goes far over; missing prices return null (check skipped)', () => {
    const sane = computeQuoteUsdDeviation({
      amountInRaw: 1000000000000000n, inputDecimals: 18, inputUsdPrice: 733.8,
      amountOutRaw: 733567528839934471n, outputDecimals: 18, outputUsdPrice: 0.999222
    });
    expect(sane).not.toBeNull();
    expect(sane).toBeLessThan(0.05);
    const absurd = computeQuoteUsdDeviation({
      amountInRaw: 1000000000000000n, inputDecimals: 18, inputUsdPrice: 7338, // 10x wrong
      amountOutRaw: 733567528839934471n, outputDecimals: 18, outputUsdPrice: 0.999222
    });
    expect(absurd).toBeGreaterThan(0.05);
    expect(computeQuoteUsdDeviation({ amountInRaw: 1n, inputDecimals: 18, inputUsdPrice: undefined, amountOutRaw: 1n, outputDecimals: 18, outputUsdPrice: 1 })).toBeNull();
  });
});

// ---- Tahap C (prompt 0223): allowance/approve + native received ---------

const FIXTURE_DIR_0223 = path.join(__dirname, '..', '..', '..', 'prompt', 'evidence', '0223-evm-swap-token-in');
const FIX_QUOTE_TOKENIN = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0223, 'quote-usdt2bnb-fee.json'), 'utf8'));
const FIX_BUILD_TOKENIN = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0223, 'build-usdt2bnb-fee.json'), 'utf8'));
const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const TOKENIN_AMOUNT_RAW = 500000000000000000n; // the fixture's 0.5 USDT

function mockRpcResult(resultHex) {
  const bodies = [];
  globalThis.fetch = async (url, opts = {}) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: resultHex }) };
  };
  return bodies;
}

describe('tahap C — buildErc20ApproveCalldata (owner K1: exact amount)', () => {
  it('encodes approve(spender, amount) exactly: selector + padded spender + padded amount', () => {
    const calldata = buildErc20ApproveCalldata({ spender: KYBER_ROUTER, amountRaw: TOKENIN_AMOUNT_RAW });
    expect(calldata).toBe(
      '0x095ea7b3' +
        '0000000000000000000000006131b5fae19ea4f9d964eac0408e4408b66337b5' +
        '00000000000000000000000000000000000000000000000006f05b59d3b20000'
    );
    expect(calldata.length).toBe(2 + 8 + 64 + 64);
  });
  it('rejects a NEGATIVE/malformed amount and a malformed spender (zero is VALID since 0227 — the K8 reset leg; revisi sadar atas tes 0223)', () => {
    expect(() => buildErc20ApproveCalldata({ spender: KYBER_ROUTER, amountRaw: -1n })).toThrow(EvmSwapValidationError);
    expect(() => buildErc20ApproveCalldata({ spender: KYBER_ROUTER, amountRaw: 'abc' })).toThrow(EvmSwapValidationError);
    expect(() => buildErc20ApproveCalldata({ spender: '0x1234', amountRaw: 1n })).toThrow(EvmSwapValidationError);
  });
});

describe('tahap C — getErc20Allowance / getErc20Balance (read only)', () => {
  it('allowance: sends the 0xdd62ed3e selector with BOTH padded addresses and parses the raw value', async () => {
    const bodies = mockRpcResult('0x' + (123456789n).toString(16).padStart(64, '0'));
    const value = await getErc20Allowance({ networkKey: 'bnb', tokenAddress: USDT, owner: '0x4B2c00fD7647780F1d21694Ce51feA235De7Ca39', spender: KYBER_ROUTER });
    expect(value).toBe(123456789n);
    const call = bodies[0];
    expect(call.method).toBe('eth_call');
    expect(call.params[0].to).toBe(USDT);
    expect(call.params[0].data).toBe(
      '0xdd62ed3e' +
        '0000000000000000000000004b2c00fd7647780f1d21694ce51fea235de7ca39' +
        '0000000000000000000000006131b5fae19ea4f9d964eac0408e4408b66337b5'
    );
  });
  it('allowance/balance: an empty "0x" result reads as 0n (no contract fails closed, never throws a BigInt error)', async () => {
    mockRpcResult('0x');
    expect(await getErc20Allowance({ networkKey: 'bnb', tokenAddress: USDT, owner: KYBER_ROUTER, spender: KYBER_ROUTER })).toBe(0n);
    mockRpcResult('0x');
    expect(await getErc20Balance({ networkKey: 'bnb', tokenAddress: USDT, owner: KYBER_ROUTER })).toBe(0n);
  });
  it('balance: sends the 0x70a08231 selector with the padded owner', async () => {
    const bodies = mockRpcResult('0x' + (5n).toString(16).padStart(64, '0'));
    const value = await getErc20Balance({ networkKey: 'bnb', tokenAddress: USDT, owner: '0x4B2c00fD7647780F1d21694Ce51feA235De7Ca39' });
    expect(value).toBe(5n);
    expect(bodies[0].params[0].data).toBe('0x70a08231' + '0000000000000000000000004b2c00fd7647780f1d21694ce51fea235de7ca39');
  });
});

describe('tahap C — verifyEvmSwapBuild with value 0 against the REAL 0223 token-in build fixture', () => {
  const d = FIX_BUILD_TOKENIN.data;
  const buildShape = {
    calldata: d.data,
    routerAddress: d.routerAddress,
    transactionValueRaw: BigInt(d.transactionValue ?? 0),
    amountInRaw: BigInt(d.amountIn),
    amountOutRaw: BigInt(d.amountOut),
    gasRaw: BigInt(d.gas)
  };
  it('passes with expectedValueRaw 0n — the live token-in build genuinely carries transactionValue "0"', () => {
    expect(d.transactionValue).toBe('0');
    expect(() =>
      verifyEvmSwapBuild({
        build: buildShape,
        expectedRouterAddress: FIX_QUOTE_TOKENIN.data.routerAddress,
        expectedAmountInRaw: TOKENIN_AMOUNT_RAW,
        expectedValueRaw: 0n,
        freshAmountOutRaw: BigInt(FIX_QUOTE_TOKENIN.data.routeSummary.amountOut),
        chainId: 56,
        expectedChainId: 56
      })
    ).not.toThrow();
  });
  it('FAILS when the caller expects the native-in value (amountIn) instead of 0 — the direction mix-up can never sign', () => {
    expect(() =>
      verifyEvmSwapBuild({
        build: buildShape,
        expectedRouterAddress: FIX_QUOTE_TOKENIN.data.routerAddress,
        expectedAmountInRaw: TOKENIN_AMOUNT_RAW,
        expectedValueRaw: TOKENIN_AMOUNT_RAW,
        freshAmountOutRaw: BigInt(FIX_QUOTE_TOKENIN.data.routeSummary.amountOut),
        chainId: 56,
        expectedChainId: 56
      })
    ).toThrow(/EVM_SWAP_BUILD_MISMATCH|transaction value/);
  });
});

describe('tahap C — fee echo on the REAL 0223 token-in quote fixture (owner K6)', () => {
  it('verifyEvmFeeEcho passes unchanged: the token-in echo has the same shape as native-in (lowercase receiver, string feeAmount, currency_in)', () => {
    const extraFee = FIX_QUOTE_TOKENIN.data.routeSummary.extraFee;
    expect(extraFee.chargeFeeBy).toBe('currency_in');
    expect(extraFee.feeReceiver).toBe(EVM_SWAP_FEE_RECEIVER.toLowerCase());
    expect(() => verifyEvmFeeEcho(extraFee)).not.toThrow();
  });
  it('the display fee for 0.5 USDT pay is floor(5e17 x 85 / 10000) = 4.25e15 raw in the PAY currency', () => {
    expect(computeEvmSwapFeeRaw(TOKENIN_AMOUNT_RAW)).toBe(4250000000000000n);
  });
});

describe('tahap C — computeEvmNativeReceivedFromBalances (owner K4, pure)', () => {
  it('received = after - before + gasUsed x effectiveGasPrice (consistent example; the real receipt figures follow in the Revisi after the owner test)', () => {
    const raw = computeEvmNativeReceivedFromBalances({
      balanceBeforeWei: 1000000000000000n,
      balanceAfterWei: 1000600000000000n,
      gasUsed: 204428n,
      effectiveGasPrice: 50000000n
    });
    // delta 6e11 + 204428 x 5e7 = 600000000000 + 10221400000000
    expect(raw).toBe('10821400000000');
  });
  it('malformed inputs and a negative result both return null (the estimate keeps showing, labeled est.)', () => {
    expect(computeEvmNativeReceivedFromBalances({ balanceBeforeWei: 'x', balanceAfterWei: 1n, gasUsed: 1n, effectiveGasPrice: 1n })).toBe(null);
    expect(
      computeEvmNativeReceivedFromBalances({ balanceBeforeWei: 10n ** 18n, balanceAfterWei: 0n, gasUsed: 1n, effectiveGasPrice: 1n })
    ).toBe(null);
  });
  it('getEvmBalanceAtBlock passes the EXPLICIT block tag through (K4: never latest)', async () => {
    const bodies = mockRpcResult('0x10');
    const value = await getEvmBalanceAtBlock({ networkKey: 'bnb', address: KYBER_ROUTER, blockHex: '0x79f4d31' });
    expect(value).toBe(16n);
    expect(bodies[0].method).toBe('eth_getBalance');
    expect(bodies[0].params).toEqual([KYBER_ROUTER, '0x79f4d31']);
  });
});

describe('tahap C Revisi 1 — same-block extra gas pair (owner keputusan 1; figures from the REAL attempt-1 approve receipt, 0223 Revisi 3 butir f)', () => {
  it('adds the approve gas back when the extra pair is given, and returns null when the pair is malformed', () => {
    // The real approve (hash 0x4b20…7ddf): gasUsed 46.194, 0,05 gwei —
    // fee 2.309.700.000.000 wei, reconciled on two endpoints.
    const APPROVE_GAS_USED = 46194n;
    const after = 10000000000000000n + 692616267379369n - 204428n * 50000000n - APPROVE_GAS_USED * 50000000n;
    const base = { balanceBeforeWei: 10000000000000000n, balanceAfterWei: after, gasUsed: 204428n, effectiveGasPrice: 50000000n };
    // Without the pair: the plain formula (undercounts by the approve gas).
    expect(computeEvmNativeReceivedFromBalances(base)).toBe((692616267379369n - APPROVE_GAS_USED * 50000000n).toString());
    // With the pair: exact — delta + swap gas + approve gas.
    expect(computeEvmNativeReceivedFromBalances({ ...base, extraGasUsed: APPROVE_GAS_USED, extraEffectiveGasPrice: 50000000n })).toBe('692616267379369');
    // A provided-but-malformed pair fails SAFE to null, never a guess.
    expect(computeEvmNativeReceivedFromBalances({ ...base, extraGasUsed: 'x', extraEffectiveGasPrice: 50000000n })).toBe(null);
  });
});


// ---- 0227 (owner keputusan 0225): Ethereum + Base on the REAL 0225
// full-payload fixtures (prompt/evidence/0225-evm-swap-spike-eth-base/,
// fetched live with the product's own fee params; dilarang fixture
// karangan — PRASYARAT 0227 butir 6).

const FIXTURE_DIR_0225 = path.join(__dirname, '..', '..', '..', 'prompt', 'evidence', '0225-evm-swap-spike-eth-base');
const Q_ETH_NATIVE = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-quote-eth-native2usdc.json'), 'utf8'));
const Q_ETH_TOKENIN = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-quote-eth-usdc2native.json'), 'utf8'));
const Q_BASE_NATIVE = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-quote-base-native2usdc.json'), 'utf8'));
const Q_BASE_TOKENIN = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-quote-base-usdc2native.json'), 'utf8'));
const B_ETH_NATIVE = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-build-eth-native2usdc.json'), 'utf8'));
const B_ETH_TOKENIN = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-build-eth-usdc2native.json'), 'utf8'));
const B_BASE_NATIVE = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-build-base-native2usdc.json'), 'utf8'));
const B_BASE_TOKENIN = JSON.parse(readFileSync(path.join(FIXTURE_DIR_0225, 'kyber-build-base-usdc2native.json'), 'utf8'));
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('getEvmSwapQuote — ethereum and base slugs on the real 0225 fixtures (0225 K1)', () => {
  it('ethereum: the routes URL carries the /ethereum/ slug and the fixture parses exactly (same router as BNB)', async () => {
    const calls = mockFetchJson(Q_ETH_NATIVE);
    const q = await getEvmSwapQuote({ networkKey: 'ethereum', tokenIn: NATIVE_EVM_SENTINEL, tokenOut: USDC_ETH, amountInRaw: 2000000000000000n });
    expect(calls[0].url).toContain('/ethereum/api/v1/routes?');
    expect(q.amountOutRaw).toBe(4758261n); // exact, archived live quote
    expect(q.gasEstimate).toBe(456277n);
    expect(q.routerAddress).toBe('0x6131B5fae19EA4f9D964eAc0408E4408b66337b5');
  });
  it('base: the routes URL carries the /base/ slug and the fixture parses exactly', async () => {
    const calls = mockFetchJson(Q_BASE_NATIVE);
    const q = await getEvmSwapQuote({ networkKey: 'base', tokenIn: NATIVE_EVM_SENTINEL, tokenOut: USDC_BASE, amountInRaw: 1000000000000000n });
    expect(calls[0].url).toContain('/base/api/v1/routes?');
    expect(q.amountOutRaw).toBe(2374713n);
    expect(q.gasEstimate).toBe(330498n);
    expect(q.routerAddress).toBe('0x6131B5fae19EA4f9D964eAc0408E4408b66337b5');
  });
  it('verifyEvmFeeEcho passes on BOTH networks real extraFee echoes (85 bps currency_in to the one treasury)', () => {
    expect(() => verifyEvmFeeEcho(Q_ETH_NATIVE.data.routeSummary.extraFee)).not.toThrow();
    expect(() => verifyEvmFeeEcho(Q_ETH_TOKENIN.data.routeSummary.extraFee)).not.toThrow();
    expect(() => verifyEvmFeeEcho(Q_BASE_NATIVE.data.routeSummary.extraFee)).not.toThrow();
    expect(() => verifyEvmFeeEcho(Q_BASE_TOKENIN.data.routeSummary.extraFee)).not.toThrow();
  });
});

describe('verifyEvmSwapBuild — ethereum and base real builds (0225 K5: expectedChainId from the network)', () => {
  function buildShape(fix) {
    const d = fix.data;
    return {
      calldata: d.data,
      routerAddress: d.routerAddress,
      transactionValueRaw: BigInt(d.transactionValue ?? 0),
      amountInRaw: BigInt(d.amountIn),
      amountOutRaw: BigInt(d.amountOut),
      gasRaw: BigInt(d.gas)
    };
  }
  it('ethereum native-in: value = amountIn exactly, chainId 1 passes and 56 fails', () => {
    const build = buildShape(B_ETH_NATIVE);
    expect(build.transactionValueRaw).toBe(2000000000000000n);
    const args = {
      build,
      expectedRouterAddress: Q_ETH_NATIVE.data.routerAddress,
      expectedAmountInRaw: 2000000000000000n,
      expectedValueRaw: 2000000000000000n,
      freshAmountOutRaw: BigInt(Q_ETH_NATIVE.data.routeSummary.amountOut),
      chainId: 1,
      expectedChainId: 1
    };
    expect(() => verifyEvmSwapBuild(args)).not.toThrow();
    expect(() => verifyEvmSwapBuild({ ...args, expectedChainId: 56 })).toThrow(EvmSwapValidationError);
  });
  it('ethereum token-in: value EXACTLY 0 (the router pulls via the allowance)', () => {
    const build = buildShape(B_ETH_TOKENIN);
    expect(build.transactionValueRaw).toBe(0n);
    expect(() =>
      verifyEvmSwapBuild({
        build,
        expectedRouterAddress: Q_ETH_TOKENIN.data.routerAddress,
        expectedAmountInRaw: 500000n,
        expectedValueRaw: 0n,
        freshAmountOutRaw: BigInt(Q_ETH_TOKENIN.data.routeSummary.amountOut),
        chainId: 1,
        expectedChainId: 1
      })
    ).not.toThrow();
  });
  it('base native-in and token-in: value = amountIn / 0, chainId 8453', () => {
    const native = buildShape(B_BASE_NATIVE);
    expect(native.transactionValueRaw).toBe(1000000000000000n);
    expect(() =>
      verifyEvmSwapBuild({
        build: native,
        expectedRouterAddress: Q_BASE_NATIVE.data.routerAddress,
        expectedAmountInRaw: 1000000000000000n,
        expectedValueRaw: 1000000000000000n,
        freshAmountOutRaw: BigInt(Q_BASE_NATIVE.data.routeSummary.amountOut),
        chainId: 8453,
        expectedChainId: 8453
      })
    ).not.toThrow();
    const tokenIn = buildShape(B_BASE_TOKENIN);
    expect(tokenIn.transactionValueRaw).toBe(0n);
    expect(() =>
      verifyEvmSwapBuild({
        build: tokenIn,
        expectedRouterAddress: Q_BASE_TOKENIN.data.routerAddress,
        expectedAmountInRaw: 500000n,
        expectedValueRaw: 0n,
        freshAmountOutRaw: BigInt(Q_BASE_TOKENIN.data.routeSummary.amountOut),
        chainId: 8453,
        expectedChainId: 8453
      })
    ).not.toThrow();
  });
});

describe('0227 K4 + K8 helpers: l1Fee in the received formula, approve(0) calldata', () => {
  it('computeEvmNativeReceivedFromBalances adds l1FeeWei back (figures from the REAL 0226 Base receipt: gasUsed 21000 x 6.000.000 + l1Fee 2.195.885.060)', () => {
    // A wallet that received R while the tx itself paid gas + l1Fee:
    // after = before + R - gas - l1Fee, so received = delta + gas + l1Fee.
    const R = 689598396347272n; // a real archived received figure; the identity holds for any exact value
    const gas = 21000n * 6000000n;
    const l1Fee = 2195885060n;
    const before = 10n ** 16n;
    const after = before + R - gas - l1Fee;
    expect(
      computeEvmNativeReceivedFromBalances({ balanceBeforeWei: before, balanceAfterWei: after, gasUsed: 21000n, effectiveGasPrice: 6000000n, l1FeeWei: l1Fee })
    ).toBe(R.toString());
    // Without l1Fee the same inputs undercount — exactly why 0226's
    // balance sheet only closed once l1Fee was included.
    expect(
      computeEvmNativeReceivedFromBalances({ balanceBeforeWei: before, balanceAfterWei: after, gasUsed: 21000n, effectiveGasPrice: 6000000n })
    ).toBe((R - l1Fee).toString());
    // Malformed l1Fee fails SAFE to null.
    expect(
      computeEvmNativeReceivedFromBalances({ balanceBeforeWei: before, balanceAfterWei: after, gasUsed: 21000n, effectiveGasPrice: 6000000n, l1FeeWei: 'x' })
    ).toBe(null);
  });
  it('buildErc20ApproveCalldata accepts 0 (the K8 reset leg) and still rejects negatives', () => {
    const data = buildErc20ApproveCalldata({ spender: KYBER_ROUTER, amountRaw: 0n });
    expect(data.startsWith('0x095ea7b3')).toBe(true);
    expect(data.endsWith('0'.repeat(64))).toBe(true); // amount word = 0
    expect(() => buildErc20ApproveCalldata({ spender: KYBER_ROUTER, amountRaw: -1n })).toThrow(EvmSwapValidationError);
  });
});


// ---- 0227 Revisi 1 (owner opsi 1): pickSignedMaxFeePerGas + l1Fee oracle --

describe('pickSignedMaxFeePerGas — 0227 Revisi 1 (angka nyata fase 1)', () => {
  it('fresh below the ceiling rate: the fresh fee signs unchanged', () => {
    // Ceiling 4.362.567.000.000 wei over gasLimit 396.597 (rate 11e6);
    // fresh 10e6 with baseFee 4,5e6 + tip 1e6.
    expect(
      pickSignedMaxFeePerGas({ freshMaxFeePerGas: 10000000n, baseFeePerGas: 4500000n, maxPriorityFeePerGas: 1000000n, gasLimit: 396597n, displayedMaxFeeWei: 4362567000000n })
    ).toBe(10000000n);
  });
  it('the REAL fase 1 bounce: real estimateGas 402.727 pushes gasLimit to 483.272 past the quote-gas ceiling — the fee is CUT to floor(ceiling / gasLimit) and still clears the inclusion floor', () => {
    // Fase 1 measured: quote gas 330.498 (display gasLimit 396.597,
    // ceiling 396.597 x 11e6 = 4.362.567.000.000) but real eth_estimateGas
    // 402.727 -> fresh gasLimit 483.272. Pre-fix this bounced EVERY
    // Confirm (freshCost 5.315.992.000.000 > ceiling, identical fee).
    const picked = pickSignedMaxFeePerGas({
      freshMaxFeePerGas: 11000000n,
      baseFeePerGas: 5000000n,
      maxPriorityFeePerGas: 1000000n,
      gasLimit: 483272n,
      displayedMaxFeeWei: 4362567000000n
    });
    expect(picked).toBe(4362567000000n / 483272n); // floor = 9.027.142 wei
    expect(picked).toBe(9027146n);
    expect(picked >= 5000000n + 1000000n).toBe(true); // masih bisa masuk blok
  });
  it('ceiling rate below the fresh inclusion floor (gas truly rose): refuses with null', () => {
    // floor(ceiling / gasLimit) = 5e6 < baseFee 5e6 + tip 1e6.
    expect(
      pickSignedMaxFeePerGas({ freshMaxFeePerGas: 13000000n, baseFeePerGas: 5000000n, maxPriorityFeePerGas: 1000000n, gasLimit: 483272n, displayedMaxFeeWei: 483272n * 5000000n })
    ).toBe(null);
  });
  it('no displayed ceiling (PREVIEW never answered): the fresh fee signs; malformed input fails closed', () => {
    expect(
      pickSignedMaxFeePerGas({ freshMaxFeePerGas: 13000000n, baseFeePerGas: 6000000n, maxPriorityFeePerGas: 1000000n, gasLimit: 483272n, displayedMaxFeeWei: null })
    ).toBe(13000000n);
    expect(
      pickSignedMaxFeePerGas({ freshMaxFeePerGas: 'x', baseFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 1n, displayedMaxFeeWei: 1n })
    ).toBe(null);
  });
});

describe('estimateL1FeeWei — 0227 Revisi 1 K2 (oracle by CONSTANT, never by trial)', () => {
  const CALLDATA = '0x' + 'ab'.repeat(100);
  it('ethereum and bnb return null WITHOUT any network call', async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      throw new Error('must not be called');
    };
    expect(await estimateL1FeeWei({ networkKey: 'ethereum', calldata: CALLDATA, gasLimit: 400000n, maxFeePerGas: 11000000n, to: KYBER_ROUTER, valueRaw: 0n })).toBe(null);
    expect(await estimateL1FeeWei({ networkKey: 'bnb', calldata: CALLDATA, gasLimit: 400000n, maxFeePerGas: 11000000n, to: KYBER_ROUTER, valueRaw: 0n })).toBe(null);
    expect(fetches).toBe(0);
    expect(EVM_L1_FEE_ORACLE_BY_NETWORK).toEqual({ base: '0x420000000000000000000000000000000000000F' });
  });
  it('base: eth_call getL1Fee over the sample tx carrying the REAL calldata — parses the fase 1 figure 11.195.561.607 wei exactly; failure returns null', async () => {
    const bodies = [];
    globalThis.fetch = async (url, opts = {}) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + (11195561607n).toString(16) }) };
    };
    const l1 = await estimateL1FeeWei({ networkKey: 'base', calldata: CALLDATA, gasLimit: 483272n, maxFeePerGas: 11000000n, to: KYBER_ROUTER, valueRaw: 1000000000000000n });
    expect(l1).toBe(11195561607n);
    expect(bodies[0].method).toBe('eth_call');
    expect(bodies[0].params[0].to).toBe('0x420000000000000000000000000000000000000F');
    expect(bodies[0].params[0].data.startsWith('0x49948e0e')).toBe(true);
    // The real calldata bytes ride inside the sample tx the oracle prices.
    expect(bodies[0].params[0].data.includes('ab'.repeat(100))).toBe(true);
    globalThis.fetch = async () => {
      throw new Error('down');
    };
    expect(await estimateL1FeeWei({ networkKey: 'base', calldata: CALLDATA, gasLimit: 483272n, maxFeePerGas: 11000000n, to: KYBER_ROUTER, valueRaw: 0n })).toBe(null);
  });
  it('getEvmFeePerGas now carries baseFeePerGas (the inclusion floor input)', async () => {
    globalThis.fetch = async (url, opts = {}) => {
      const body = JSON.parse(opts.body);
      const result = body.method === 'eth_getBlockByNumber' ? { baseFeePerGas: '0x4c4b40' } : '0xf4240'; // 5e6 / 1e6
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    };
    const fees = await getEvmFeePerGas({ networkKey: 'base' });
    expect(fees.baseFeePerGas).toBe(5000000n);
    expect(fees.maxFeePerGas).toBe(11000000n);
    expect(fees.maxPriorityFeePerGas).toBe(1000000n);
  });
});

describe('EVM tip floor (prompt 0231) — fixtures from the 22 Oktober measurement, not invented', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  const mockFees = (baseFeeHex, tipHex) => {
    globalThis.fetch = async (url, opts = {}) => {
      const body = JSON.parse(opts.body);
      const result = body.method === 'eth_getBlockByNumber' ? { baseFeePerGas: baseFeeHex } : tipHex;
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    };
  };

  it('floor APPLIED: the real Ethereum endpoint answer (tip 3.839 wei, baseFee 209.596.439) gets the 1e8 floor', async () => {
    mockFees('0xc7e3017', '0xeff'); // 209.596.439 / 3.839 — measured 22 Oktober
    const fees = await getEvmFeePerGas({ networkKey: 'ethereum' });
    expect(fees.maxPriorityFeePerGas).toBe(100000000n);
    expect(fees.maxFeePerGas).toBe(209596439n * 2n + 100000000n); // 519.192.878
    expect(fees.baseFeePerGas).toBe(209596439n);
    expect(fees.tipFloorApplied).toBe(true);
  });

  it('floor NOT applied when the endpoint tip is above it: BNB p90 1e8 > floor 5e7 stays untouched', async () => {
    mockFees('0x0', '0x5f5e100'); // baseFee 0 (every BNB block), tip 1e8 — measured p90
    const fees = await getEvmFeePerGas({ networkKey: 'bnb' });
    expect(fees.maxPriorityFeePerGas).toBe(100000000n);
    expect(fees.maxFeePerGas).toBe(100000000n);
    expect(fees.tipFloorApplied).toBe(false);
  });

  it('floor NOT applied at equality: the real Base answer (tip 1e6 = floor) is byte identical to before', async () => {
    mockFees('0x4c4b40', '0xf4240'); // 5e6 / 1e6 — the measured stable Base answer
    const fees = await getEvmFeePerGas({ networkKey: 'base' });
    expect(fees.maxPriorityFeePerGas).toBe(1000000n);
    expect(fees.maxFeePerGas).toBe(11000000n);
    expect(fees.tipFloorApplied).toBe(false);
  });

  it('lock: every EVM swap network has EXACTLY the owner approved floor', () => {
    const approved = { ethereum: 100000000n, base: 1000000n, bnb: 50000000n };
    for (const key of EVM_SWAP_NETWORK_KEYS) {
      expect(getEvmTipFloorWei(key)).toBe(approved[key]);
    }
  });

  it('the downstream cap still wins: a Base baseFee spike puts baseFee x2 + floor ABOVE the 0.5 gwei cap, and the cap comparison catches it unchanged', async () => {
    mockFees('0x11e1a300', '0x0'); // baseFee 3e8, endpoint tip 0 -> floor 1e6
    const fees = await getEvmFeePerGas({ networkKey: 'base' });
    expect(fees.maxPriorityFeePerGas).toBe(1000000n);
    expect(fees.maxFeePerGas).toBe(601000000n);
    expect(fees.maxFeePerGas > getEvmSwapCaps('base').maxFeePerGasCap).toBe(true); // the guard input that halts
  });
});
