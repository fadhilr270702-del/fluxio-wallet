/**
 * Native ETH transfer construction/broadcast — the EVM sibling of
 * transactionService.js (which stays Solana-only, see its own header
 * comment). Same signing architecture:
 *   Web Page -> Extension Provider -> Background/Wallet Service ->
 *   User Approval -> Secure Vault -> Signer -> Signed Transaction
 *
 * This module never imports walletService and never touches a seed,
 * mnemonic or private key. Signing is always delegated to a
 * `sign(transactionRequest) => Promise<string>` callback supplied by the
 * caller, expected to route through the real signing boundary
 * (@fluxio/crypto/signer's ethers-based evmSigner, normally reached via
 * walletService.signTransaction() after an approval step). Unlike
 * Solana's sign() (which returns a raw 64-byte ed25519 signature that
 * this module still has to attach to the transaction), evmSigner's
 * signTransaction() already returns a fully-signed, RLP-serialized raw
 * transaction hex string (ethers' Wallet.signTransaction() return shape)
 * — there's no "attach signature to message" step needed here, the
 * signed callback result is broadcast as-is.
 *
 * Not importing walletService (or a browser storage backend) the same
 * way transactionService.js doesn't is what lets this run identically
 * from apps/extension/background.js and from a plain Node script (see
 * scripts/evm-transfer-demo.mjs).
 *
 * Transaction construction here is plain JSON-RPC + BigInt arithmetic via
 * @fluxio/crypto/rpc's fetchRpcWithFallback — same convention as
 * transactionService.js/balanceService.js, no `ethers.Provider`/RPC
 * client anywhere in this codebase. `ethers` is used for exactly one
 * thing in this file: `isAddress()` to validate (and checksum-validate,
 * for mixed-case input) an EVM address — a pure, stateless check with no
 * provider/wallet/key material involved, not a boundary violation. Actual
 * signing still only ever happens inside @fluxio/crypto/signer/evmSigner.js.
 */
import { isAddress } from 'ethers';
import { fetchRpcWithFallback } from '@fluxio/crypto/rpc';
import { NETWORKS, ACCOUNT_TYPES, getEvmTipFloorWei } from '@fluxio/constants';
import { ethToWei } from '@fluxio/utils/ethAmount';

/**
 * ERC-20 TRANSFERS (prompt 0113) — estimateErc20Transfer/sendErc20Transfer
 * below. Unlike SPL's decimals (always chain-authoritative — see
 * transactionService.js's own note), tokenService.js's established EVM
 * rule is registry-trusted decimals (no free on-chain way to ask an
 * arbitrary ERC-20 for its decimals without an extra eth_call this repo
 * already avoids doubling up — see @fluxio/constants/tokens.js's header
 * comment). Consequently this file stays decimals-agnostic: it takes an
 * already-resolved `amountRaw` BigInt (smallest unit), not a human decimal
 * string + decimals — the caller (background.js, which already has the
 * registry/custom-token decimals in hand from FLUXIO_INTERNAL_GET_TOKEN_BALANCES/
 * mergeTokens) converts via @fluxio/utils/formatUnits's parseUnits() before
 * calling in, the same way it already pre-converts a native amount via
 * ethToWei() before calling sendEthTransfer. This is a deliberate
 * asymmetry with transactionService.js's SPL functions (which take a
 * human amount string and resolve decimals internally, since only the
 * chain can answer that for Solana) — each side matches its own chain's
 * established decimals-trust model instead of forcing one shared shape.
 */

/** keccak256("transfer(address,uint256)")[:4] — the standard ERC-20 transfer selector, same value on every EVM chain. */
const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';
/** keccak256("balanceOf(address)")[:4] — same selector tokenService.js's own ERC20_BALANCE_OF_SELECTOR uses; duplicated here (not cross-imported) to keep this file's only coupling to token-ness the two functions below, matching how it stays otherwise decimals/registry-agnostic (see comment above). */
const ERC20_BALANCE_OF_SELECTOR = '0x70a08231';
/**
 * eth_estimateGas returns the minimum gas an execution actually used, not
 * a safety margin — a real state change one block later (or a node's own
 * estimation slop) can push actual usage slightly higher and revert an
 * exact-estimate transaction with "out of gas". 20% headroom is a
 * standard, conservative buffer several production wallets use for this
 * exact reason; still nowhere near the native transfer's fixed 21000, and
 * still a real eth_estimateGas call underneath — not a hardcoded guess.
 */
