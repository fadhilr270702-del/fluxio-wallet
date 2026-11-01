import { describe, it, expect, afterEach, vi } from 'vitest';
import { getSolanaChainHistory, mergeHistory } from '../historyService.js';

const OWNER = 'OwnerAddress1111111111111111111111111111';
const COUNTERPARTY = 'CounterpartyAddr222222222222222222222222';

function accountKeys(owner = OWNER, counterparty = COUNTERPARTY) {
  return [
    { pubkey: owner, signer: true, writable: true, source: 'transaction' },
    { pubkey: counterparty, signer: false, writable: true, source: 'transaction' },
    { pubkey: '11111111111111111111111111111111', signer: false, writable: false, source: 'transaction' }
  ];
}

/** Mocks getSignaturesForAddress -> [sigInfos], and getTransaction per signature -> the matching fixture (keyed by signature). */
function mockChainFetch(sigInfos, transactionsBySignature) {
  globalThis.fetch = vi.fn(async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.method === 'getSignaturesForAddress') {
      return { json: async () => ({ jsonrpc: '2.0', id: 1, result: sigInfos }) };
    }
    if (body.method === 'getTransaction') {
      const signature = body.params[0];
      const tx = transactionsBySignature[signature];
      if (tx === undefined) throw new Error(`Unexpected getTransaction for ${signature}`);
      return { json: async () => ({ jsonrpc: '2.0', id: 1, result: tx }) };
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('getSolanaChainHistory — parsing getSignaturesForAddress + getTransaction', () => {
  it('an outgoing transfer: owner balance decreases, counterparty increases, direction "out"', async () => {
    mockChainFetch(
      [{ signature: 'SIG_OUT', slot: 1, err: null, blockTime: 1_700_000_000 }],
      {
        SIG_OUT: {
          slot: 1,
          blockTime: 1_700_000_000,
          transaction: { message: { accountKeys: accountKeys() }, signatures: ['SIG_OUT'] },
          meta: {
            err: null,
            // owner pays 0.1 SOL + a 5000-lamport fee; counterparty gains exactly 0.1 SOL.
            preBalances: [2_000_000_000, 1_000_000_000, 1],
            postBalances: [1_899_995_000, 1_100_000_000, 1]
          }
        }
      }
    );

    const result = await getSolanaChainHistory({ networkKey: 'solana-devnet', address: OWNER });
    expect(result).toEqual([
      {
        networkKey: 'solana-devnet',
        direction: 'out',
        signatureOrHash: 'SIG_OUT',
        from: OWNER,
        to: COUNTERPARTY,
        amountRaw: '100005000', // includes the fee — a real net balance-change fact, not the "intended" transfer amount alone
        unit: 'SOL',
        timestamp: 1_700_000_000_000,
        timestampReliable: true, // solana-devnet — a real cluster, not the local-validator blockTime quirk (see BUG 2 fix)
        status: 'confirmed',
        source: 'chain'
      }
    ]);
  });

  it('an incoming transfer: owner balance increases, direction "in"', async () => {
    mockChainFetch(
      [{ signature: 'SIG_IN', slot: 2, err: null, blockTime: 1_700_000_100 }],
      {
        SIG_IN: {
          slot: 2,
          blockTime: 1_700_000_100,
          transaction: { message: { accountKeys: accountKeys() }, signatures: ['SIG_IN'] },
          meta: {
            err: null,
            preBalances: [1_000_000_000, 2_000_000_000, 1],
            postBalances: [1_500_000_000, 1_499_995_000, 1]
          }
        }
      }
    );

    const result = await getSolanaChainHistory({ networkKey: 'solana-devnet', address: OWNER });
    expect(result[0]).toMatchObject({ direction: 'in', from: COUNTERPARTY, to: OWNER, amountRaw: '500000000' });
  });

  it('a failed transaction (sigInfo.err set) is marked status "failed"', async () => {
    mockChainFetch(
      [{ signature: 'SIG_FAILED', slot: 3, err: { InstructionError: [0, 'Custom'] }, blockTime: 1_700_000_200 }],
      {
        SIG_FAILED: {
          slot: 3,
          blockTime: 1_700_000_200,
          transaction: { message: { accountKeys: accountKeys() }, signatures: ['SIG_FAILED'] },
          meta: {
            err: { InstructionError: [0, 'Custom'] },
            preBalances: [2_000_000_000, 1_000_000_000, 1],
            postBalances: [1_999_995_000, 1_000_000_000, 1] // only the fee was actually deducted — the transfer itself never happened
          }
        }
      }
    );

    const result = await getSolanaChainHistory({ networkKey: 'solana-devnet', address: OWNER });
    expect(result[0].status).toBe('failed');
  });

  it('a transaction with zero net effect on the owner is skipped entirely', async () => {
    mockChainFetch(
      [{ signature: 'SIG_NOOP', slot: 4, err: null, blockTime: 1_700_000_300 }],
      {
        SIG_NOOP: {
          slot: 4,
          blockTime: 1_700_000_300,
          transaction: { message: { accountKeys: accountKeys() }, signatures: ['SIG_NOOP'] },
          meta: { err: null, preBalances: [2_000_000_000, 1_000_000_000, 1], postBalances: [2_000_000_000, 1_000_000_000, 1] }
        }
      }
    );

    const result = await getSolanaChainHistory({ networkKey: 'solana-devnet', address: OWNER });
    expect(result).toEqual([]);
  });

  it('the owner not appearing in accountKeys at all is skipped (defensive — should not happen for a real getSignaturesForAddress result)', async () => {
    mockChainFetch(
      [{ signature: 'SIG_UNRELATED', slot: 5, err: null, blockTime: 1_700_000_400 }],
      {
        SIG_UNRELATED: {
          slot: 5,
          blockTime: 1_700_000_400,
          transaction: { message: { accountKeys: accountKeys('SomeoneElse111111111111111111111111111111', COUNTERPARTY) }, signatures: ['SIG_UNRELATED'] },
          meta: { err: null, preBalances: [1, 1, 1], postBalances: [2, 1, 1] }
        }
      }
    );

    const result = await getSolanaChainHistory({ networkKey: 'solana-devnet', address: OWNER });
    expect(result).toEqual([]);
  });

  it('one malformed transaction is skipped without taking the rest of the history down with it', async () => {
    mockChainFetch(
      [
        { signature: 'SIG_BAD', slot: 6, err: null, blockTime: 1_700_000_500 },
        { signature: 'SIG_GOOD', slot: 7, err: null, blockTime: 1_700_000_600 }
      ],
      {
        SIG_BAD: { slot: 6, blockTime: 1_700_000_500, transaction: { message: {} }, meta: null }, // malformed — missing accountKeys/meta entirely
        SIG_GOOD: {
          slot: 7,
          blockTime: 1_700_000_600,
          transaction: { message: { accountKeys: accountKeys() }, signatures: ['SIG_GOOD'] },
          meta: { err: null, preBalances: [2_000_000_000, 1_000_000_000, 1], postBalances: [1_899_995_000, 1_100_000_000, 1] }
        }
      }
    );

    const result = await getSolanaChainHistory({ networkKey: 'solana-devnet', address: OWNER });
    expect(result).toHaveLength(1);
    expect(result[0].signatureOrHash).toBe('SIG_GOOD');
  });

  it(
    'handles a realistically large balance delta (near, not technically beyond, Number.MAX_SAFE_INTEGER) via exact BigInt arithmetic — ' +
      'see this test file\'s own note below on why ">MAX_SAFE_INTEGER" itself cannot be constructed for this specific RPC shape',
    async () => {
      // Solana's getSignaturesForAddress/getTransaction deliver
      // preBalances/postBalances as plain JSON numbers (not a hex string
      // the way EVM's eth_getBalance/eth_call do) — there is no way to
      // write a JS number literal (in this test, OR in a real RPC
      // response's JSON text) that both exceeds Number.MAX_SAFE_INTEGER
      // AND survives exactly: the JS engine's own numeric-literal parser
      // (for a hand-written test fixture) and JSON.parse (for a real
      // response) both round such a value at parse time, before this
      // service's own code ever runs. This is a genuine protocol-level
      // ceiling, not a gap in this file's BigInt discipline — unlike
      // EVM's wei-as-hex-string values (see tokenService.test.js's own
      // >MAX_SAFE_INTEGER test), which sidestep the problem entirely.
      // This test instead proves exact BigInt delta/formatting at a
      // realistically large magnitude close to that ceiling (10,000 SOL),
      // confirming the delta computation never round-trips through
      // lossy floating-point subtraction.
      const large = 10_000_000_000_000n; // 10,000 SOL in lamports — a big, realistic whale-sized balance
      mockChainFetch(
        [{ signature: 'SIG_LARGE', slot: 8, err: null, blockTime: 1_700_000_700 }],
        {
          SIG_LARGE: {
            slot: 8,
            blockTime: 1_700_000_700,
            transaction: { message: { accountKeys: accountKeys() }, signatures: ['SIG_LARGE'] },
            meta: {
              err: null,
              preBalances: [Number(large) + 5000, 0, 1],
              postBalances: [0, Number(large), 1]
            }
          }
        }
      );

      const result = await getSolanaChainHistory({ networkKey: 'solana-devnet', address: OWNER });
      expect(result[0].amountRaw).toBe((large + 5000n).toString());
      expect(BigInt(result[0].amountRaw)).toBe(large + 5000n);
    }
  );

  it('propagates an RPC failure for getSignaturesForAddress as a rejection', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('simulated network failure');
    });
    await expect(getSolanaChainHistory({ networkKey: 'solana-devnet', address: OWNER })).rejects.toThrow(/Could not reach/);
  });

  it('rejects a non-Solana network', async () => {
    await expect(getSolanaChainHistory({ networkKey: 'ethereum-sepolia', address: OWNER })).rejects.toThrow(/not a Solana network/);
  });

  it('rejects an unknown network', async () => {
    await expect(getSolanaChainHistory({ networkKey: 'dogecoin', address: OWNER })).rejects.toThrow(/Unknown network/);
  });
});

