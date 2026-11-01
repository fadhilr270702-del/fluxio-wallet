import { describe, it, expect, afterEach, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  estimateSolTransfer,
  sendSolTransfer,
  getTransactionStatus,
  requestDevnetAirdrop,
  getSolBalance,
  waitForBalanceAtLeast,
  estimateSplTransfer,
  sendSplTransfer,
  TransactionValidationError
} from '../transactionService.js';
import { NETWORKS } from '@fluxio/constants';

// A real (throwaway, test-only) ed25519 keypair — Transaction.serialize()
// genuinely verifies signatures before producing bytes, so sendSolTransfer's
// success-path tests need a `sign` callback that returns a real signature
// over the exact message bytes it's handed, not an arbitrary byte string.
const SENDER_KEYPAIR = nacl.sign.keyPair();
const FROM = bs58.encode(SENDER_KEYPAIR.publicKey);
const TO = bs58.encode(nacl.sign.keyPair().publicKey);
const MINT = bs58.encode(nacl.sign.keyPair().publicKey);
const realSign = async (messageBytes) => nacl.sign.detached(messageBytes, SENDER_KEYPAIR.secretKey);

const DEVNET = NETWORKS['solana-devnet'];
const LOCAL = NETWORKS['solana-local'];
// A real base58 encoding of 32 zero bytes (the System Program's own id) —
// blockhashes must decode to exactly 32 bytes, so an arbitrary string of
// the "right length" isn't good enough here.
const BLOCKHASH_RESULT = { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000 } };

/**
 * Installs a fetch mock keyed by exact endpoint URL, then by JSON-RPC
 * `method` within that URL's responses — unlike balanceService's single
 * getBalance-per-endpoint calls, a single sendSolTransfer touches several
 * different RPC methods against the same endpoint, so a URL-only key isn't
 * enough to tell the calls apart.
 *
 * `responsesByUrl` is `{ [url]: { [method]: { body } | { reject } } }`.
 */
function mockRpc(responsesByUrl) {
  globalThis.fetch = vi.fn(async (url, options) => {
    const forUrl = responsesByUrl[url];
    if (!forUrl) throw new Error(`Unexpected fetch to ${url}`);
    const { method } = JSON.parse(options.body);
    const entry = forUrl[method];
    if (!entry) throw new Error(`Unexpected RPC method ${method} against ${url}`);
    if (entry.reject) throw new Error(entry.reject);
    return { json: async () => entry.body };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('estimateSolTransfer', () => {
  it('returns the fee and blockhash for a valid transfer', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getLatestBlockhash: { body: { jsonrpc: '2.0', id: 1, result: BLOCKHASH_RESULT } },
        getFeeForMessage: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000 } } }
      }
    });

    const result = await estimateSolTransfer({ network: 'solana-devnet', from: FROM, to: TO, lamports: 1_000_000n });
    expect(result.fee).toBe(5000n);
    expect(result.blockhash).toBe(BLOCKHASH_RESULT.value.blockhash);
  });

  it('rejects a non-Solana network', async () => {
    await expect(
      estimateSolTransfer({ network: 'ethereum', from: FROM, to: TO, lamports: 1_000_000n })
    ).rejects.toThrow(/not a Solana network/);
  });
});

