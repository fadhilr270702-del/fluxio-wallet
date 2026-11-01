/**
 * getTrustedBlockHeight (prompt 0203 Revisi 2) — the sanity-fenced block
 * height every SWAP_BLOCKHASH_EXPIRED verdict rests on. Born from a live
 * reviewer finding: publicnode's getBlockHeight (solana-core 4.3.0-rc.1)
 * returns the SLOT (~22M above the real mainnet block height, measured
 * gap 21,958,473 on 16 Sep 2026), so an unfenced comparison against
 * Jupiter's lastValidBlockHeight would stamp every swap expired
 * instantly through that endpoint. These tests inject an explicit
 * two-endpoint list (the `endpoints` test-only override) so the
 * recovery-through-a-second-RPC case is deterministic regardless of how
 * many endpoints the running config actually has (a keyless build's
 * solana network legitimately has just one).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getTrustedBlockHeight, BLOCK_HEIGHT_MIN_SLOT_GAP } from '../transactionService.js';

const FIRST = 'https://first-rpc.example.test';
const SECOND = 'https://second-rpc.example.test';

// Real numbers from the live investigation (16 Sep 2026): the broken
// endpoint's "blockHeight" ≈ its own slot; the healthy pair sits ~22M apart.
const SLOT_AS_HEIGHT = { blockHeight: 447421525, absoluteSlot: 447421527 };
const HEALTHY = { blockHeight: 425463056, absoluteSlot: 447421529 };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function installEpochInfoFetch(resultByUrl) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const { method } = JSON.parse(options.body);
    calls.push({ url: String(url), method });
    expect(method).toBe('getEpochInfo'); // the trusted getter must never fall back to raw getBlockHeight
    const result = resultByUrl(String(url));
    if (result instanceof Error) throw result;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
  return calls;
}

describe('getTrustedBlockHeight', () => {
  it('returns the first endpoint\'s blockHeight when it passes the sanity fence', async () => {
    const calls = installEpochInfoFetch(() => HEALTHY);
    const height = await getTrustedBlockHeight({ network: 'solana', endpoints: [FIRST, SECOND] });
    expect(height).toBe(HEALTHY.blockHeight);
    expect(calls).toHaveLength(1); // no reason to touch the second endpoint
  });

  it('a slot-as-blockHeight answer trips the fence (never returned as a height) and the SECOND endpoint recovers it — with the one-line contract log', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = installEpochInfoFetch((url) => (url === FIRST ? SLOT_AS_HEIGHT : HEALTHY));
    const height = await getTrustedBlockHeight({ network: 'solana', endpoints: [FIRST, SECOND] });
    expect(height).toBe(HEALTHY.blockHeight); // recovered via the second RPC, never the bogus number
    expect(calls.map((c) => c.url)).toEqual([FIRST, SECOND]);
    const fenceLogs = warnSpy.mock.calls.filter((args) => String(args[0]).includes('block-height sanity fence'));
    expect(fenceLogs).toHaveLength(1);
    expect(String(fenceLogs[0][0])).toContain('first-rpc.example.test'); // hostname only — never a full URL (API keys)
    expect(String(fenceLogs[0][0])).not.toContain('https://');
  });

  it('returns null when EVERY endpoint fails the fence — the caller must fall back to the time backup, never a bogus verdict', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installEpochInfoFetch(() => SLOT_AS_HEIGHT);
    const height = await getTrustedBlockHeight({ network: 'solana', endpoints: [FIRST, SECOND] });
    expect(height).toBeNull();
    expect(warnSpy.mock.calls.filter((args) => String(args[0]).includes('block-height sanity fence'))).toHaveLength(2);
  });

  it('a transport failure on the first endpoint falls through to the second silently (no fence log — the fence judges answers, not outages)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = installEpochInfoFetch((url) => (url === FIRST ? new Error('connection reset') : HEALTHY));
    const height = await getTrustedBlockHeight({ network: 'solana', endpoints: [FIRST, SECOND] });
    expect(height).toBe(HEALTHY.blockHeight);
    expect(calls).toHaveLength(2);
    expect(warnSpy.mock.calls.filter((args) => String(args[0]).includes('block-height sanity fence'))).toHaveLength(0);
  });

  it('a gap below BLOCK_HEIGHT_MIN_SLOT_GAP is untrusted even when blockHeight < absoluteSlot', async () => {
    installEpochInfoFetch(() => ({ blockHeight: 447000000, absoluteSlot: 447000000 + BLOCK_HEIGHT_MIN_SLOT_GAP - 1 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const height = await getTrustedBlockHeight({ network: 'solana', endpoints: [FIRST] });
    expect(height).toBeNull();
  });
});
