/**
 * Real integration test against the actual live CoinGecko API — the
 * pricing sibling of swapService.real-quote.test.js, same reasoning: a
 * public internet service always "up" from its own side, this machine's
 * own internet access is what's actually in question, so this is opt-in
 * via an explicit env var rather than an auto-skipping health probe.
 *
 *   FLUXIO_REAL_PRICE_TEST=1 pnpm --filter @fluxio/services test -- priceService.real-price.test.js
 *
 * Skips itself (not a failure) when that var is unset — `pnpm test` stays
 * green with zero internet access required. When it does run, it fetches
 * one real batched price request from CoinGecko's live API — genuine
 * evidence the endpoint documented in priceService.js's own header
 * comment is still correct today, not just plausible.
 */
import { describe, it, expect } from 'vitest';
import { getPrices } from '../priceService.js';

const realPriceTestEnabled = process.env.FLUXIO_REAL_PRICE_TEST === '1';

describe.skipIf(!realPriceTestEnabled)('priceService — real CoinGecko API', () => {
  it(
    'fetches real prices for every native coin + USDC in every supported currency and confirms the response shape this file assumes is still correct',
    async () => {
      const coinIds = ['solana', 'ethereum', 'binancecoin', 'usd-coin'];
      const vsCurrencies = ['usd', 'eur', 'gbp', 'jpy', 'idr', 'sgd', 'myr', 'aud', 'cad', 'cny', 'krw', 'inr'];

      const prices = await getPrices({ coinIds, vsCurrencies });

      for (const coinId of coinIds) {
        expect(prices[coinId]).toBeTruthy();
        for (const currency of vsCurrencies) {
          expect(typeof prices[coinId][currency]).toBe('number');
          expect(prices[coinId][currency]).toBeGreaterThan(0);
        }
      }

      // USDC should be very close to 1.00 in USD — a real sanity check on
      // the response actually being what it claims to be, not just
      // shaped correctly.
      expect(prices['usd-coin'].usd).toBeGreaterThan(0.9);
      expect(prices['usd-coin'].usd).toBeLessThan(1.1);
    },
    15000
  );
});