const GAS_ESTIMATE_BUFFER_NUMERATOR = 12n;
const GAS_ESTIMATE_BUFFER_DENOMINATOR = 10n;

/** Gas used by a plain native ETH transfer (no calldata, no contract interaction) — fixed, no estimateGas call needed. */
const NATIVE_TRANSFER_GAS_LIMIT = 21000n;

/**
 * Fallback priority fee used only when a node doesn't support the
 * eth_maxPriorityFeePerGas RPC method (anvil and every public endpoint
 * used by this repo do support it, but this keeps estimateFeePerGas from
 * hard-failing against a node that doesn't). 1.5 gwei is a conservative,
 * commonly-used default tip.
 */
const FALLBACK_PRIORITY_FEE_WEI = 1_500_000_000n;

/** Thrown for any caller/input problem (invalid address, insufficient balance, wrong network, ...) — as opposed to an RPC/network failure. */
export class TransactionValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransactionValidationError';
    this.code = code;
  }
}

/**
 * Estimate the EIP-1559 fee for a native ETH transfer, without signing or
 * sending anything.
 * @param {object} params
 * @param {string} params.network - an EVM network key (e.g. 'ethereum-sepolia', 'ethereum-local').
 * @param {string} params.from - sender's 0x address (unused in the fee math itself, validated for parity with estimateSolTransfer and to fail fast on bad input).
 * @param {string} params.to - recipient's 0x address.
 * @param {string} params.amountEth - human-typed decimal ETH string (e.g. "0.01"), validated but not used in the fee math.
 * @returns {Promise<{ maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, gasLimit: bigint, maxFeeWei: bigint, chainId: number }>}
 */
export async function estimateEthTransfer({ network: networkKey, from, to, amountEth }) {
  const network = requireEvmNetwork(networkKey);
  requireValidAddress(from, 'Sender');
  requireValidAddress(to, 'Recipient');
  requirePositiveWei(amountEth);

  const { maxFeePerGas, maxPriorityFeePerGas } = await estimateFeePerGas(network);
  const gasLimit = NATIVE_TRANSFER_GAS_LIMIT;
  const maxFeeWei = maxFeePerGas * gasLimit;

  return { maxFeePerGas, maxPriorityFeePerGas, gasLimit, maxFeeWei, chainId: network.chainId };
}

/**
 * Build, sign (via the caller-supplied `sign` callback) and broadcast a
 * native ETH transfer.
 * @param {object} params
 * @param {string} params.network
 * @param {string} params.from
 * @param {string} params.to
 * @param {string} params.amountEth - human-typed decimal ETH string.
 * @param {(transactionRequest: object) => Promise<string>} params.sign -
 *   called once with a fully-populated EIP-1559 transaction request
 *   ({ type: 2, chainId, nonce, to, value, data, gasLimit, maxFeePerGas,
 *   maxPriorityFeePerGas }); must resolve with a 0x-prefixed signed raw
 *   transaction hex string — the exact shape
 *   @fluxio/crypto/signer's evmSigner.signTransaction() already returns,
 *   so no new crypto-boundary function was needed for this. An extension
 *   caller passes `(txRequest) => walletService.signTransaction(network, txRequest)`;
 *   a standalone script with its own derived signer passes
 *   `signer.signTransaction` directly (see scripts/evm-transfer-demo.mjs).
 * @returns {Promise<{ hash: string, explorerUrl: string|null }>}
 */
