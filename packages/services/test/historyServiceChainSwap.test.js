/**
 * Chain-only Jupiter-swap recognition (prompt 0210, owner opsi B) —
 * proven against REAL mainnet getTransaction fixtures, never synthetic
 * swap shapes: the four owner-decided reference numbers come straight
 * from the 0203/0208 raw reconciliations, so a regression here means
 * the parser disagrees with the chain, not with a mock.
 *
 *  - swap1 4hm95… (SOL->USDC, first-ever swap, output ATA CREATED in
 *    the same tx): pay 5,000,000 lamports exactly — the born-ATA rent
 *    and the fee are both excluded; receive 480,995 raw USDC.
 *  - swap2 2Lwe5… (USDC->SOL): pay 480,995 raw USDC; receive 4,913,244
 *    lamports (the 0205 real-received figure).
 *  - swap11 59QZ… (SOL->USDC, post-incident): pay 3,000,000; receive
 *    359,305.
 *  - swap10 41vn… (USDC->SOL MAX): pay 569,892 raw USDC; receive
 *    4,650,232 lamports.
 *  - 4bTgMW5… (FAILED on chain, custom error 14): type 'swap', status
 *    'failed', NO amounts — the only movement was the network fee.
 *  - 5WhJ… (Phantom/DFlow gasless swap, program DF1ow…): deliberately
 *    NOT recognized (owner decision) — stays a plain transfer entry.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { getSolanaChainHistory } from '../historyService.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const TESTER = 'HM2tV6hdcRFvPkcspwWvs9KU7rwKTyEa6UXGPc6v6TFy';
const TREASURY = 'FnjdJcYsQShxUTPJjgVnjjvw5kKsVwfxtFCWBJMjPiwQ';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Same mock shape as historyService.test.js: signatures list + per-signature transaction. */
function mockChainFetch(sigInfos, transactionsBySignature) {
  const counts = { getTransaction: 0 };
  globalThis.fetch = vi.fn(async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.method === 'getSignaturesForAddress') {
      return { json: async () => ({ jsonrpc: '2.0', id: 1, result: sigInfos }) };
    }
    if (body.method === 'getTransaction') {
      counts.getTransaction += 1;
      const tx = transactionsBySignature[body.params[0]];
      if (tx === undefined) throw new Error(`Unexpected getTransaction for ${body.params[0]}`);
      return { json: async () => ({ jsonrpc: '2.0', id: 1, result: tx }) };
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  });
  return counts;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

async function parseOne(fixtureName, { address = TESTER, sig = 'SIG', err = null } = {}) {
  const tx = fixture(fixtureName);
  const counts = mockChainFetch([{ signature: sig, slot: tx.slot ?? 1, err, blockTime: tx.blockTime ?? 1_700_000_000 }], { [sig]: tx });
  const [entry] = await getSolanaChainHistory({ networkKey: 'solana', address });
  return { entry, counts };
}