describe('sendSolTransfer', () => {
  it('builds, signs (via the injected sign callback) and broadcasts a transfer', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getLatestBlockhash: { body: { jsonrpc: '2.0', id: 1, result: BLOCKHASH_RESULT } },
        getFeeForMessage: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000 } } },
        getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 10_000_000 } } },
        sendTransaction: { body: { jsonrpc: '2.0', id: 1, result: 'FakeSignature111' } }
      }
    });

    const sign = vi.fn(async (messageBytes) => {
      expect(messageBytes).toBeInstanceOf(Uint8Array);
      return realSign(messageBytes);
    });

    const result = await sendSolTransfer({
      network: 'solana-devnet',
      from: FROM,
      to: TO,
      lamports: 1_000_000n,
      sign
    });

    expect(sign).toHaveBeenCalledTimes(1);
    expect(result.signature).toBe('FakeSignature111');
    expect(result.explorerUrl).toBe('https://explorer.solana.com/tx/FakeSignature111?cluster=devnet');
  });

  it('rejects an invalid recipient address', async () => {
    await expect(
      sendSolTransfer({ network: 'solana-devnet', from: FROM, to: 'not-a-valid-address', lamports: 1_000_000n, sign: vi.fn() })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });

  it('rejects when the sender balance cannot cover amount + fee', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getLatestBlockhash: { body: { jsonrpc: '2.0', id: 1, result: BLOCKHASH_RESULT } },
        getFeeForMessage: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000 } } },
        getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 100 } } } // far less than 1_000_000 + 5000
      }
    });

    await expect(
      sendSolTransfer({ network: 'solana-devnet', from: FROM, to: TO, lamports: 1_000_000n, sign: vi.fn() })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  // "RPC utama gagal -> fallback jalan" for sendSolTransfer's own call
  // sites is covered directly in packages/crypto/test/rpc.test.js against
  // a synthetic 2-endpoint network, not here against a real one — as of
  // this fix, neither 'solana' nor 'solana-devnet' in networks.js has a
  // verified free/keyless second endpoint to fall back to (see that
  // file's own comments), so asserting a fallback path through *this*
  // service's real config would mean depending on an endpoint that isn't
  // actually there. fetchRpcWithFallback (the function every RPC call in
  // this file goes through) is the same shared helper balanceService uses
  // — see balanceService.test.js's own Ethereum-based fallback test for a
  // second, service-level example of the same mechanism.

  it('requires a sign function', async () => {
    await expect(
      sendSolTransfer({ network: 'solana-devnet', from: FROM, to: TO, lamports: 1_000_000n })
    ).rejects.toMatchObject({ code: 'MISSING_SIGNER' });
  });

  // solana-local (see @fluxio/constants/networks.js) sets
  // explorer.clusterQueryOverride instead of relying on the plain `cluster`
  // suffix every other network uses, since explorer.solana.com has no
  // built-in notion of a local validator's `cluster: 'localnet'` value.
  it('builds a custom-cluster explorer URL for solana-local', async () => {
    mockRpc({
      [LOCAL.rpc.default]: {
        getLatestBlockhash: { body: { jsonrpc: '2.0', id: 1, result: BLOCKHASH_RESULT } },
        getFeeForMessage: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000 } } },
        getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 10_000_000 } } },
        sendTransaction: { body: { jsonrpc: '2.0', id: 1, result: 'LocalSignature111' } }
      }
    });

    const result = await sendSolTransfer({
      network: 'solana-local',
      from: FROM,
      to: TO,
      lamports: 1_000_000n,
      sign: realSign
    });

    expect(result.signature).toBe('LocalSignature111');
    expect(result.explorerUrl).toBe(
      'https://explorer.solana.com/tx/LocalSignature111?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899'
    );
  });

  // Regression for BUG 2 (found against a real solana-test-validator,
  // Agave 4.2.0 — see prompt/0095): the broadcast call used to hard-code
  // the RPC method name 'sendRawTransaction', which has never existed on
  // any real Solana cluster ('sendRawTransaction' is only a @solana/web3.js
  // client-side method name; the wire method is 'sendTransaction'). Every
  // mocked test above this one would already fail loudly if that regressed
  // (mockRpc throws "Unexpected RPC method" for anything not explicitly
  // stubbed) — this test makes the exact method name assertion explicit
  // rather than relying on that side effect alone. Also asserts
  // `preflightCommitment: 'confirmed'` — a second bug found in the same
  // pass: sendTransaction's own default preflightCommitment ('finalized')
  // is stricter than the 'confirmed' commitment getLatestBlockhash is
  // fetched at, which reproducibly failed real preflight simulation with
  // "Blockhash not found" even for a genuinely fresh, valid blockhash.
  it('BUG FIX regression: broadcasts via the real "sendTransaction" RPC method (not "sendRawTransaction"), at a matching preflightCommitment', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getLatestBlockhash: { body: { jsonrpc: '2.0', id: 1, result: BLOCKHASH_RESULT } },
        getFeeForMessage: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000 } } },
        getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 10_000_000 } } },
        sendTransaction: { body: { jsonrpc: '2.0', id: 1, result: 'RealMethodSig' } }
      }
    });

    const result = await sendSolTransfer({ network: 'solana-devnet', from: FROM, to: TO, lamports: 1_000_000n, sign: realSign });
    expect(result.signature).toBe('RealMethodSig');

    const broadcastCall = globalThis.fetch.mock.calls.find(([, options]) => JSON.parse(options.body).method === 'sendTransaction');
    expect(broadcastCall).toBeTruthy();
    const { params } = JSON.parse(broadcastCall[1].body);
    expect(params[1]).toMatchObject({ preflightCommitment: 'confirmed' });
  });
});

