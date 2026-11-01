/**
 * detectNewAtaCreation + getTransactionDetails (prompt 0205 bagian A/B).
 *
 * The five build fixtures are REAL, unsigned Jupiter /swap transactions
 * captured read-only during prompt 0205's own live experiment (never
 * signed, never broadcast; the "fresh" owner is a throwaway random
 * address generated for the experiment):
 *   sol-to-usdc-fresh:    output USDC ATA does NOT exist -> Jupiter
 *                         includes its CreateIdempotent -> true
 *   sol-to-usdc-existing: owner already holds the USDC ATA (the
 *                         treasury wallet) -> no output create -> false
 *                         (the one remaining ATA instruction is the
 *                         temporary wSOL account, rent refunded)
 *   usdc-to-sol-fresh:    native SOL output -> false by rule
 *   usdc-to-bonk-fresh:   token-to-token, new BONK ATA -> true
 *   sol-to-pyusd-fresh:   Token-2022 output (PYUSD) -> true via the
 *                         token-2022 candidate derivation
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { detectNewAtaCreation, getTransactionDetails } from '../transactionService.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/build-fixture-${name}.json`, import.meta.url), 'utf8'));

function detect(name) {
  const f = fixture(name);
  return detectNewAtaCreation({ transactionBase64: f.swapTransactionBase64, ownerAddress: f.ownerAddress, outputMint: f.outputMint });
}

describe('detectNewAtaCreation — real Jupiter build fixtures', () => {
  it('SOL -> USDC to an address WITHOUT the USDC ATA: creates it (classic token program)', () => {
    expect(detect('sol-to-usdc-fresh')).toEqual({ createsOutputAta: true, tokenProgram: 'spl-token' });
  });

  it('SOL -> USDC to an address WITH the USDC ATA: no new output account (the wSOL temp account does not count)', () => {
    expect(detect('sol-to-usdc-existing')).toEqual({ createsOutputAta: false, tokenProgram: null });
  });

  it('native SOL output never charges permanent rent — false without even parsing', () => {
    expect(detect('usdc-to-sol-fresh')).toEqual({ createsOutputAta: false, tokenProgram: null });
  });

  it('token to token (USDC -> BONK) with a new BONK ATA: true', () => {
    expect(detect('usdc-to-bonk-fresh')).toEqual({ createsOutputAta: true, tokenProgram: 'spl-token' });
  });

  it('Token-2022 output (SOL -> PYUSD) with a new ATA: true via the token-2022 derivation candidate', () => {
    expect(detect('sol-to-pyusd-fresh')).toEqual({ createsOutputAta: true, tokenProgram: 'token-2022' });
  });

  it('garbage base64 throws (the caller must fail SAFE and show "may apply")', () => {
    expect(() => detectNewAtaCreation({ transactionBase64: '!!!not-base64-tx', ownerAddress: fixture('sol-to-usdc-fresh').ownerAddress, outputMint: fixture('sol-to-usdc-fresh').outputMint })).toThrow(/deserialize/i);
  });
});

/**
 * getTransactionDetails — koreksi (b): a live endpoint answering
 * `result: null` with NO error (publicnode's limited getTransaction
 * history, proven live in 0205 fase 1) means "ask the next endpoint",
 * never "the transaction doesn't exist".
 */
describe('getTransactionDetails — null result falls through to the next endpoint', () => {
  const FIRST = 'https://first-rpc.example.test';
  const SECOND = 'https://second-rpc.example.test';
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const TX = JSON.parse(readFileSync(new URL('./fixtures/swap1-sol-to-usdc-getTransaction.json', import.meta.url), 'utf8'));

  function installFetch(resultByUrl) {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const { method } = JSON.parse(options.body);
      expect(method).toBe('getTransaction');
      calls.push(String(url));
      const result = resultByUrl(String(url));
      if (result instanceof Error) throw result;
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    };
    return calls;
  }

  it('first endpoint null (no error), second has the data -> the data is returned', async () => {
    const calls = installFetch((url) => (url === FIRST ? null : TX));
    const result = await getTransactionDetails({ network: 'solana', signature: 'SigA', endpoints: [FIRST, SECOND] });
    expect(result).toEqual(TX);
    expect(calls).toEqual([FIRST, SECOND]);
  });

  it('every endpoint null -> null (the caller keeps the estimate; nothing to parse)', async () => {
    const calls = installFetch(() => null);
    expect(await getTransactionDetails({ network: 'solana', signature: 'SigA', endpoints: [FIRST, SECOND] })).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('a transport failure on the first endpoint falls through silently', async () => {
    const calls = installFetch((url) => (url === FIRST ? new Error('connection reset') : TX));
    expect(await getTransactionDetails({ network: 'solana', signature: 'SigA', endpoints: [FIRST, SECOND] })).toEqual(TX);
    expect(calls).toHaveLength(2);
  });
});
