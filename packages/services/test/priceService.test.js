import { describe, it, expect, afterEach, vi } from 'vitest';
import { getPrices } from '../priceService.js';

/** Installs a fetch mock keyed by exact URL string — mirrors swapService.test.js's own mockFetch (same fetch-mock convention this package already uses), simplified since priceService.js only ever makes GET requests. */
function mockFetch(responsesByUrl) {
  globalThis.fetch = vi.fn(async (url) => {
    const entry = responsesByUrl[url];
    if (!entry) throw new Error(`Unexpected fetch: ${url}`);
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

describe('getPrices', () => {
  it('fetches a batched simple/price request and returns the response unmodified', async () => {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=solana%2Cethereum&vs_currencies=usd%2Cidr';
    const body = { solana: { usd: 78.33, idr: 1394754 }, ethereum: { usd: 1934.78, idr: 34450870 } };
    mockFetch({ [url]: { body } });

    const result = await getPrices({ coinIds: ['solana', 'ethereum'], vsCurrencies: ['usd', 'idr'] });
    expect(result).toEqual(body);
  });

  it('dedupes repeated coin ids / currencies before building the request', async () => {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
    mockFetch({ [url]: { body: { solana: { usd: 78.33 } } } });

    const result = await getPrices({ coinIds: ['solana', 'solana'], vsCurrencies: ['usd', 'usd'] });
    expect(result).toEqual({ solana: { usd: 78.33 } });
  });

  it('returns an empty object without making a network call when coinIds is empty', async () => {
    globalThis.fetch = vi.fn();
    const result = await getPrices({ coinIds: [], vsCurrencies: ['usd'] });
    expect(result).toEqual({});
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns an empty object without making a network call when vsCurrencies is empty', async () => {
    globalThis.fetch = vi.fn();
    const result = await getPrices({ coinIds: ['solana'], vsCurrencies: [] });
    expect(result).toEqual({});
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns an empty object when called with no arguments at all', async () => {
    globalThis.fetch = vi.fn();
    const result = await getPrices();
    expect(result).toEqual({});
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('surfaces CoinGecko\'s own error shape on a non-200 response (e.g. the real, live-verified token_price 1-contract-per-request limit)', async () => {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
    mockFetch({
      [url]: {
        status: 400,
        body: { error_code: 10012, status: { error_message: 'Number of contract addresses in the request exceeds the allowed limit of 1 contract address.' } }
      }
    });

    await expect(getPrices({ coinIds: ['solana'], vsCurrencies: ['usd'] })).rejects.toThrow(/exceeds the allowed limit/);
  });

  it('surfaces a transport/API-down failure distinctly ("Could not reach CoinGecko")', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network unreachable');
    });

    await expect(getPrices({ coinIds: ['solana'], vsCurrencies: ['usd'] })).rejects.toThrow(/Could not reach CoinGecko/);
  });

  it('throws a clear error on a non-JSON response instead of an unhandled parse exception', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      }
    }));

    await expect(getPrices({ coinIds: ['solana'], vsCurrencies: ['usd'] })).rejects.toThrow(/non-JSON response/);
  });

  it('throws on an unexpected (non-object) response shape', async () => {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
    mockFetch({ [url]: { body: 'not an object' } });

    await expect(getPrices({ coinIds: ['solana'], vsCurrencies: ['usd'] })).rejects.toThrow(/unexpected response shape/);
  });

  it('an unknown/unrecognized coin id simply comes back absent from the response (CoinGecko\'s own real behavior — no error), not a thrown error', async () => {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=not-a-real-coin&vs_currencies=usd';
    mockFetch({ [url]: { body: {} } });

    const result = await getPrices({ coinIds: ['not-a-real-coin'], vsCurrencies: ['usd'] });
    expect(result).toEqual({});
  });
});