describe('getTransactionStatus', () => {
  it('reports not_found when the signature is unknown to the RPC', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getSignatureStatuses: { body: { jsonrpc: '2.0', id: 1, result: { value: [null] } } }
      }
    });

    const result = await getTransactionStatus({ network: 'solana-devnet', signature: 'SomeSig' });
    expect(result.status).toBe('not_found');
  });

  it('reports a confirmed status', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getSignatureStatuses: {
          body: { jsonrpc: '2.0', id: 1, result: { value: [{ confirmationStatus: 'confirmed', confirmations: 3, err: null }] } }
        }
      }
    });

    const result = await getTransactionStatus({ network: 'solana-devnet', signature: 'SomeSig' });
    expect(result.status).toBe('confirmed');
    expect(result.confirmations).toBe(3);
  });
});

describe('requestDevnetAirdrop', () => {
  it('succeeds on a testnet network', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        requestAirdrop: { body: { jsonrpc: '2.0', id: 1, result: 'AirdropSig333' } }
      }
    });

    const result = await requestDevnetAirdrop({ network: 'solana-devnet', address: FROM, lamports: 1_000_000_000n });
    expect(result.signature).toBe('AirdropSig333');
  });

  it('hard-rejects on mainnet', async () => {
    await expect(
      requestDevnetAirdrop({ network: 'solana', address: FROM, lamports: 1_000_000_000n })
    ).rejects.toMatchObject({ code: 'MAINNET_AIRDROP_FORBIDDEN' });
  });

  // solana-local is flagged isTestnet: true (see networks.js) specifically
  // so guards like this one — the actual backstop against ever
  // airdrop-requesting a real network — pass it through with no
  // network-specific special-casing.
  it('succeeds on solana-local too (isTestnet: true)', async () => {
    mockRpc({
      [LOCAL.rpc.default]: {
        requestAirdrop: { body: { jsonrpc: '2.0', id: 1, result: 'LocalAirdropSig444' } }
      }
    });

    const result = await requestDevnetAirdrop({ network: 'solana-local', address: FROM, lamports: 1_000_000_000n });
    expect(result.signature).toBe('LocalAirdropSig444');
  });
});

describe('getSolBalance', () => {
  it('returns the lamports balance as a bigint', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 42_000_000 } } }
      }
    });

    const balance = await getSolBalance({ network: 'solana-devnet', address: FROM });
    expect(balance).toBe(42_000_000n);
  });

  it('rejects an invalid address', async () => {
    await expect(getSolBalance({ network: 'solana-devnet', address: 'not-a-valid-address' })).rejects.toMatchObject({
      code: 'INVALID_ADDRESS'
    });
  });
});

// Regression for BUG 1 (found against a real solana-test-validator, Agave
// 4.2.0 — see prompt/0095): getBalance used to omit `commitment` entirely
// (defaulting to a stricter level than the 'confirmed' every other call in
// this file explicitly requests), and there was no general way to wait out
// the resulting confirmed-status-vs-balance-visibility race after an
// airdrop — reproduced as "Insufficient balance: ... only has 0"
// immediately after a genuinely successful, confirmed airdrop.
describe('getSolBalance — commitment consistency (BUG FIX regression)', () => {
  it('requests getBalance at commitment "confirmed", matching getLatestBlockhash/getFeeForMessage', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 42_000_000 } } }
      }
    });

    await getSolBalance({ network: 'solana-devnet', address: FROM });

    const call = globalThis.fetch.mock.calls.find(([, options]) => JSON.parse(options.body).method === 'getBalance');
    expect(call).toBeTruthy();
    const { params } = JSON.parse(call[1].body);
    expect(params[1]).toEqual({ commitment: 'confirmed' });
  });
});

describe('waitForBalanceAtLeast (BUG FIX regression)', () => {
  it('polls until the balance reaches minLamports, instead of trusting a single read right after a confirmation', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount += 1;
      // Simulates the real-world race: the first two reads still see the
      // pre-airdrop balance even though the airdrop signature already
      // reported 'confirmed' — only the third read reflects it.
      const value = callCount < 3 ? 0 : 1_000_000_000;
      return { json: async () => ({ jsonrpc: '2.0', id: 1, result: { value } }) };
    });

    const balance = await waitForBalanceAtLeast(
      { network: 'solana-devnet', address: FROM, minLamports: 1_000_000_000n },
      { timeoutMs: 5000, pollIntervalMs: 1 }
    );

    expect(balance).toBe(1_000_000_000n);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('throws a BALANCE_NOT_VISIBLE error if the balance never reaches minLamports before the timeout', async () => {
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 0 } }) }));

    await expect(
      waitForBalanceAtLeast(
        { network: 'solana-devnet', address: FROM, minLamports: 1_000_000_000n },
        { timeoutMs: 20, pollIntervalMs: 5 }
      )
    ).rejects.toMatchObject({ code: 'BALANCE_NOT_VISIBLE' });
  });
});