describe('parseSolanaChainSwapEntry via getSolanaChainHistory — real mainnet fixtures', () => {
  it('4hm95 (SOL->USDC, output ATA born in the tx): pay 5,000,000 exactly (fee AND born-ATA rent excluded), receive 480,995 raw USDC', async () => {
    const { entry, counts } = await parseOne('swap1-sol-to-usdc-getTransaction.json');
    expect(entry.type).toBe('swap');
    expect(entry.status).toBe('confirmed');
    expect(entry.source).toBe('chain');
    expect(entry.inputMint).toBe(SOL_MINT);
    expect(entry.inputSymbol).toBe('SOL');
    expect(entry.inputAmountRaw).toBe('5000000');
    expect(entry.inputDecimals).toBe(9);
    expect(entry.outputMint).toBe(USDC_MINT);
    expect(entry.outputSymbol).toBe('Unknown'); // named at render time by background's custom > registry > snapshot lookup
    expect(entry.outputAmountRaw).toBe('480995');
    expect(entry.outputDecimals).toBe(6);
    expect(counts.getTransaction).toBe(1); // the history fetch itself — recognition costs ZERO extra RPC
  });

  it('2Lwe5 (USDC->SOL): pay 480,995 raw USDC, receive 4,913,244 lamports (the 0205 real-received figure)', async () => {
    const { entry } = await parseOne('swap2-usdc-to-sol-getTransaction.json');
    expect(entry.type).toBe('swap');
    expect(entry.inputMint).toBe(USDC_MINT);
    expect(entry.inputAmountRaw).toBe('480995');
    expect(entry.inputDecimals).toBe(6);
    expect(entry.outputMint).toBe(SOL_MINT);
    expect(entry.outputSymbol).toBe('SOL');
    expect(entry.outputAmountRaw).toBe('4913244');
    expect(entry.outputDecimals).toBe(9);
  });

  it('59QZ (swap #11, SOL->USDC after the ATA recovery): pay 3,000,000, receive 359,305', async () => {
    const { entry } = await parseOne('swap11-sol-to-usdc-getTransaction.json');
    expect(entry.type).toBe('swap');
    expect(entry.inputMint).toBe(SOL_MINT);
    expect(entry.inputAmountRaw).toBe('3000000');
    expect(entry.outputMint).toBe(USDC_MINT);
    expect(entry.outputAmountRaw).toBe('359305');
  });

  it('41vn (swap #10, USDC->SOL MAX): pay 569,892 raw USDC, receive 4,650,232 lamports', async () => {
    const { entry } = await parseOne('swap10-usdc-to-sol-max-getTransaction.json');
    expect(entry.type).toBe('swap');
    expect(entry.inputMint).toBe(USDC_MINT);
    expect(entry.inputAmountRaw).toBe('569892');
    expect(entry.outputMint).toBe(SOL_MINT);
    expect(entry.outputAmountRaw).toBe('4650232');
  });

  it('4bTgMW5 (FAILED on chain): type swap, status failed, NO amount fields at all', async () => {
    const { entry } = await parseOne('swap-failed-onchain-getTransaction.json', { err: { InstructionError: [5, { Custom: 14 }] } });
    expect(entry.type).toBe('swap');
    expect(entry.status).toBe('failed');
    expect(entry.source).toBe('chain');
    expect(entry.inputAmountRaw).toBeUndefined();
    expect(entry.outputAmountRaw).toBeUndefined();
    expect(entry.inputMint).toBeUndefined();
  });

  it('5WhJ (Phantom/DFlow, program DF1ow…): deliberately NOT recognized — parses as a plain transfer entry, exactly as before', async () => {
    const { entry } = await parseOne('dflow-phantom-swap-getTransaction.json', { address: TREASURY });
    expect(entry).toBeDefined();
    expect(entry.type).toBeUndefined(); // plain transfer shape, no 'swap' type
    expect(entry.direction).toBeDefined();
    expect(entry.amountRaw).toBeDefined();
  });

  it('a plain transfer (no Jupiter instruction) still parses as Sent/Received — the pre-0210 shape, unchanged', async () => {
    const OWNER = 'OwnerAddr1111111111111111111111111111111111';
    const OTHER = 'CounterpartyAddr222222222222222222222222222';
    const tx = {
      slot: 1,
      blockTime: 1_700_000_000,
      transaction: {
        message: {
          accountKeys: [
            { pubkey: OWNER, signer: true, writable: true, source: 'transaction' },
            { pubkey: OTHER, signer: false, writable: true, source: 'transaction' },
            { pubkey: '11111111111111111111111111111111', signer: false, writable: false, source: 'transaction' }
          ],
          instructions: [{ programId: '11111111111111111111111111111111' }]
        },
        signatures: ['SIG_PLAIN']
      },
      meta: { err: null, fee: 5000, preBalances: [2_000_000_000, 1_000_000_000, 1], postBalances: [1_899_995_000, 1_100_000_000, 1] }
    };
    mockChainFetch([{ signature: 'SIG_PLAIN', slot: 1, err: null, blockTime: 1_700_000_000 }], { SIG_PLAIN: tx });
    const [entry] = await getSolanaChainHistory({ networkKey: 'solana', address: OWNER });
    expect(entry.type).toBeUndefined();
    expect(entry.direction).toBe('out');
    expect(entry.amountRaw).toBe('100005000');
  });
});
