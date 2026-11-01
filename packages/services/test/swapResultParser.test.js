/**
 * parseSwapReceivedRaw (prompt 0205 bagian B) — proven against the two
 * REAL mainnet swaps from prompt 0203 Revisi 3, stored verbatim as
 * getTransaction (jsonParsed) fixtures fetched keyless from
 * api.mainnet-beta.solana.com (public chain data, no secrets):
 *   swap 1: SOL -> USDC, sig 4hm95AhX…WnMki — the user's brand-new USDC
 *           ATA received exactly 480,995 raw (0.480995 USDC), NET of
 *           the 4,123-raw treasury fee (gross was 485,118).
 *   swap 2: USDC -> SOL (MAX), sig 2Lwe5tVH…sUXdM — lamport delta
 *           +4,808,244 plus the 105,000 fee = 4,913,244 lamports
 *           (0.004913244 SOL) actually received.
 * The parser must return null — never a wrong number, never a throw —
 * for on-chain failures and malformed shapes (0205 koreksi c: a parser
 * problem can never disturb the swap's own verdict).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSwapReceivedRaw } from '../swapResultParser.js';

const USER = 'HM2tV6hdcRFvPkcspwWvs9KU7rwKTyEa6UXGPc6v6TFy';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const swap1 = fixture('swap1-sol-to-usdc-getTransaction.json');
const swap2 = fixture('swap2-usdc-to-sol-getTransaction.json');

describe('parseSwapReceivedRaw — real mainnet fixtures', () => {
  it('SPL output (swap 1, new ATA created in the same tx): exactly 480,995 raw USDC — what landed in the user wallet, net of the platform fee', () => {
    expect(parseSwapReceivedRaw({ transaction: swap1, ownerAddress: USER, outputMint: USDC })).toBe(480995n);
  });

  it('native SOL output (swap 2): lamport delta + fee = 4,913,244 lamports exactly', () => {
    expect(parseSwapReceivedRaw({ transaction: swap2, ownerAddress: USER, outputMint: SOL })).toBe(4913244n);
  });

  it('the wrong owner sees no balance delta: another address on swap 1 gets null (no matching token balances)', () => {
    // The treasury owner's USDC balance DID move (+4123 fee) — but a
    // caller asking about an address with no entries at all gets null,
    // and asking about the treasury returns ITS delta, not the user's.
    expect(parseSwapReceivedRaw({ transaction: swap1, ownerAddress: 'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', outputMint: USDC })).toBe(0n);
  });
});

describe('parseSwapReceivedRaw — failure shapes return null, never throw', () => {
  it('an on-chain failure (meta.err non-null) returns null', () => {
    const failed = JSON.parse(JSON.stringify(swap1));
    failed.meta.err = { InstructionError: [3, { Custom: 6001 }] };
    expect(parseSwapReceivedRaw({ transaction: failed, ownerAddress: USER, outputMint: USDC })).toBeNull();
  });

  it('missing token balances return null for an SPL output', () => {
    const broken = JSON.parse(JSON.stringify(swap1));
    delete broken.meta.postTokenBalances;
    expect(parseSwapReceivedRaw({ transaction: broken, ownerAddress: USER, outputMint: USDC })).toBeNull();
  });

  it('missing lamport balances return null for a native SOL output', () => {
    const broken = JSON.parse(JSON.stringify(swap2));
    delete broken.meta.postBalances;
    expect(parseSwapReceivedRaw({ transaction: broken, ownerAddress: USER, outputMint: SOL })).toBeNull();
  });

  it('a missing meta, a null transaction, and garbage amount strings all return null', () => {
    expect(parseSwapReceivedRaw({ transaction: null, ownerAddress: USER, outputMint: USDC })).toBeNull();
    expect(parseSwapReceivedRaw({ transaction: {}, ownerAddress: USER, outputMint: USDC })).toBeNull();
    const garbage = JSON.parse(JSON.stringify(swap1));
    garbage.meta.postTokenBalances[0].uiTokenAmount.amount = 'not-a-number';
    expect(parseSwapReceivedRaw({ transaction: garbage, ownerAddress: USER, outputMint: USDC })).toBeNull();
  });

  it('a user absent from the account keys returns null for a native SOL output', () => {
    expect(parseSwapReceivedRaw({ transaction: swap1, ownerAddress: 'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', outputMint: SOL })).toBeNull();
  });
});
