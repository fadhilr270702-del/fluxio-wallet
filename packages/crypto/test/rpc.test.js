import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchRpc, fetchRpcWithFallback, RpcUnreachableError } from '../rpc.js';

/**
 * fetchRpcWithFallback's own mechanism, tested directly against a
 * synthetic network object rather than any real entry in
 * @fluxio/constants/networks.js — real networks' fallback configuration
 * changes over time as free public RPC endpoints come and go (see
 * networks.js's own comments for the current, verified state), but the
 * retry/fallback/timeout mechanism itself shouldn't need a real 2-endpoint
 * network to stay tested.
 */
function fakeNetwork(name, endpoints) {
  const [defaultUrl, ...fallbacks] = endpoints;
  return { name, rpc: { default: defaultUrl, fallbacks } };
}

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
  vi.useRealTimers();
});

describe('fetchRpc', () => {
  it('POSTs the given body and returns the parsed JSON response', async () => {
    mockFetch({ 'https://example.test/rpc': { body: { jsonrpc: '2.0', id: 1, result: 42 } } });
    const result = await fetchRpc('https://example.test/rpc', { jsonrpc: '2.0', id: 1, method: 'ping', params: [] });
    expect(result.result).toBe(42);
  });
});

describe('fetchRpcWithFallback', () => {
  it('returns the default endpoint result when it succeeds', async () => {
    const network = fakeNetwork('Fake', ['https://default.test']);
    mockFetch({ 'https://default.test': { body: { jsonrpc: '2.0', id: 1, result: 'ok' } } });

    const result = await fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] });
    expect(result.result).toBe('ok');
  });

  it('falls back to the next endpoint when the default throws (network error)', async () => {
    const network = fakeNetwork('Fake', ['https://default.test', 'https://fallback.test']);
    mockFetch({
      'https://default.test': { reject: 'simulated network failure' },
      'https://fallback.test': { body: { jsonrpc: '2.0', id: 1, result: 'from-fallback' } }
    });

    const result = await fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] });
    expect(result.result).toBe('from-fallback');
  });

  it('falls back when the default responds with a JSON-RPC { error } body', async () => {
    const network = fakeNetwork('Fake', ['https://default.test', 'https://fallback.test']);
    mockFetch({
      'https://default.test': { body: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'rate limited' } } },
      'https://fallback.test': { body: { jsonrpc: '2.0', id: 1, result: 'from-fallback' } }
    });

    const result = await fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] });
    expect(result.result).toBe('from-fallback');
  });

  it('tries every fallback in order before giving up', async () => {
    const network = fakeNetwork('Fake', ['https://a.test', 'https://b.test', 'https://c.test']);
    mockFetch({
      'https://a.test': { reject: 'a down' },
      'https://b.test': { reject: 'b down' },
      'https://c.test': { body: { jsonrpc: '2.0', id: 1, result: 'from-c' } }
    });

    const result = await fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] });
    expect(result.result).toBe('from-c');
  });

  it('throws a "Could not reach {name}" error once every endpoint has failed', async () => {
    const network = fakeNetwork('Fake Network', ['https://a.test', 'https://b.test']);
    mockFetch({
      'https://a.test': { reject: 'a down' },
      'https://b.test': { reject: 'b down' }
    });

    await expect(
      fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] })
    ).rejects.toThrow(/Could not reach Fake Network/);
  });

  it('treats a per-attempt timeout as a failure worth falling back from', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url === 'https://slow.test') {
        return new Promise(() => {}); // never resolves — must be treated as a timeout, not hang the test
      }
      return Promise.resolve({ json: async () => ({ jsonrpc: '2.0', id: 1, result: 'fast' }) });
    });

    const network = fakeNetwork('Fake', ['https://slow.test', 'https://fast.test']);
    const result = await fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] }, { timeoutMs: 20 });
    expect(result.result).toBe('fast');
  });

  it('has no fallback configured for a single-endpoint network — a real failure just throws', async () => {
    const network = fakeNetwork('Solo Network', ['https://only.test']);
    mockFetch({ 'https://only.test': { reject: 'down' } });

    await expect(
      fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] })
    ).rejects.toThrow(/Could not reach Solo Network/);
  });

  // A dead local solana-test-validator (see @fluxio/constants/networks.js's
  // solana-local) must fail fast rather than sit on the same 8s budget a
  // remote public RPC gets — otherwise a popup UI checking a local balance
  // would hang for no reason. These two tests use fake timers (not a real
  // 8s wait) to prove the local endpoint times out well before the default
  // budget would even be reached.
  it('applies a much shorter default timeout to a loopback (127.0.0.1) endpoint than to a remote one', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => new Promise(() => {})); // never resolves — simulates a dead local validator
    const network = fakeNetwork('Local', ['http://127.0.0.1:8899']);

    let rejected = false;
    fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] }).catch(() => {
      rejected = true;
    });

    await vi.advanceTimersByTimeAsync(1999);
    expect(rejected).toBe(false); // not yet — still under the local timeout

    await vi.advanceTimersByTimeAsync(50);
    expect(rejected).toBe(true); // fires quickly, well short of the 8s remote default
  });

  it('leaves the full default timeout in place for a non-local endpoint', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
    const network = fakeNetwork('Remote', ['https://remote.test']);

    let rejected = false;
    fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] }).catch(() => {
      rejected = true;
    });

    await vi.advanceTimersByTimeAsync(2500); // well past the local-endpoint timeout, still short of the 8s remote default
    expect(rejected).toBe(false);
  });

  it('throws a real, checkable RpcUnreachableError instance — not just a plain Error with a matching message (prompt 0119 Revision 1: a caller needs to tell this apart from a genuine "empty" answer structurally, not by string-matching)', async () => {
    const network = fakeNetwork('Fake Network', ['https://a.test']);
    mockFetch({ 'https://a.test': { reject: 'down' } });

    await expect(fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] })).rejects.toBeInstanceOf(
      RpcUnreachableError
    );
  });

  it('is ALSO an RpcUnreachableError when every endpoint answered with a JSON-RPC { error } body (the node responded, but couldn\'t service the request — not a genuine "nothing here" answer either)', async () => {
    const network = fakeNetwork('Fake Network', ['https://a.test']);
    mockFetch({ 'https://a.test': { body: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'rate limited' } } } });

    await expect(fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] })).rejects.toBeInstanceOf(
      RpcUnreachableError
    );
  });

  it('an explicit opts.timeoutMs still overrides the local-endpoint default', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
    const network = fakeNetwork('Local', ['http://127.0.0.1:8899']);

    let rejected = false;
    fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] }, { timeoutMs: 5000 }).catch(() => {
      rejected = true;
    });

    await vi.advanceTimersByTimeAsync(2500); // past the local default, but under the explicit 5000ms override
    expect(rejected).toBe(false);

    await vi.advanceTimersByTimeAsync(2600);
    expect(rejected).toBe(true);
  });
});