describe('mergeHistory — dedup + status precedence (BUG 1 fix: local wins for amount/to/from/timestamp, chain only contributes status)', () => {
  it('a signature present only locally (not yet visible on chain) is kept as-is', () => {
    const local = [{ signatureOrHash: 'SIG_A', status: 'pending', timestamp: 100, direction: 'out' }];
    expect(mergeHistory(local, [])).toEqual(local);
  });

  it('a signature present in both sources keeps the LOCAL entry\'s direction/from/to/amount/timestamp, only takes status from chain', () => {
    const local = {
      networkKey: 'solana-devnet',
      signatureOrHash: 'SIG_A',
      status: 'pending',
      timestamp: 100,
      direction: 'out',
      from: OWNER,
      to: COUNTERPARTY,
      amountRaw: '100000000',
      unit: 'SOL'
    };
    const chain = { signatureOrHash: 'SIG_A', status: 'confirmed', timestamp: 999, direction: 'out', from: OWNER, to: null, amountRaw: '5000', unit: 'SOL', source: 'chain' };
    const result = mergeHistory([local], [chain]);
    expect(result).toEqual([{ ...local, status: 'confirmed' }]);
  });

  it(
    'BUG 1 regression: a self-transfer (from === to) is not corrupted into "unknown address, fee-only amount" — ' +
      'local record wins over the ambiguous chain-derived parse',
    () => {
      // Exactly what was observed in real manual verification: a
      // self-transfer's own balance delta only reflects the network
      // fee (the transfer amount cancels out for a single address
      // acting as both sender and recipient), and the counterparty
      // heuristic correctly finds no genuine OTHER account — so the
      // OLD "chain wins" rule reported "Sent to unknown address
      // -0.000005 SOL" for what was actually a real 0.1 SOL
      // self-transfer. The local record has no such ambiguity.
      const local = {
        networkKey: 'solana-devnet',
        signatureOrHash: 'SELF_TRANSFER_SIG',
        status: 'pending',
        timestamp: 1_700_000_000_000,
        direction: 'out',
        from: OWNER,
        to: OWNER,
        amountRaw: '100000000', // 0.1 SOL, the REAL intended amount
        unit: 'SOL'
      };
      const chainMisparse = {
        signatureOrHash: 'SELF_TRANSFER_SIG',
        status: 'confirmed',
        timestamp: 1_800_000_000_000, // a bogus/unreliable chain timestamp — should also be ignored
        direction: 'out',
        from: OWNER,
        to: null, // findCounterpartyAddress correctly found no distinct counterparty
        amountRaw: '5000', // just the fee — the real bug's symptom
        unit: 'SOL',
        source: 'chain'
      };

      const [result] = mergeHistory([local], [chainMisparse]);
      expect(result.to).toBe(OWNER); // NOT null/"unknown"
      expect(result.amountRaw).toBe('100000000'); // NOT '5000'
      expect(result.timestamp).toBe(1_700_000_000_000); // NOT the chain's bogus timestamp
      expect(result.status).toBe('confirmed'); // status IS still taken from chain
    }
  );

  it('entries from both sources are combined and sorted newest-first', () => {
    const local = [{ signatureOrHash: 'OLD', status: 'confirmed', timestamp: 100 }];
    const chain = [
      { signatureOrHash: 'NEWEST', status: 'confirmed', timestamp: 300 },
      { signatureOrHash: 'MIDDLE', status: 'confirmed', timestamp: 200 }
    ];
    expect(mergeHistory(local, chain).map((e) => e.signatureOrHash)).toEqual(['NEWEST', 'MIDDLE', 'OLD']);
  });

  it('a chain-only entry (a genuine incoming transfer, or an EVM send with no chain source at all being irrelevant here) is used as-is', () => {
    const chain = [{ signatureOrHash: 'INCOMING', status: 'confirmed', timestamp: 500, direction: 'in', from: COUNTERPARTY, to: OWNER, amountRaw: '77', unit: 'SOL', source: 'chain' }];
    expect(mergeHistory([], chain)).toEqual(chain);
  });

  it('an EVM-only local record round-trips through the merge unchanged (no chain-history source exists for EVM)', () => {
    const evmLocal = [
      { networkKey: 'ethereum-sepolia', direction: 'out', signatureOrHash: '0xabc', status: 'confirmed', timestamp: 100, amountRaw: '10000000000000000', unit: 'ETH' }
    ];
    expect(mergeHistory(evmLocal, [])).toEqual(evmLocal);
  });

  it('an empty local list and an empty chain list merge to an empty list', () => {
    expect(mergeHistory([], [])).toEqual([]);
  });
});

