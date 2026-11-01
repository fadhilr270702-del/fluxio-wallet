import { describe, it, expect } from 'vitest';
import { MAINNET_NETWORK_KEYS, ALL_PRICED_COIN_IDS, resolveNativeCoinId, resolveTokenCoinId, computePortfolioTotal } from '../shared/portfolioValue.js';
import { DEFAULT_CURRENCY } from '../shared/portfolioDisplay.js';

const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_ETHEREUM = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_ETHEREUM_LOWER = USDC_ETHEREUM.toLowerCase();

function fulfilled(value) {
  return { status: 'fulfilled', value };
}
function rejected(reason) {
  return { status: 'rejected', reason: reason instanceof Error ? reason : new Error(reason) };
}

describe('MAINNET_NETWORK_KEYS', () => {
  it('contains exactly the 4 mainnet networks and no testnet/local ones', () => {
    expect([...MAINNET_NETWORK_KEYS].sort()).toEqual(['base', 'bnb', 'ethereum', 'solana']);
  });
});

describe('resolveNativeCoinId', () => {
  it('maps each mainnet network to its CoinGecko coin id', () => {
    expect(resolveNativeCoinId('solana')).toBe('solana');
    expect(resolveNativeCoinId('ethereum')).toBe('ethereum');
    expect(resolveNativeCoinId('bnb')).toBe('binancecoin');
  });

  it('maps Base to the SAME id as Ethereum (Base\'s native coin genuinely is ether)', () => {
    expect(resolveNativeCoinId('base')).toBe('ethereum');
  });

  it('returns null for an unrecognized/testnet network', () => {
    expect(resolveNativeCoinId('solana-devnet')).toBeNull();
    expect(resolveNativeCoinId('not-a-real-network')).toBeNull();
  });
});

describe('resolveTokenCoinId', () => {
  it('resolves the registry USDC address on Solana to usd-coin', () => {
    expect(resolveTokenCoinId({ networkKey: 'solana', address: USDC_SOLANA })).toBe('usd-coin');
  });

  it('resolves the registry USDC address on Ethereum to usd-coin, case-insensitively (EVM)', () => {
    expect(resolveTokenCoinId({ networkKey: 'ethereum', address: USDC_ETHEREUM })).toBe('usd-coin');
    expect(resolveTokenCoinId({ networkKey: 'ethereum', address: USDC_ETHEREUM_LOWER })).toBe('usd-coin');
  });

  it('returns null for a DIFFERENT (case-sensitive) Solana address even if it differs by case only — Solana addresses are case-SENSITIVE', () => {
    expect(resolveTokenCoinId({ networkKey: 'solana', address: USDC_SOLANA.toLowerCase() })).toBeNull();
  });

  it('returns null for an unrecognized token address', () => {
    expect(resolveTokenCoinId({ networkKey: 'ethereum', address: '0x0000000000000000000000000000000000dEaD' })).toBeNull();
  });

  it('returns null for an unrecognized BNB Chain address (the registry there holds only USDT as of prompt 0214 — anything else stays unpriced)', () => {
    expect(resolveTokenCoinId({ networkKey: 'bnb', address: '0x0000000000000000000000000000000000dEaD' })).toBeNull();
  });

  it('returns null when address is missing/empty', () => {
    expect(resolveTokenCoinId({ networkKey: 'ethereum', address: '' })).toBeNull();
    expect(resolveTokenCoinId({ networkKey: 'ethereum', address: undefined })).toBeNull();
  });
});

describe('ALL_PRICED_COIN_IDS', () => {
  it('lists every distinct coin id this feature could need, deduped (ethereum appears once despite Base reusing it; tether joined in prompt 0212 opsi B; the BNB Chain USDT bridged id joined in prompt 0214 — still ONE batched call, the extra id only lengthens the same URL)', () => {
    expect([...ALL_PRICED_COIN_IDS].sort()).toEqual([
      'binance-bridged-usdt-bnb-smart-chain',
      'binancecoin',
      'ethereum',
      'solana',
      'tether',
      'usd-coin'
    ]);
  });
});

