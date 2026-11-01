import { describe, it, expect, afterEach, vi } from 'vitest';
import { Wallet, Transaction } from 'ethers';
import {
  estimateEthTransfer,
  sendEthTransfer,
  getEvmTransactionStatus,
  getEvmBalance,
  estimateErc20Transfer,
  sendErc20Transfer,
  TransactionValidationError
} from '../evmTransactionService.js';
import { NETWORKS } from '@fluxio/constants';

// A real (throwaway, test-only) secp256k1 wallet — signTransaction() below
// performs a real ECDSA signature + RLP serialization, so sendEthTransfer's
// success-path tests need a `sign` callback that actually signs the exact
// transaction request it's handed, not an arbitrary hex string.
const SENDER_WALLET = Wallet.createRandom();
const FROM = SENDER_WALLET.address;
const TO = Wallet.createRandom().address;
const TOKEN_CONTRACT = Wallet.createRandom().address;
const realSign = async (transactionRequest) => SENDER_WALLET.signTransaction(transactionRequest);

const SEPOLIA = NETWORKS['ethereum-sepolia'];
const LOCAL = NETWORKS['ethereum-local'];
const BASE_FEE = 1_000_000_000n; // 1 gwei
const PRIORITY_FEE = 1_500_000_000n; // 1.5 gwei
const EXPECTED_MAX_FEE_PER_GAS = BASE_FEE * 2n + PRIORITY_FEE;
const BLOCK_RESULT = { baseFeePerGas: `0x${BASE_FEE.toString(16)}` };
const PRIORITY_FEE_RESULT = `0x${PRIORITY_FEE.toString(16)}`;