export async function sendEthTransfer({ network: networkKey, from, to, amountEth, sign }) {
  if (typeof sign !== 'function') {
    throw new TransactionValidationError('MISSING_SIGNER', 'sendEthTransfer requires a `sign` function.');
  }
  const network = requireEvmNetwork(networkKey);
  const fromAddress = requireValidAddress(from, 'Sender');
  const toAddress = requireValidAddress(to, 'Recipient');
  const amountWei = requirePositiveWei(amountEth);

  const [{ maxFeePerGas, maxPriorityFeePerGas }, nonce, balanceWei] = await Promise.all([
    estimateFeePerGas(network),
    getNonce(network, fromAddress),
    getEvmBalanceWei(network, fromAddress)
  ]);
  const gasLimit = NATIVE_TRANSFER_GAS_LIMIT;
  const maxFeeWei = maxFeePerGas * gasLimit;

  if (balanceWei < amountWei + maxFeeWei) {
    throw new TransactionValidationError(
      'INSUFFICIENT_BALANCE',
      `Insufficient balance: sending ${amountWei} wei plus up to ${maxFeeWei} wei in fees needs ${amountWei + maxFeeWei}, but the wallet only has ${balanceWei}.`
    );
  }

  const transactionRequest = {
    type: 2,
    chainId: network.chainId,
    nonce,
    to: toAddress,
    value: amountWei,
    data: '0x',
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas
  };

  const signedRawTx = await sign(transactionRequest);
  if (typeof signedRawTx !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signedRawTx)) {
    throw new Error('sign() must resolve to a 0x-prefixed signed raw transaction hex string.');
  }

  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_sendRawTransaction',
    params: [signedRawTx]
  });

  const hash = data.result;
  return { hash, explorerUrl: evmExplorerUrl(network, hash) };
}

/**
 * Estimate an ERC-20 token transfer: gas via a real eth_estimateGas call
 * against the actual transfer(address,uint256) calldata (NOT the fixed
 * 21000 native-transfer limit — token transfers touch contract storage
 * and routinely cost well above that), EIP-1559 fee math shared with
 * native transfers, plus the sender's current token balance (for a
 * sufficiency check the caller — background.js — performs, same division
 * of responsibility as estimateEthTransfer/the Solana estimate functions
 * above: this reports the numbers, the caller decides what "sufficient"
 * means for its response shape).
 * @param {object} params
 * @param {string} params.network
 * @param {string} params.from
 * @param {string} params.to
 * @param {string} params.tokenAddress - the ERC-20 contract address.
 * @param {bigint|string} params.amountRaw - amount in the token's smallest unit (already decimals-converted by the caller — see file header comment).
 * @returns {Promise<{
 *   tokenBalanceRaw: bigint, amountRaw: bigint, maxFeePerGas: bigint,
 *   maxPriorityFeePerGas: bigint, gasLimit: bigint, maxFeeWei: bigint,
 *   nativeBalanceWei: bigint, chainId: number
 * }>}
 */
export async function estimateErc20Transfer({ network: networkKey, from, to, tokenAddress, amountRaw }) {
  const network = requireEvmNetwork(networkKey);
  const fromAddress = requireValidAddress(from, 'Sender');
  const toAddress = requireValidAddress(to, 'Recipient');
  const contractAddress = requireValidAddress(tokenAddress, 'Token contract');
  const amountRawValue = requirePositiveTokenAmountRaw(amountRaw);

  const data = encodeErc20TransferData(toAddress, amountRawValue);
  const [{ maxFeePerGas, maxPriorityFeePerGas }, gasLimit, tokenBalanceRaw, nativeBalanceWei] = await Promise.all([
    estimateFeePerGas(network),
    estimateGasForErc20Transfer(network, fromAddress, contractAddress, data),
    fetchErc20BalanceOf(network, contractAddress, fromAddress),
    getEvmBalanceWei(network, fromAddress)
  ]);
  const maxFeeWei = maxFeePerGas * gasLimit;

  return {
    tokenBalanceRaw,
    amountRaw: amountRawValue,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    maxFeeWei,
    nativeBalanceWei,
    chainId: network.chainId
  };
}