describe('resolveTokenCoinId — BNB Chain USDT (prompt 0214, address-keyed override: CoinGecko lists this contract under its own id, NOT under tether — live-verified 7 Oktober 2026)', () => {
  const USDT_BNB = '0x55d398326f99059fF775485246999027B3197955';

  it("maps the registry's BNB Chain USDT contract to the bridged id, never to 'tether'", () => {
    expect(resolveTokenCoinId({ networkKey: 'bnb', address: USDT_BNB })).toBe('binance-bridged-usdt-bnb-smart-chain');
  });

  it('normalizes EVM case: a mixed-case spelling of the same contract resolves to the same id', () => {
    expect(resolveTokenCoinId({ networkKey: 'bnb', address: USDT_BNB.toUpperCase().replace('0X', '0x') })).toBe('binance-bridged-usdt-bnb-smart-chain');
    expect(resolveTokenCoinId({ networkKey: 'bnb', address: USDT_BNB.toLowerCase() })).toBe('binance-bridged-usdt-bnb-smart-chain');
  });

  it("the Solana USDT mint keeps resolving to 'tether' — the override is per network per address, not a symbol-wide rewrite", () => {
    expect(resolveTokenCoinId({ networkKey: 'solana', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' })).toBe('tether');
  });

  it('any other BNB Chain address still resolves to null', () => {
    expect(resolveTokenCoinId({ networkKey: 'bnb', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' })).toBeNull();
  });
});

describe('computePortfolioTotal', () => {
  const PRICES = {
    solana: { usd: 100, idr: 1_600_000 },
    ethereum: { usd: 2000, idr: 32_000_000 },
    binancecoin: { usd: 600, idr: 9_600_000 },
    'usd-coin': { usd: 1, idr: 16_000 }
  };

  it('sums native + token balances across multiple mainnet networks, in USD', () => {
    const perNetwork = {
      solana: {
        nativeSettled: fulfilled({ formatted: '2.5', symbol: 'SOL' }), // 2.5 * 100 = 250
        tokenSettled: fulfilled({ tokens: [{ symbol: 'USDC', address: USDC_SOLANA, amountFormatted: '10' }] }) // 10 * 1 = 10
      },
      ethereum: {
        nativeSettled: fulfilled({ formatted: '1', symbol: 'ETH' }), // 1 * 2000 = 2000
        tokenSettled: fulfilled({ tokens: [] })
      }
    };

    const result = computePortfolioTotal({ perNetwork, pricesByCoinId: PRICES, currency: 'usd' });
    expect(result.total).toBeCloseTo(2260);
    expect(result.totalFormatted).toBe('$2,260.00');
    expect(result.currency).toBe('usd');
    expect(result.hasExcludedAssets).toBe(false);
    expect(result.excludedAssets).toEqual([]);
  });

  it('recomputes the SAME balances in a different currency using the same cached multi-currency price map (no new price fetch implied)', () => {
    const perNetwork = {
      solana: { nativeSettled: fulfilled({ formatted: '2.5', symbol: 'SOL' }), tokenSettled: fulfilled({ tokens: [] }) }
    };
    const result = computePortfolioTotal({ perNetwork, pricesByCoinId: PRICES, currency: 'idr' });
    expect(result.total).toBeCloseTo(4_000_000);
    expect(result.currency).toBe('idr');
    expect(result.totalFormatted).not.toMatch(/[.,]\d{2}$/); // IDR, no decimals
  });

  it('mainnet-only: a testnet network entry in the input is silently skipped, never counted, never reported as excluded', () => {
    const perNetwork = {
      'solana-devnet': { nativeSettled: fulfilled({ formatted: '1000', symbol: 'SOL' }), tokenSettled: fulfilled({ tokens: [] }) },
      solana: { nativeSettled: fulfilled({ formatted: '1', symbol: 'SOL' }), tokenSettled: fulfilled({ tokens: [] }) }
    };
    const result = computePortfolioTotal({ perNetwork, pricesByCoinId: PRICES, currency: 'usd' });
    expect(result.total).toBeCloseTo(100); // only the mainnet 1 SOL counts, not devnet's 1000
    expect(result.hasExcludedAssets).toBe(false); // testnet exclusion is never surfaced
  });

  it('excludes an asset with no known price (a foreign/custom token), honestly reported', () => {
    const perNetwork = {
      ethereum: {
        nativeSettled: fulfilled({ formatted: '0', symbol: 'ETH' }),
        tokenSettled: fulfilled({ tokens: [{ symbol: 'FOO', address: '0x000000000000000000000000000000000000f0', amountFormatted: '500' }] })
      }
    };
    const result = computePortfolioTotal({ perNetwork, pricesByCoinId: PRICES, currency: 'usd' });
    expect(result.total).toBe(0);
    expect(result.hasExcludedAssets).toBe(true);
    expect(result.excludedAssets).toEqual([{ networkKey: 'ethereum', kind: 'token', symbol: 'FOO', reason: 'no-price' }]);
  });

  it('excludes a native balance whose fetch REJECTED, distinctly from a no-price exclusion', () => {
    const perNetwork = {
      solana: { nativeSettled: rejected('RPC down'), tokenSettled: fulfilled({ tokens: [] }) }
    };
    const result = computePortfolioTotal({ perNetwork, pricesByCoinId: PRICES, currency: 'usd' });
    expect(result.total).toBe(0);
    expect(result.excludedAssets).toEqual([{ networkKey: 'solana', kind: 'native', symbol: null, reason: 'fetch-failed' }]);
  });

  it('excludes an entire network\'s tokens as one entry when the token fetch REJECTED (e.g. the real Solana mainnet getTokenAccountsByOwner gap) — not a crash, not silently dropped', () => {
    const perNetwork = {
      solana: { nativeSettled: fulfilled({ formatted: '1', symbol: 'SOL' }), tokenSettled: rejected('getTokenAccountsByOwner blocked') }
    };
    const result = computePortfolioTotal({ perNetwork, pricesByCoinId: PRICES, currency: 'usd' });
    expect(result.total).toBeCloseTo(100); // native SOL still counts
    expect(result.excludedAssets).toEqual([{ networkKey: 'solana', kind: 'token-batch', symbol: null, reason: 'fetch-failed' }]);
  });

  it('treats a malformed amountFormatted (not parseable as a number) as excluded, not a crash', () => {
    const perNetwork = {
      solana: { nativeSettled: fulfilled({ formatted: 'not-a-number', symbol: 'SOL' }), tokenSettled: fulfilled({ tokens: [] }) }
    };
    const result = computePortfolioTotal({ perNetwork, pricesByCoinId: PRICES, currency: 'usd' });
    expect(result.total).toBe(0);
    expect(result.excludedAssets).toEqual([{ networkKey: 'solana', kind: 'native', symbol: 'SOL', reason: 'malformed' }]);
  });

  it('a corrupt/incomplete price map (missing an entry entirely) degrades to a no-price exclusion, not a crash', () => {
    const perNetwork = {
      bnb: { nativeSettled: fulfilled({ formatted: '1', symbol: 'BNB' }), tokenSettled: fulfilled({ tokens: [] }) }
    };
    const result = computePortfolioTotal({ perNetwork, pricesByCoinId: {}, currency: 'usd' }); // no prices at all
    expect(result.total).toBe(0);
    expect(result.excludedAssets).toEqual([{ networkKey: 'bnb', kind: 'native', symbol: 'BNB', reason: 'no-price' }]);
  });

  it('falls back to the default currency when given an unsupported one, rather than crashing or silently mispricing', () => {
    const perNetwork = {
      solana: { nativeSettled: fulfilled({ formatted: '1', symbol: 'SOL' }), tokenSettled: fulfilled({ tokens: [] }) }
    };
    const result = computePortfolioTotal({ perNetwork, pricesByCoinId: PRICES, currency: 'not-a-real-currency' });
    expect(result.currency).toBe(DEFAULT_CURRENCY);
    expect(result.total).toBeCloseTo(100);
  });

  it('returns a zero total with no exclusions for empty input', () => {
    const result = computePortfolioTotal({ perNetwork: {}, pricesByCoinId: {}, currency: 'usd' });
    expect(result.total).toBe(0);
    expect(result.totalFormatted).toBe('$0.00');
    expect(result.hasExcludedAssets).toBe(false);
  });
});

// ---- Prompt 0212 — the silent-drop bug's permanent locks ----

describe('resolveTokenCoinId — USDT (prompt 0212 opsi B, id "tether" live-verified against GET /coins/tether: platforms.solana = the registry mint exactly)', () => {
  const USDT_SOLANA = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

  it("maps the registry's Solana USDT mint to 'tether', by ADDRESS", () => {
    expect(resolveTokenCoinId({ networkKey: 'solana', address: USDT_SOLANA })).toBe('tether');
  });

  it('Solana stays case-sensitive for USDT too (a case-mangled mint is a DIFFERENT address)', () => {
    expect(resolveTokenCoinId({ networkKey: 'solana', address: USDT_SOLANA.toLowerCase() })).toBeNull();
  });
});

describe('computePortfolioTotal — a BARE-ARRAY tokenSettled.value is rejected LOUDLY, never read as "no tokens" (prompt 0212: the real bug read exactly this shape as [] and held USDC silently vanished with no badge)', () => {
  const fulfilled = (value) => ({ status: 'fulfilled', value });
  const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  it("the REAL tokenService.getTokenBalances return shape (plain array) -> 'malformed' batch exclusion + hasExcludedAssets true, NOT a silent zero", () => {
    const perNetwork = {
      solana: {
        nativeSettled: fulfilled({ formatted: '1', symbol: 'SOL' }),
        // EXACTLY what tokenService.getTokenBalances returns (its own
        // JSDoc: Promise<Array<...>>) — the caller must wrap it; if a
        // future caller forgets again, this must be VISIBLE.
        tokenSettled: fulfilled([{ symbol: 'USDC', address: USDC_SOLANA, amountFormatted: '10' }])
      }
    };
    const result = computePortfolioTotal({
      perNetwork,
      pricesByCoinId: { solana: { usd: 100 }, 'usd-coin': { usd: 1 } },
      currency: 'usd'
    });
    expect(result.total).toBeCloseTo(100); // the native leg still counts...
    expect(result.hasExcludedAssets).toBe(true); // ...but the malformed batch is NEVER silent
    expect(result.excludedAssets).toEqual([{ networkKey: 'solana', kind: 'token-batch', symbol: null, reason: 'malformed' }]);
  });
});