describe('TransactionValidationError', () => {
  it('is a real Error subclass carrying a machine-readable code', () => {
    const err = new TransactionValidationError('SOME_CODE', 'some message');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('SOME_CODE');
    expect(err.name).toBe('TransactionValidationError');
  });
});

// ---- SPL token transfer (prompt 0113) ----

const TOKEN_ACCOUNT_RESULT = (amount, decimals) => ({
  body: { jsonrpc: '2.0', id: 1, result: { value: { amount: String(amount), decimals, uiAmountString: '' } } }
});
const NO_TOKEN_ACCOUNT_ERROR = { body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid param: could not find account' } } };
const MINT_ACCOUNT_INFO = (decimals) => ({
  body: {
    jsonrpc: '2.0',
    id: 1,
    result: { value: { data: { parsed: { type: 'mint', info: { decimals } } } } }
  }
});
const ACCOUNT_EXISTS_RESULT = { body: { jsonrpc: '2.0', id: 1, result: { value: { data: ['', 'base64'], lamports: 1 } } } };
const ACCOUNT_MISSING_RESULT = { body: { jsonrpc: '2.0', id: 1, result: { value: null } } };
const RENT_EXEMPTION_RESULT = { body: { jsonrpc: '2.0', id: 1, result: 2_039_280 } };

describe('estimateSplTransfer', () => {
  it('reports no ATA rent needed when the recipient already has a token account', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getTokenAccountBalance: TOKEN_ACCOUNT_RESULT(500_000_000, 6),
        getAccountInfo: ACCOUNT_EXISTS_RESULT,
        getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 10_000_000 } } },
        getLatestBlockhash: { body: { jsonrpc: '2.0', id: 1, result: BLOCKHASH_RESULT } },
        getFeeForMessage: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000 } } }
      }
    });

    const result = await estimateSplTransfer({ network: 'solana-devnet', from: FROM, to: TO, mint: MINT, amount: '12.5' });
    expect(result.decimals).toBe(6);
    expect(result.amountRaw).toBe(12_500_000n);
    expect(result.tokenBalanceRaw).toBe(500_000_000n);
    expect(result.needsAta).toBe(false);
    expect(result.ataRent).toBe(0n);
    expect(result.fee).toBe(5000n);
  });

  it('reports the ATA rent cost honestly when the recipient has no token account yet', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getTokenAccountBalance: TOKEN_ACCOUNT_RESULT(500_000_000, 6),
        getAccountInfo: ACCOUNT_MISSING_RESULT,
        getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 10_000_000 } } },
        getLatestBlockhash: { body: { jsonrpc: '2.0', id: 1, result: BLOCKHASH_RESULT } },
        getFeeForMessage: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000 } } },
        getMinimumBalanceForRentExemption: RENT_EXEMPTION_RESULT
      }
    });

    const result = await estimateSplTransfer({ network: 'solana-devnet', from: FROM, to: TO, mint: MINT, amount: '1' });
    expect(result.needsAta).toBe(true);
    expect(result.ataRent).toBe(2_039_280n);
  });

  it('falls back to the mint account for decimals when the sender holds none of the token yet', async () => {
    // estimateSplTransfer resolves resolveSenderTokenInfo() (which itself
    // calls getAccountInfo on the MINT as its fallback) and accountExists()
    // (getAccountInfo on the recipient's ATA) concurrently via Promise.all
    // — their relative call order is not guaranteed, so this dispatches by
    // the queried address (params[0]), not by call sequence.
    globalThis.fetch = vi.fn(async (url, options) => {
      const { method, params } = JSON.parse(options.body);
      if (method === 'getTokenAccountBalance') return { json: async () => NO_TOKEN_ACCOUNT_ERROR.body };
      if (method === 'getAccountInfo') {
        const body = params[0] === MINT ? MINT_ACCOUNT_INFO(9).body : ACCOUNT_EXISTS_RESULT.body;
        return { json: async () => body };
      }
      if (method === 'getBalance') return { json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 10_000_000 } }) };
      if (method === 'getLatestBlockhash') return { json: async () => ({ jsonrpc: '2.0', id: 1, result: BLOCKHASH_RESULT }) };
      if (method === 'getFeeForMessage') return { json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 5000 } }) };
      throw new Error(`Unexpected RPC method ${method}`);
    });

    const result = await estimateSplTransfer({ network: 'solana-devnet', from: FROM, to: TO, mint: MINT, amount: '1' });
    expect(result.decimals).toBe(9);
    expect(result.tokenBalanceRaw).toBe(0n);
  });

  it('rejects a non-Solana network', async () => {
    await expect(
      estimateSplTransfer({ network: 'ethereum', from: FROM, to: TO, mint: MINT, amount: '1' })
    ).rejects.toThrow(/not a Solana network/);
  });
});