/**
 * Build, sign (via the caller-supplied `sign` callback) and broadcast an
 * ERC-20 token transfer — `to: <token contract>`, `value: 0`,
 * `data: transfer(address,uint256)` calldata. Same signing boundary as
 * sendEthTransfer above (no new signing path): the returned
 * transactionRequest is handed to the identical
 * `(transactionRequest) => Promise<string>` sign callback.
 * @param {object} params
 * @param {string} params.network
 * @param {string} params.from
 * @param {string} params.to
 * @param {string} params.tokenAddress
 * @param {bigint|string} params.amountRaw
 * @param {(transactionRequest: object) => Promise<string>} params.sign
 * @returns {Promise<{ hash: string, explorerUrl: string|null, amountRaw: bigint }>}
 */
export async function sendErc20Transfer({ network: networkKey, from, to, tokenAddress, amountRaw, sign }) {
  if (typeof sign !== 'function') {
    throw new TransactionValidationError('MISSING_SIGNER', 'sendErc20Transfer requires a `sign` function.');
  }
  const network = requireEvmNetwork(networkKey);
  const fromAddress = requireValidAddress(from, 'Sender');
  const toAddress = requireValidAddress(to, 'Recipient');
  const contractAddress = requireValidAddress(tokenAddress, 'Token contract');
  const amountRawValue = requirePositiveTokenAmountRaw(amountRaw);

  const data = encodeErc20TransferData(toAddress, amountRawValue);

  const [{ maxFeePerGas, maxPriorityFeePerGas }, gasLimit, nonce, tokenBalanceRaw, nativeBalanceWei] = await Promise.all([
    estimateFeePerGas(network),
    estimateGasForErc20Transfer(network, fromAddress, contractAddress, data),
    getNonce(network, fromAddress),
    fetchErc20BalanceOf(network, contractAddress, fromAddress),
    getEvmBalanceWei(network, fromAddress)
  ]);
  const maxFeeWei = maxFeePerGas * gasLimit;

  if (tokenBalanceRaw < amountRawValue) {
    throw new TransactionValidationError(
      'INSUFFICIENT_TOKEN_BALANCE',
      `Insufficient token balance: sending ${amountRawValue} raw units needs at least that much, but the wallet only holds ${tokenBalanceRaw}.`
    );
  }
  // Token balance is validated above; the fee itself is always paid in the
  // native coin, never the token — this is that separate check (see file
  // header comment on why the two currencies never mix in this file's math).
  if (nativeBalanceWei < maxFeeWei) {
    throw new TransactionValidationError(
      'INSUFFICIENT_BALANCE',
      `Insufficient native balance for gas: this token transfer needs up to ${maxFeeWei} wei in fees, but the wallet only has ${nativeBalanceWei}.`
    );
  }

  const transactionRequest = {
    type: 2,
    chainId: network.chainId,
    nonce,
    to: contractAddress,
    value: 0n,
    data,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas
  };

  const signedRawTx = await sign(transactionRequest);
  if (typeof signedRawTx !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signedRawTx)) {
    throw new Error('sign() must resolve to a 0x-prefixed signed raw transaction hex string.');
  }

  const result = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_sendRawTransaction',
    params: [signedRawTx]
  });

  const hash = result.result;
  return { hash, explorerUrl: evmExplorerUrl(network, hash), amountRaw: amountRawValue };
}

/**
 * Poll a transaction's confirmation status via its receipt. A receipt
 * only exists once the transaction is mined — there's no separate
 * "processed but not yet mined" state the way Solana's
 * getSignatureStatuses reports, so `not_found` covers both "still
 * pending" and "unknown hash", same ambiguity Solana's own not_found
 * already has.
 * @param {object} params
 * @param {string} params.network
 * @param {string} params.hash
 * @returns {Promise<{ status: 'not_found'|'finalized'|'failed', confirmations: null, err: object|null }>}
 */