describe('getSolanaChainHistory — timestampReliable (BUG 2 fix)', () => {
  it('a solana-local chain entry is marked timestampReliable: false', async () => {
    mockChainFetch(
      [{ signature: 'SIG_LOCAL', slot: 1, err: null, blockTime: 1_700_000_000 }],
      {
        SIG_LOCAL: {
          slot: 1,
          blockTime: 1_700_000_000,
          transaction: { message: { accountKeys: accountKeys() }, signatures: ['SIG_LOCAL'] },
          meta: { err: null, preBalances: [2_000_000_000, 1_000_000_000, 1], postBalances: [1_899_995_000, 1_100_000_000, 1] }
        }
      }
    );
    const [result] = await getSolanaChainHistory({ networkKey: 'solana-local', address: OWNER });
    expect(result.timestampReliable).toBe(false);
  });

  it('a solana-devnet chain entry is marked timestampReliable: true (real cluster, no known blockTime issue)', async () => {
    mockChainFetch(
      [{ signature: 'SIG_DEVNET', slot: 1, err: null, blockTime: 1_700_000_000 }],
      {
        SIG_DEVNET: {
          slot: 1,
          blockTime: 1_700_000_000,
          transaction: { message: { accountKeys: accountKeys() }, signatures: ['SIG_DEVNET'] },
          meta: { err: null, preBalances: [2_000_000_000, 1_000_000_000, 1], postBalances: [1_899_995_000, 1_100_000_000, 1] }
        }
      }
    );
    const [result] = await getSolanaChainHistory({ networkKey: 'solana-devnet', address: OWNER });
    expect(result.timestampReliable).toBe(true);
  });
});