describe('sendSplTransfer', () => {
  it('sends when the recipient already has a token account (no ATA creation)', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getTokenAccountBalance: TOKEN_ACCOUNT_RESULT(500_000_000, 6),
        getAccountInfo: ACCOUNT_EXISTS_RESULT,
        getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 10_000_000 } } },
        getLatestBlockhash: { body: { jsonrpc: '2.0', id: 1, result: BLOCKHASH_RESULT } },
        getFeeForMessage: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000 } } },
        sendTransaction: { body: { jsonrpc: '2.0', id: 1, result: 'SplSig111' } }
      }
    });

    const result = await sendSplTransfer({ network: 'solana-devnet', from: FROM, to: TO, mint: MINT, amount: '12.5', sign: realSign });
    expect(result.signature).toBe('SplSig111');
    expect(result.decimals).toBe(6);
    expect(result.amountRaw).toBe(12_500_000n);
    expect(result.ataCreated).toBe(false);
    expect(result.explorerUrl).toContain('SplSig111');
  });

  it('idempotently creates the recipient ATA in the same transaction when needed (ataCreated: true)', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getTokenAccountBalance: TOKEN_ACCOUNT_RESULT(500_000_000, 6),
        getAccountInfo: ACCOUNT_MISSING_RESULT,
        getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 10_000_000_000 } } },
        getLatestBlockhash: { body: { jsonrpc: '2.0', id: 1, result: BLOCKHASH_RESULT } },
        getFeeForMessage: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000 } } },
        getMinimumBalanceForRentExemption: RENT_EXEMPTION_RESULT,
        sendTransaction: { body: { jsonrpc: '2.0', id: 1, result: 'SplSigWithAta' } }
      }
    });

    const result = await sendSplTransfer({ network: 'solana-devnet', from: FROM, to: TO, mint: MINT, amount: '1', sign: realSign });
    expect(result.ataCreated).toBe(true);
    expect(result.signature).toBe('SplSigWithAta');
  });

  it('rejects when the token balance cannot cover the amount', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getTokenAccountBalance: TOKEN_ACCOUNT_RESULT(1_000, 6), // far less than the 12.5 tokens requested
        getAccountInfo: ACCOUNT_EXISTS_RESULT,
        getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 10_000_000 } } }
      }
    });

    await expect(
      sendSplTransfer({ network: 'solana-devnet', from: FROM, to: TO, mint: MINT, amount: '12.5', sign: realSign })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_TOKEN_BALANCE' });
  });

  it('rejects when the native balance cannot cover the fee plus new-ATA rent', async () => {
    mockRpc({
      [DEVNET.rpc.default]: {
        getTokenAccountBalance: TOKEN_ACCOUNT_RESULT(500_000_000, 6),
        getAccountInfo: ACCOUNT_MISSING_RESULT,
        getBalance: { body: { jsonrpc: '2.0', id: 1, result: { value: 100 } } }, // far less than fee + rent
        getLatestBlockhash: { body: { jsonrpc: '2.0', id: 1, result: BLOCKHASH_RESULT } },
        getFeeForMessage: { body: { jsonrpc: '2.0', id: 1, result: { value: 5000 } } },
        getMinimumBalanceForRentExemption: RENT_EXEMPTION_RESULT
      }
    });

    await expect(
      sendSplTransfer({ network: 'solana-devnet', from: FROM, to: TO, mint: MINT, amount: '1', sign: realSign })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('requires a sign function', async () => {
    await expect(
      sendSplTransfer({ network: 'solana-devnet', from: FROM, to: TO, mint: MINT, amount: '1' })
    ).rejects.toMatchObject({ code: 'MISSING_SIGNER' });
  });

  it('rejects an invalid mint address', async () => {
    await expect(
      sendSplTransfer({ network: 'solana-devnet', from: FROM, to: TO, mint: 'not-a-mint', amount: '1', sign: realSign })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });
});
