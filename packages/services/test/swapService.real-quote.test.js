/**
 * Real integration test against the actual live Jupiter API — the swap
 * sibling of transactionService.local-integration.test.js/
 * evmTransactionService.local-integration.test.js, except this one can't
 * auto-detect "is the dependency up?" the way those do (a quick getHealth/
 * eth_blockNumber probe against a local node): Jupiter is a public
 * internet service, always "up" from Jupiter's side, but this machine's
 * own internet access is what's actually in question here, and there's
 * no cheap always-safe way to probe that without just... making the real
 * request this test already wants to make.
 *
 * So unlike the local-integration tests (auto-skip via a live health
 * check), this one is opt-in via an explicit env var:
 *
 *   FLUXIO_REAL_QUOTE_TEST=1 pnpm --filter @fluxio/services test -- swapService.real-quote.test.js
 *
 * Skips itself (not a failure) when that var is unset — `pnpm test` stays
 * green with zero internet access required. When it does run, it fetches
 * one real quote (0.01 SOL -> USDC) from Jupiter's live lite-api.jup.ag
 * quote endpoint and one real page of the verified token list — genuine
 * evidence the endpoint paths documented in swapService.js's own header
 * comment are still correct today, not just plausible.
 */
import { describe, it, expect } from 'vitest';
import { getSwapQuote, getVerifiedTokens, NATIVE_SOL_MINT } from '../swapService.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const realQuoteTestEnabled = process.env.FLUXIO_REAL_QUOTE_TEST === '1';

describe.skipIf(!realQuoteTestEnabled)('swapService — real Jupiter API', () => {
  it(
    'fetches a real SOL -> USDC quote and confirms the endpoint/response shape this file assumes is still correct',
    async () => {
      const result = await getSwapQuote({
        inputMint: NATIVE_SOL_MINT,
        outputMint: USDC_MINT,
        amountRaw: 10_000_000n, // 0.01 SOL
        slippageBps: 50
      });

      expect(result.inAmountRaw).toBe(10_000_000n);
      expect(result.outAmountRaw).toBeGreaterThan(0n);
      expect(result.minReceivedRaw).toBeGreaterThan(0n);
      expect(result.minReceivedRaw).toBeLessThanOrEqual(result.outAmountRaw);
      expect(typeof result.priceImpactPct).toBe('number');
      expect(result.feeIncluded).toBe(false); // no feeBps/feeAccount passed here — getSwapQuote only ever requests a fee when BOTH are explicit (the map's own state is irrelevant to this direct call)
    },
    15000
  );

  it(
    'fetches the real verified token list and confirms USDC is in it',
    async () => {
      const tokens = await getVerifiedTokens();
      expect(tokens.length).toBeGreaterThan(0);
      const usdc = tokens.find((t) => t.address === USDC_MINT);
      expect(usdc).toBeTruthy();
      expect(usdc.decimals).toBe(6);
    },
    15000
  );
});