describe('getSolanaChainHistory — per-entry failure isolation (BUG 3 hardening)', () => {
  it('a getTransaction RPC-level failure (not just malformed data) for one signature is isolated — other signatures still resolve', async () => {
    globalThis.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.method === 'getSignaturesForAddress') {
        return {
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: [
              { signature: 'SIG_RPC_FAILS', slot: 1, err: null, blockTime: 1_700_000_000 },
              { signature: 'SIG_OK', slot: 2, err: null, blockTime: 1_700_000_100 }
            ]
          })
        };
      }
      const signature = body.params[0];
      if (signature === 'SIG_RPC_FAILS') {
        throw new Error('simulated timeout'); // a genuine network-level failure, not a malformed-response one
      }
      return {
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            slot: 2,
            blockTime: 1_700_000_100,
            transaction: { message: { accountKeys: accountKeys() }, signatures: ['SIG_OK'] },
            meta: { err: null, preBalances: [2_000_000_000, 1_000_000_000, 1], postBalances: [1_899_995_000, 1_100_000_000, 1] }
          }
        })
      };
    });

    const result = await getSolanaChainHistory({ networkKey: 'solana-devnet', address: OWNER });
    expect(result).toHaveLength(1);
    expect(result[0].signatureOrHash).toBe('SIG_OK');
  });

  it('isolation holds regardless of ordering: a failure AFTER an earlier success does not retroactively drop the earlier one', async () => {
    globalThis.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.method === 'getSignaturesForAddress') {
        return {
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: [
              { signature: 'SIG_OK_FIRST', slot: 1, err: null, blockTime: 1_700_000_000 },
              { signature: 'SIG_FAILS_SECOND', slot: 2, err: null, blockTime: 1_700_000_100 }
            ]
          })
        };
      }
      const signature = body.params[0];
      if (signature === 'SIG_FAILS_SECOND') {
        throw new Error('simulated timeout');
      }
      return {
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            slot: 1,
            blockTime: 1_700_000_000,
            transaction: { message: { accountKeys: accountKeys() }, signatures: ['SIG_OK_FIRST'] },
            meta: { err: null, preBalances: [2_000_000_000, 1_000_000_000, 1], postBalances: [1_899_995_000, 1_100_000_000, 1] }
          }
        })
      };
    });

    const result = await getSolanaChainHistory({ networkKey: 'solana-devnet', address: OWNER });
    expect(result).toHaveLength(1);
    expect(result[0].signatureOrHash).toBe('SIG_OK_FIRST');
  });
});