/**
 * Installs a fetch mock keyed by exact endpoint URL, then by JSON-RPC
 * `method` within that URL's responses — mirrors transactionService.test.js's
 * mockRpc helper, since a single sendEthTransfer call touches several
 * different RPC methods against the same endpoint.
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

function feeMocks(overrides = {}) {
  return {
    eth_getBlockByNumber: { body: { jsonrpc: '2.0', id: 1, result: BLOCK_RESULT } },
    eth_maxPriorityFeePerGas: { body: { jsonrpc: '2.0', id: 1, result: PRIORITY_FEE_RESULT } },
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('estimateEthTransfer', () => {
  it('returns maxFeePerGas = 2x baseFee + priority fee, and a fixed 21000 gas limit', async () => {
    mockRpc({ [SEPOLIA.rpc.default]: feeMocks() });

    const result = await estimateEthTransfer({ network: 'ethereum-sepolia', from: FROM, to: TO, amountEth: '0.01' });
    expect(result.maxPriorityFeePerGas).toBe(PRIORITY_FEE);
    expect(result.maxFeePerGas).toBe(EXPECTED_MAX_FEE_PER_GAS);
    expect(result.gasLimit).toBe(21000n);
    expect(result.maxFeeWei).toBe(EXPECTED_MAX_FEE_PER_GAS * 21000n);
    expect(result.chainId).toBe(SEPOLIA.chainId);
  });

  it('falls back to a default priority fee when eth_maxPriorityFeePerGas is unsupported', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: feeMocks({
        eth_maxPriorityFeePerGas: { reject: 'the method eth_maxPriorityFeePerGas does not exist' }
      })
    });

    const result = await estimateEthTransfer({ network: 'ethereum-sepolia', from: FROM, to: TO, amountEth: '0.01' });
    expect(result.maxPriorityFeePerGas).toBe(1_500_000_000n);
    expect(result.maxFeePerGas).toBe(BASE_FEE * 2n + 1_500_000_000n);
  });

  it('rejects a non-EVM network', async () => {
    await expect(
      estimateEthTransfer({ network: 'solana-devnet', from: FROM, to: TO, amountEth: '0.01' })
    ).rejects.toThrow(/not an EVM network/);
  });

  it('rejects an invalid recipient address', async () => {
    await expect(
      estimateEthTransfer({ network: 'ethereum-sepolia', from: FROM, to: 'not-an-address', amountEth: '0.01' })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });

  it('rejects a bad EIP-55 checksum on a mixed-case address', async () => {
    const wrongChecksum = TO.slice(0, -1) + (TO.slice(-1) === 'a' ? 'A' : 'a');
    await expect(
      estimateEthTransfer({ network: 'ethereum-sepolia', from: FROM, to: wrongChecksum, amountEth: '0.01' })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });

  it('rejects a zero or negative amount', async () => {
    await expect(
      estimateEthTransfer({ network: 'ethereum-sepolia', from: FROM, to: TO, amountEth: '0' })
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });
});

describe('sendEthTransfer', () => {
  it('builds an EIP-1559 tx, signs it (via the injected sign callback) and broadcasts it', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: {
        ...feeMocks(),
        eth_getTransactionCount: { body: { jsonrpc: '2.0', id: 1, result: '0x5' } },
        eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: `0x${(10n ** 18n).toString(16)}` } },
        eth_sendRawTransaction: { body: { jsonrpc: '2.0', id: 1, result: '0xFakeHash111' } }
      }
    });

    const sign = vi.fn(async (transactionRequest) => {
      expect(transactionRequest).toMatchObject({
        type: 2,
        chainId: SEPOLIA.chainId,
        nonce: 5,
        to: TO,
        data: '0x',
        gasLimit: 21000n
      });
      expect(transactionRequest.value).toBe(10_000_000_000_000_000n); // 0.01 ETH
      return realSign(transactionRequest);
    });

    const result = await sendEthTransfer({
      network: 'ethereum-sepolia',
      from: FROM,
      to: TO,
      amountEth: '0.01',
      sign
    });

    expect(sign).toHaveBeenCalledTimes(1);
    expect(result.hash).toBe('0xFakeHash111');
    expect(result.explorerUrl).toBe('https://sepolia.etherscan.io/tx/0xFakeHash111');
  });

  it('returns a null explorerUrl for a network with no explorer (ethereum-local)', async () => {
    mockRpc({
      [LOCAL.rpc.default]: {
        ...feeMocks(),
        eth_getTransactionCount: { body: { jsonrpc: '2.0', id: 1, result: '0x0' } },
        eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: `0x${(10n ** 18n).toString(16)}` } },
        eth_sendRawTransaction: { body: { jsonrpc: '2.0', id: 1, result: '0xLocalHash111' } }
      }
    });

    const result = await sendEthTransfer({ network: 'ethereum-local', from: FROM, to: TO, amountEth: '0.01', sign: realSign });
    expect(result.hash).toBe('0xLocalHash111');
    expect(result.explorerUrl).toBeNull();
  });

  it('produces a signed raw tx that round-trips through ethers Transaction.from (real serialization/signature check)', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: {
        ...feeMocks(),
        eth_getTransactionCount: { body: { jsonrpc: '2.0', id: 1, result: '0x0' } },
        eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: `0x${(10n ** 18n).toString(16)}` } },
        eth_sendRawTransaction: { body: { jsonrpc: '2.0', id: 1, result: '0xRoundTripHash' } }
      }
    });

    let capturedRawTx;
    const sign = async (transactionRequest) => {
      capturedRawTx = await realSign(transactionRequest);
      return capturedRawTx;
    };

    await sendEthTransfer({ network: 'ethereum-sepolia', from: FROM, to: TO, amountEth: '0.02', sign });

    const parsed = Transaction.from(capturedRawTx);
    expect(parsed.from).toBe(FROM);
    expect(parsed.to).toBe(TO);
    expect(parsed.value).toBe(20_000_000_000_000_000n);
    expect(parsed.chainId).toBe(BigInt(SEPOLIA.chainId));
    expect(parsed.type).toBe(2);
  });

  it('rejects an invalid recipient address', async () => {
    await expect(
      sendEthTransfer({ network: 'ethereum-sepolia', from: FROM, to: 'not-an-address', amountEth: '0.01', sign: vi.fn() })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });

  it('rejects when the sender balance cannot cover amount + max fee', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: {
        ...feeMocks(),
        eth_getTransactionCount: { body: { jsonrpc: '2.0', id: 1, result: '0x0' } },
        eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } } // essentially nothing
      }
    });

    await expect(
      sendEthTransfer({ network: 'ethereum-sepolia', from: FROM, to: TO, amountEth: '0.01', sign: vi.fn() })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('requires a sign function', async () => {
    await expect(
      sendEthTransfer({ network: 'ethereum-sepolia', from: FROM, to: TO, amountEth: '0.01' })
    ).rejects.toMatchObject({ code: 'MISSING_SIGNER' });
  });

  it('rejects a non-EVM network', async () => {
    await expect(
      sendEthTransfer({ network: 'solana-devnet', from: FROM, to: TO, amountEth: '0.01', sign: vi.fn() })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_NETWORK' });
  });

  it('rejects a sign() result that is not a 0x-prefixed hex string', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: {
        ...feeMocks(),
        eth_getTransactionCount: { body: { jsonrpc: '2.0', id: 1, result: '0x0' } },
        eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: `0x${(10n ** 18n).toString(16)}` } }
      }
    });

    await expect(
      sendEthTransfer({ network: 'ethereum-sepolia', from: FROM, to: TO, amountEth: '0.01', sign: async () => 'not-hex' })
    ).rejects.toThrow(/0x-prefixed signed raw transaction/);
  });
});

describe('getEvmTransactionStatus', () => {
  it('reports not_found when there is no receipt yet (still pending, or unknown hash)', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: { eth_getTransactionReceipt: { body: { jsonrpc: '2.0', id: 1, result: null } } }
    });

    const result = await getEvmTransactionStatus({ network: 'ethereum-sepolia', hash: '0xSomeHash' });
    expect(result).toEqual({ status: 'not_found', confirmations: null, err: null });
  });

  it('reports finalized on a status 0x1 receipt', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: {
        eth_getTransactionReceipt: { body: { jsonrpc: '2.0', id: 1, result: { status: '0x1', blockNumber: '0x10' } } }
      }
    });

    const result = await getEvmTransactionStatus({ network: 'ethereum-sepolia', hash: '0xSomeHash' });
    expect(result.status).toBe('finalized');
    expect(result.err).toBeNull();
  });

  it('reports failed and a non-null err on a status 0x0 (reverted) receipt — distinguishes revert from success', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: {
        eth_getTransactionReceipt: { body: { jsonrpc: '2.0', id: 1, result: { status: '0x0', blockNumber: '0x10' } } }
      }
    });

    const result = await getEvmTransactionStatus({ network: 'ethereum-sepolia', hash: '0xSomeHash' });
    expect(result.status).toBe('failed');
    expect(result.err).toMatchObject({ reverted: true });
  });
});

describe('getEvmBalance', () => {
  it('returns the wei balance as a bigint, decoded from a hex string', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: { eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: `0x${(42n * 10n ** 15n).toString(16)}` } } }
    });

    const balance = await getEvmBalance({ network: 'ethereum-sepolia', address: FROM });
    expect(balance).toBe(42_000_000_000_000_000n);
  });

  it('rejects an invalid address', async () => {
    await expect(getEvmBalance({ network: 'ethereum-sepolia', address: 'not-an-address' })).rejects.toMatchObject({
      code: 'INVALID_ADDRESS'
    });
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

// ---- ERC-20 token transfer (prompt 0113) ----

const GAS_ESTIMATE_RESULT = { body: { jsonrpc: '2.0', id: 1, result: '0x9c40' } }; // 40000 raw — real transfer() gas is well above the fixed 21000n native limit
const EXPECTED_GAS_LIMIT = (40000n * 12n) / 10n; // +20% headroom
const tokenBalanceResult = (amountRaw) => ({ body: { jsonrpc: '2.0', id: 1, result: `0x${amountRaw.toString(16)}` } });

describe('estimateErc20Transfer', () => {
  it('estimates gas via a real eth_estimateGas call against the transfer(address,uint256) calldata (not the fixed 21000n native limit)', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: {
        ...feeMocks(),
        eth_estimateGas: GAS_ESTIMATE_RESULT,
        eth_call: tokenBalanceResult(1_000_000_000n),
        eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: `0x${(10n ** 18n).toString(16)}` } }
      }
    });

    const result = await estimateErc20Transfer({
      network: 'ethereum-sepolia',
      from: FROM,
      to: TO,
      tokenAddress: TOKEN_CONTRACT,
      amountRaw: 500_000n
    });
    expect(result.gasLimit).toBe(EXPECTED_GAS_LIMIT);
    expect(result.gasLimit).toBeGreaterThan(21000n);
    expect(result.tokenBalanceRaw).toBe(1_000_000_000n);
    expect(result.amountRaw).toBe(500_000n);

    const estimateGasCall = globalThis.fetch.mock.calls.find(([, options]) => JSON.parse(options.body).method === 'eth_estimateGas');
    const { params } = JSON.parse(estimateGasCall[1].body);
    expect(params[0].to).toBe(TOKEN_CONTRACT);
    expect(params[0].data.startsWith('0xa9059cbb')).toBe(true);
    expect(params[0].value).toBe('0x0');
  });

  // A raw token amount comfortably above Number.MAX_SAFE_INTEGER once
  // expressed in the smallest unit — proves the amount survives end to end
  // as a BigInt, never silently corrupted by a Number-precision round trip
  // (same concern formatUnits.js's own header comment documents for wei).
  it('handles a raw amount above Number.MAX_SAFE_INTEGER without precision loss', async () => {
    const hugeAmount = 123_456_789_012_345_678_901_234n;
    mockRpc({
      [SEPOLIA.rpc.default]: {
        ...feeMocks(),
        eth_estimateGas: GAS_ESTIMATE_RESULT,
        eth_call: tokenBalanceResult(hugeAmount * 2n),
        eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: `0x${(10n ** 18n).toString(16)}` } }
      }
    });

    const result = await estimateErc20Transfer({
      network: 'ethereum-sepolia',
      from: FROM,
      to: TO,
      tokenAddress: TOKEN_CONTRACT,
      amountRaw: hugeAmount
    });
    expect(result.amountRaw).toBe(hugeAmount);
    expect(Number.isSafeInteger(Number(hugeAmount))).toBe(false); // confirms this amount really does exceed safe-integer precision
    expect(result.tokenBalanceRaw).toBe(hugeAmount * 2n);
  });

  it('rejects a zero or negative raw amount', async () => {
    await expect(
      estimateErc20Transfer({ network: 'ethereum-sepolia', from: FROM, to: TO, tokenAddress: TOKEN_CONTRACT, amountRaw: 0n })
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  it('rejects an invalid token contract address', async () => {
    await expect(
      estimateErc20Transfer({ network: 'ethereum-sepolia', from: FROM, to: TO, tokenAddress: 'not-an-address', amountRaw: 1n })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });
});

describe('sendErc20Transfer', () => {
  it('builds and broadcasts a signed ERC-20 transfer, value=0, real transfer(address,uint256) calldata', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: {
        ...feeMocks(),
        eth_estimateGas: GAS_ESTIMATE_RESULT,
        eth_call: tokenBalanceResult(1_000_000_000n),
        eth_getTransactionCount: { body: { jsonrpc: '2.0', id: 1, result: '0x3' } },
        eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: `0x${(10n ** 18n).toString(16)}` } },
        eth_sendRawTransaction: { body: { jsonrpc: '2.0', id: 1, result: '0xErc20Hash111' } }
      }
    });

    const sign = vi.fn(async (transactionRequest) => {
      expect(transactionRequest.to).toBe(TOKEN_CONTRACT);
      expect(transactionRequest.value).toBe(0n);
      expect(transactionRequest.data.startsWith('0xa9059cbb')).toBe(true);
      return realSign(transactionRequest);
    });

    const result = await sendErc20Transfer({
      network: 'ethereum-sepolia',
      from: FROM,
      to: TO,
      tokenAddress: TOKEN_CONTRACT,
      amountRaw: 500_000n,
      sign
    });

    expect(sign).toHaveBeenCalledTimes(1);
    expect(result.hash).toBe('0xErc20Hash111');
    expect(result.explorerUrl).toBe('https://sepolia.etherscan.io/tx/0xErc20Hash111');
    expect(result.amountRaw).toBe(500_000n);
  });

  it('rejects when the token balance cannot cover the amount (checked via tokenService-equivalent balanceOf, before signing)', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: {
        ...feeMocks(),
        eth_estimateGas: GAS_ESTIMATE_RESULT,
        eth_call: tokenBalanceResult(100n), // far less than the 500_000n requested
        eth_getTransactionCount: { body: { jsonrpc: '2.0', id: 1, result: '0x0' } },
        eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: `0x${(10n ** 18n).toString(16)}` } }
      }
    });

    await expect(
      sendErc20Transfer({ network: 'ethereum-sepolia', from: FROM, to: TO, tokenAddress: TOKEN_CONTRACT, amountRaw: 500_000n, sign: realSign })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_TOKEN_BALANCE' });
  });

  it('rejects when the native balance cannot cover gas — token balance itself is never spent on fees', async () => {
    mockRpc({
      [SEPOLIA.rpc.default]: {
        ...feeMocks(),
        eth_estimateGas: GAS_ESTIMATE_RESULT,
        eth_call: tokenBalanceResult(1_000_000_000n), // plenty of token balance
        eth_getTransactionCount: { body: { jsonrpc: '2.0', id: 1, result: '0x0' } },
        eth_getBalance: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } } // essentially no native balance
      }
    });

    await expect(
      sendErc20Transfer({ network: 'ethereum-sepolia', from: FROM, to: TO, tokenAddress: TOKEN_CONTRACT, amountRaw: 500_000n, sign: realSign })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('requires a sign function', async () => {
    await expect(
      sendErc20Transfer({ network: 'ethereum-sepolia', from: FROM, to: TO, tokenAddress: TOKEN_CONTRACT, amountRaw: 500_000n })
    ).rejects.toMatchObject({ code: 'MISSING_SIGNER' });
  });

  it('rejects a non-EVM network', async () => {
    await expect(
      sendErc20Transfer({ network: 'solana-devnet', from: FROM, to: TO, tokenAddress: TOKEN_CONTRACT, amountRaw: 1n, sign: vi.fn() })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_NETWORK' });
  });
});

describe('EVM tip floor on the Send path (prompt 0231) — same rule as swap, fixtures from the 22 Oktober measurement', () => {
  it('ethereum: the real near zero endpoint tip (3.839 wei) gets the 1e8 floor, so the shown fee = the signed fee basis', async () => {
    mockRpc({
      [NETWORKS.ethereum.rpc.default]: {
        eth_getBlockByNumber: { body: { jsonrpc: '2.0', id: 1, result: { baseFeePerGas: '0xc7e3017' } } }, // 209.596.439
        eth_maxPriorityFeePerGas: { body: { jsonrpc: '2.0', id: 1, result: '0xeff' } } // 3.839 — measured
      }
    });
    const result = await estimateEthTransfer({ network: 'ethereum', from: FROM, to: TO, amountEth: '0.001' });
    expect(result.maxPriorityFeePerGas).toBe(100000000n);
    expect(result.maxFeePerGas).toBe(209596439n * 2n + 100000000n);
  });

  it('base: an endpoint answering tip 0x0 gets the 1e6 floor (maxFee 11e6, the number every real Base tx signed)', async () => {
    mockRpc({
      [NETWORKS.base.rpc.default]: {
        eth_getBlockByNumber: { body: { jsonrpc: '2.0', id: 1, result: { baseFeePerGas: '0x4c4b40' } } },
        eth_maxPriorityFeePerGas: { body: { jsonrpc: '2.0', id: 1, result: '0x0' } }
      }
    });
    const result = await estimateEthTransfer({ network: 'base', from: FROM, to: TO, amountEth: '0.0001' });
    expect(result.maxPriorityFeePerGas).toBe(1000000n);
    expect(result.maxFeePerGas).toBe(11000000n);
  });

  it('bnb: tip 0x0 gets the 5e7 floor and, with the permanent baseFee 0, the floor IS the whole fee', async () => {
    mockRpc({
      [NETWORKS.bnb.rpc.default]: {
        eth_getBlockByNumber: { body: { jsonrpc: '2.0', id: 1, result: { baseFeePerGas: '0x0' } } },
        eth_maxPriorityFeePerGas: { body: { jsonrpc: '2.0', id: 1, result: '0x0' } }
      }
    });
    const result = await estimateEthTransfer({ network: 'bnb', from: FROM, to: TO, amountEth: '0.0001' });
    expect(result.maxPriorityFeePerGas).toBe(50000000n);
    expect(result.maxFeePerGas).toBe(50000000n);
  });

  it('an endpoint tip above the floor stays untouched on Send too (the long standing sepolia fixture: 1.5 gwei > the 1e6 sepolia floor)', async () => {
    mockRpc({ [SEPOLIA.rpc.default]: feeMocks() });
    const result = await estimateEthTransfer({ network: 'ethereum-sepolia', from: FROM, to: TO, amountEth: '0.01' });
    expect(result.maxPriorityFeePerGas).toBe(PRIORITY_FEE);
    expect(result.maxFeePerGas).toBe(EXPECTED_MAX_FEE_PER_GAS);
  });
});