export async function getEvmTransactionStatus({ network: networkKey, hash }) {
  const network = requireEvmNetwork(networkKey);
  if (typeof hash !== 'string' || !hash) {
    throw new TransactionValidationError('INVALID_HASH', 'A transaction hash is required.');
  }

  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getTransactionReceipt',
    params: [hash]
  });

  const receipt = data.result;
  if (!receipt) {
    return { status: 'not_found', confirmations: null, err: null };
  }
  const success = receipt.status === '0x1';
  return {
    status: success ? 'finalized' : 'failed',
    confirmations: null,
    err: success ? null : { reverted: true, transactionHash: hash }
  };
}

/**
 * Read-only wei balance for an EVM network. A thin public wrapper around
 * the same lookup sendEthTransfer uses internally to check sufficiency —
 * exposed so callers (background.js's estimate handler, the demo script)
 * don't have to duplicate an RPC call this file already makes.
 * @param {object} params
 * @param {string} params.network
 * @param {string} params.address
 * @returns {Promise<bigint>}
 */
export async function getEvmBalance({ network: networkKey, address }) {
  const network = requireEvmNetwork(networkKey);
  const validAddress = requireValidAddress(address, 'Address');
  return getEvmBalanceWei(network, validAddress);
}

// ---- internals ----

function requireEvmNetwork(networkKey) {
  const network = NETWORKS[networkKey];
  if (!network) {
    throw new TransactionValidationError('UNKNOWN_NETWORK', `Unknown network: ${networkKey}`);
  }
  if (network.accountType !== ACCOUNT_TYPES.EVM) {
    throw new TransactionValidationError(
      'UNSUPPORTED_NETWORK',
      `${network.name} is not an EVM network — ETH transfers are only supported on EVM-compatible networks.`
    );
  }
  return network;
}

function requireValidAddress(address, label) {
  // ethers' isAddress() accepts any-case hex, and specifically validates
  // EIP-55 checksum casing when the input is mixed-case — exactly the
  // "checksum kalau mixed-case" behavior this feature needs, with no
  // hand-rolled keccak256 required.
  if (typeof address !== 'string' || !isAddress(address)) {
    throw new TransactionValidationError('INVALID_ADDRESS', `${label} address is not a valid EVM address.`);
  }
  return address;
}

function requirePositiveWei(amountEth) {
  let value;
  try {
    value = ethToWei(amountEth);
  } catch (err) {
    throw new TransactionValidationError('INVALID_AMOUNT', err.message);
  }
  if (value <= 0n) {
    throw new TransactionValidationError('INVALID_AMOUNT', 'Amount must be greater than zero.');
  }
  return value;
}

/** Unlike requirePositiveWei above, this takes an already-raw amount (see file header comment — decimals conversion happens in the caller, not here) — just validates it's a positive whole number of the token's smallest unit. */
function requirePositiveTokenAmountRaw(amountRaw) {
  let value;
  try {
    value = BigInt(amountRaw);
  } catch {
    throw new TransactionValidationError('INVALID_AMOUNT', 'Amount must be a whole number of raw token units.');
  }
  if (value <= 0n) {
    throw new TransactionValidationError('INVALID_AMOUNT', 'Amount must be greater than zero.');
  }
  return value;
}

/** ABI-encodes transfer(address,uint256)'s calldata: selector + 32-byte-padded recipient + 32-byte-padded raw amount. `toAddress` is expected already-validated (checksum-checked by requireValidAddress upstream). */
function encodeErc20TransferData(toAddress, amountRaw) {
  const paddedTo = toAddress.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const paddedAmount = amountRaw.toString(16).padStart(64, '0');
  return `${ERC20_TRANSFER_SELECTOR}${paddedTo}${paddedAmount}`;
}

