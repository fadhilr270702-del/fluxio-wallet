import { describe, it, expect } from 'vitest';
import {
  ALL_SUPPORTED_CURRENCY_CODES,
  SUPPORTED_CURRENCIES,
  DEFAULT_CURRENCY,
  PRICE_CACHE_MAX_AGE_MS,
  isSupportedCurrency,
  formatCurrencyAmount,
  isPriceStale
} from '../shared/portfolioDisplay.js';

describe('ALL_SUPPORTED_CURRENCY_CODES / SUPPORTED_CURRENCIES', () => {
  it('lists exactly the 12 required currency codes', () => {
    expect([...ALL_SUPPORTED_CURRENCY_CODES].sort()).toEqual(
      ['aud', 'cad', 'cny', 'eur', 'gbp', 'idr', 'inr', 'jpy', 'krw', 'myr', 'sgd', 'usd'].sort()
    );
    expect(SUPPORTED_CURRENCIES).toHaveLength(12);
  });
});

describe('isSupportedCurrency', () => {
  it('accepts every one of the 12 supported codes, case-insensitively', () => {
    expect(isSupportedCurrency('usd')).toBe(true);
    expect(isSupportedCurrency('USD')).toBe(true);
    expect(isSupportedCurrency('idr')).toBe(true);
  });

  it('rejects an unsupported or corrupt value', () => {
    expect(isSupportedCurrency('xyz')).toBe(false);
    expect(isSupportedCurrency('')).toBe(false);
    expect(isSupportedCurrency(undefined)).toBe(false);
    expect(isSupportedCurrency(123)).toBe(false);
  });
});

describe('formatCurrencyAmount', () => {
  it('formats USD with 2 decimals and a $ symbol', () => {
    expect(formatCurrencyAmount(1234.5, 'usd')).toBe('$1,234.50');
  });

  it('formats JPY with 0 decimals (ISO 4217 minor unit is genuinely 0)', () => {
    const formatted = formatCurrencyAmount(1234.9, 'jpy');
    expect(formatted).not.toContain('.');
  });

  it('formats KRW with 0 decimals', () => {
    const formatted = formatCurrencyAmount(1234.9, 'krw');
    expect(formatted).not.toContain('.');
  });

  it('formats IDR with 0 decimals — the live-verified exception where Intl\'s own ISO-4217 default (2 decimals) did NOT match the "lazim tanpa desimal" requirement, so an explicit override was needed', () => {
    const formatted = formatCurrencyAmount(1234567.9, 'idr');
    expect(formatted).not.toMatch(/[.,]\d{2}$/); // no trailing 2-decimal group
    expect(formatted).toContain('Rp');
  });

  it('falls back to the default currency for an unsupported/corrupt currency code rather than throwing', () => {
    expect(() => formatCurrencyAmount(100, 'not-a-currency')).not.toThrow();
    expect(formatCurrencyAmount(100, 'not-a-currency')).toBe(formatCurrencyAmount(100, DEFAULT_CURRENCY));
  });

  it('treats a non-finite amount as 0 rather than producing "NaN" in the output', () => {
    expect(formatCurrencyAmount(NaN, 'usd')).toBe('$0.00');
    expect(formatCurrencyAmount(Infinity, 'usd')).toBe('$0.00');
  });
});

describe('isPriceStale', () => {
  const NOW = 1_800_000_000_000;

  it('is NOT stale just under the max age', () => {
    expect(isPriceStale({ fetchedAt: NOW - PRICE_CACHE_MAX_AGE_MS + 1, now: NOW })).toBe(false);
  });

  it('IS stale exactly at the max age (inclusive boundary)', () => {
    expect(isPriceStale({ fetchedAt: NOW - PRICE_CACHE_MAX_AGE_MS, now: NOW })).toBe(true);
  });

  it('IS stale well past the max age', () => {
    expect(isPriceStale({ fetchedAt: NOW - 10 * PRICE_CACHE_MAX_AGE_MS, now: NOW })).toBe(true);
  });

  it('fails toward stale on a missing/corrupt fetchedAt or now', () => {
    expect(isPriceStale({ fetchedAt: undefined, now: NOW })).toBe(true);
    expect(isPriceStale({ fetchedAt: NaN, now: NOW })).toBe(true);
    expect(isPriceStale({ fetchedAt: NOW, now: undefined })).toBe(true);
  });

  it('honors a custom maxAgeMs override', () => {
    expect(isPriceStale({ fetchedAt: NOW - 5000, now: NOW, maxAgeMs: 10_000 })).toBe(false);
    expect(isPriceStale({ fetchedAt: NOW - 15_000, now: NOW, maxAgeMs: 10_000 })).toBe(true);
  });
});
