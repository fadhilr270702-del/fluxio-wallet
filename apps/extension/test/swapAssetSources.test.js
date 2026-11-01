import { describe, it, expect } from 'vitest';
import { resolveSwapAssetSources } from '../shared/swapAssetSources.js';

function fulfilled(value) {
  return { status: 'fulfilled', value };
}
function rejected(reason) {
  return { status: 'rejected', reason };
}

const NATIVE_OK = fulfilled({ formatted: '1.500000000', symbol: 'SOL' });
const VERIFIED_OK = fulfilled({ tokens: [{ address: 'USDCmint', symbol: 'USDC', decimals: 6 }] });
const TOKENS_OK = fulfilled({ tokens: [{ address: 'someMint', symbol: 'FOO', decimals: 6, amountFormatted: '10.000000' }] });

describe('resolveSwapAssetSources — prompt 0116 resilience fix', () => {
  it('is not fatal and not degraded when all three fetches succeed', () => {
    const result = resolveSwapAssetSources({ nativeSettled: NATIVE_OK, tokenSettled: TOKENS_OK, verifiedSettled: VERIFIED_OK });
    expect(result.fatal).toBe(false);
    expect(result.tokenBalancesDegraded).toBe(false);
    expect(result.tokenBalancesError).toBeNull();
    expect(result.nativeBalance).toBe('1.500000000');
    expect(result.nativeSymbol).toBe('SOL');
    expect(result.tokens).toEqual(TOKENS_OK.value.tokens);
    expect(result.verifiedTokens).toEqual(VERIFIED_OK.value.tokens);
  });

  // The actual bug fixed here: a getTokenAccountsByOwner failure (real,
  // confirmed live against solana-rpc.publicnode.com — see prompt 0116's
  // own report) must degrade gracefully, not take the whole screen down.
  it('degrades gracefully (does not go fatal) when only token balances fail — the real bug this fixes', () => {
    const tokenError = new Error('Could not reach Solana: Request blocked');
    const result = resolveSwapAssetSources({ nativeSettled: NATIVE_OK, tokenSettled: rejected(tokenError), verifiedSettled: VERIFIED_OK });
    expect(result.fatal).toBe(false);
    expect(result.tokenBalancesDegraded).toBe(true);
    expect(result.tokenBalancesError).toBe('Could not reach Solana: Request blocked');
    expect(result.tokens).toEqual([]); // SOL-only "You pay" — no held tokens listed
    expect(result.nativeBalance).toBe('1.500000000'); // native SOL still fully available
    expect(result.verifiedTokens).toEqual(VERIFIED_OK.value.tokens); // "You receive" still fully available
  });

  it('falls back to a generic message when the token-balance rejection reason has no .message', () => {
    const result = resolveSwapAssetSources({ nativeSettled: NATIVE_OK, tokenSettled: rejected('a plain string reason'), verifiedSettled: VERIFIED_OK });
    expect(result.tokenBalancesDegraded).toBe(true);
    expect(result.tokenBalancesError).toBe('Token balances unavailable.');
  });

  it('is fatal when the native balance fetch fails, even if the other two succeed', () => {
    const nativeError = new Error('Wallet is locked.');
    const result = resolveSwapAssetSources({ nativeSettled: rejected(nativeError), tokenSettled: TOKENS_OK, verifiedSettled: VERIFIED_OK });
    expect(result.fatal).toBe(true);
    expect(result.error).toBe(nativeError);
  });

  it('is fatal when the verified token list fetch fails, even if the other two succeed', () => {
    const verifiedError = new Error('Could not reach Jupiter: timeout');
    const result = resolveSwapAssetSources({ nativeSettled: NATIVE_OK, tokenSettled: TOKENS_OK, verifiedSettled: rejected(verifiedError) });
    expect(result.fatal).toBe(true);
    expect(result.error).toBe(verifiedError);
  });

  it('is fatal when BOTH native and verified fail — reports the native error first', () => {
    const nativeError = new Error('native failed');
    const verifiedError = new Error('verified failed');
    const result = resolveSwapAssetSources({ nativeSettled: rejected(nativeError), tokenSettled: TOKENS_OK, verifiedSettled: rejected(verifiedError) });
    expect(result.fatal).toBe(true);
    expect(result.error).toBe(nativeError);
  });

  it('is fatal when native fails even if token balances ALSO fail (native takes priority, not masked by the token-balance degradation path)', () => {
    const nativeError = new Error('native failed');
    const result = resolveSwapAssetSources({ nativeSettled: rejected(nativeError), tokenSettled: rejected(new Error('token failed too')), verifiedSettled: VERIFIED_OK });
    expect(result.fatal).toBe(true);
    expect(result.error).toBe(nativeError);
  });
});