/** Real eth_estimateGas against the actual transfer calldata, with GAS_ESTIMATE_BUFFER headroom applied (see that constant's own comment) — NOT the native transfer's fixed 21000n, per this feature's explicit requirement that token-transfer gas never be hardcoded. */
async function estimateGasForErc20Transfer(network, fromAddress, contractAddress, data) {
  const result = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_estimateGas',
    params: [{ from: fromAddress, to: contractAddress, data, value: '0x0' }]
  });
  const raw = BigInt(result.result);
  return (raw * GAS_ESTIMATE_BUFFER_NUMERATOR) / GAS_ESTIMATE_BUFFER_DENOMINATOR;
}

/** One eth_call balanceOf(address) — same selector/response-shape reasoning as tokenService.js's own fetchErc20Balance (an address with no contract, or a dead one, returns empty "0x" data rather than reverting, treated as 0n here too). Duplicated rather than imported — see file header comment. */
async function fetchErc20BalanceOf(network, contractAddress, ownerAddress) {
  const paddedOwner = ownerAddress.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: contractAddress, data: `${ERC20_BALANCE_OF_SELECTOR}${paddedOwner}` }, 'latest']
  });
  if (!data.result || data.result === '0x') {
    return 0n;
  }
  return BigInt(data.result);
}

/**
 * baseFee (from the latest block) + a priority fee (eth_maxPriorityFeePerGas,
 * falling back to a conservative default if the node doesn't support that
 * method). maxFeePerGas = 2x baseFee + priority fee — a standard buffer
 * against the base fee rising in the next block or two, the same
 * heuristic most wallets use.
 */
async function estimateFeePerGas(network) {
  const [blockResult, priorityFeeResult] = await Promise.allSettled([
    fetchRpcWithFallback(network, {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBlockByNumber',
      params: ['latest', false]
    }),
    fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'eth_maxPriorityFeePerGas', params: [] })
  ]);

  if (blockResult.status !== 'fulfilled') {
    throw blockResult.reason instanceof Error ? blockResult.reason : new Error('Could not fetch the latest block.');
  }
  const baseFeeHex = blockResult.value.result?.baseFeePerGas;
  if (!baseFeeHex) {
    throw new Error(`${network.name} did not report a base fee — is it EIP-1559 compatible?`);
  }
  const baseFee = BigInt(baseFeeHex);

  const endpointTip =
    priorityFeeResult.status === 'fulfilled' && priorityFeeResult.value.result
      ? BigInt(priorityFeeResult.value.result)
      : FALLBACK_PRIORITY_FEE_WEI;
  // Tip floor (prompt 0231): same rule as swap's getEvmFeePerGas — a public
  // endpoint answering ~0 would otherwise sign a tip 0 Send, and a Send has
  // no re broadcast loop or expiry verdict to recover a hung transaction.
  // estimate* and send* both come through here, so the fee shown on the
  // Send screen and the fee actually signed follow the same floor.
  const tipFloorWei = getEvmTipFloorWei(network.key);
  const maxPriorityFeePerGas = endpointTip < tipFloorWei ? tipFloorWei : endpointTip;

  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

async function getNonce(network, address) {
  // 'pending' (not 'latest') so a transaction queued right behind another
  // still-pending one from the same sender gets a correct, non-colliding
  // nonce — same reasoning most wallets use for the next-nonce lookup.
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getTransactionCount',
    params: [address, 'pending']
  });
  return Number(BigInt(data.result));
}

async function getEvmBalanceWei(network, address) {
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getBalance',
    params: [address, 'latest']
  });
  return BigInt(data.result);
}

/**
 * Exported (not just used internally by sendEthTransfer above) so
 * background.js's FLUXIO_INTERNAL_GET_HISTORY handler can build the
 * exact same explorer link (or `null`, for a network with no explorer —
 * see below) for a history entry that a fresh Send always did, without a
 * second implementation of this network's explorer-URL shape.
 */
export function evmExplorerUrl(network, hash) {
  // ethereum-local (anvil) has no explorer at all (see networks.js) — a
  // null explorer must produce a null URL, not a link to a real
  // Etherscan-family domain that will never resolve a local tx hash.
  if (!network.explorer) {
    return null;
  }
  return `${network.explorer.url}/tx/${hash}`;
}
