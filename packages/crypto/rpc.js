/**
 * Thrown by fetchRpcWithFallback() below when every configured endpoint
 * failed at the TRANSPORT/protocol level — a network error, a per-attempt
 * timeout, a non-JSON response, or a JSON-RPC-level `{ error }` body (the
 * node responded, but didn't/couldn't actually answer the request) — as
 * opposed to a genuine, successful, informative response.
 *
 * A distinct, checkable error TYPE (not just a message-text convention
 * like "starts with 'Could not reach'") so a caller that needs to tell
 * "the RPC itself is the problem right now" apart from "the RPC
 * answered, and the honest answer is 'nothing here'" can do so
 * structurally — `instanceof RpcUnreachableError`, not fragile
 * message-string matching. Extends plain Error, so every EXISTING
 * consumer that only ever read `.message` (there are several across
 * packages/services/*) keeps working completely unchanged; this is a
 * strictly additive capability, not a breaking shape change.
 *
 * Added to fix a real bug found in manual verification of prompt 0119
 * (see prompt/0119-add-token-ux-two-step.md's own Revision 1):
 * tokenService.js's fetchErc20Metadata() fires 3 CONCURRENT eth_calls
 * (symbol/name/decimals) against the same endpoint and used to only
 * treat the whole thing as "RPC unreachable" when ALL THREE rejected
 * identically — reproduced live: with a dead local anvil, one of the
 * three concurrent requests could still come back with a genuine (if
 * empty) HTTP response while the other two genuinely failed to connect,
 * and that single "successful but empty" result silently outvoted two
 * real connection failures, misreporting "No contract found" for an RPC
 * that was actually just unreachable. Having a real error TYPE lets that
 * function ask "did even ONE of these three fail at the transport
 * level?" directly, instead of needing every attempt to fail the same
 * way before it can tell the difference.
 */
export class RpcUnreachableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RpcUnreachableError';
  }
}

export async function fetchRpc(endpoint, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return response.json();
}

/** Per-endpoint-attempt timeout — public RPCs can hang, and fetchRpc() itself has no timeout of its own. */
const DEFAULT_RPC_TIMEOUT_MS = 8000;

/**
 * Shorter per-attempt timeout used automatically for a loopback endpoint
 * (e.g. a local solana-test-validator at 127.0.0.1:8899 — see
 * @fluxio/constants/networks.js's `solana-local`). A local process either
 * responds almost instantly or isn't running at all; there's no public-RPC
 * latency to wait out, so falling back to the same 8s budget as a remote
 * endpoint would just make a dead validator hang the extension popup for no
 * reason. Only applies when the caller doesn't pass an explicit
 * `opts.timeoutMs`.
 */
const LOCAL_RPC_TIMEOUT_MS = 2000;

function isLocalEndpoint(endpoint) {
  try {
    const { hostname } = new URL(endpoint);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Tries a network's default RPC endpoint, then each configured fallback in
 * order (both defined in @fluxio/constants/networks.js), on any failure:
 * network error, a non-JSON response, a per-attempt timeout, or a JSON-RPC
 * `{ error }` response. Only throws (an `RpcUnreachableError` — see that
 * class's own comment above) once every endpoint has failed.
 *
 * Shared by every service that talks to a network's RPC (balanceService,
 * transactionService, ...) so the fallback/timeout logic exists in one
 * place instead of being duplicated per caller.
 *
 * @param {{ name: string, rpc: { default: string, fallbacks: string[] } }} network
 * @param {object} body - JSON-RPC request body.
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function fetchRpcWithFallback(network, body, opts = {}) {
  const endpoints = [network.rpc.default, ...network.rpc.fallbacks];
  let lastError;
  for (const endpoint of endpoints) {
    const timeoutMs = opts.timeoutMs ?? (isLocalEndpoint(endpoint) ? LOCAL_RPC_TIMEOUT_MS : DEFAULT_RPC_TIMEOUT_MS);
    try {
      const data = await withTimeout(fetchRpc(endpoint, body), timeoutMs);
      if (data?.error) {
        throw new Error(data.error.message || 'RPC returned an error.');
      }
      return data;
    } catch (err) {
      lastError = err;
    }
  }
  throw new RpcUnreachableError(`Could not reach ${network.name}: ${lastError?.message || 'unknown error'}`);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out.')), ms))
  ]);
}
