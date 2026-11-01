/**
 * Native SOL transfer construction/broadcast — the "Signer -> Signed
 * Transaction" tail end of the signing architecture described in
 * walletService.js, plus the RPC calls needed to build and confirm it.
 *
 * @solana/web3.js is used ONLY for transaction construction/serialization
 * (SystemProgram.transfer, message compilation, Transaction.serialize) —
 * never for signing. This module never touches a web3.js `Keypair` and
 * never calls `Transaction.sign()`. Signing is always delegated to a
 * `sign(messageBytes) => Promise<Uint8Array>` callback supplied by the
 * caller, which is expected to route through the real signing boundary
 * (@fluxio/crypto/signer's tweetnacl-based solanaSigner, normally reached
 * via walletService.signTransaction() after an approval step) — this
 * module never sees a seed, mnemonic, or secret key. Injecting the signer
 * this way (rather than importing walletService directly) also means this
 * module has no dependency on a browser storage backend, so it works the
 * same from apps/extension/background.js and from a plain Node script
 * (see scripts/devnet-transfer-demo.mjs) — @fluxio/crypto/storage requires
 * chrome.storage.local or localStorage, neither of which exist in Node.
 *
 * EVM transfers are out of scope for this phase (see CLAUDE.md) — every
 * export here is Solana-only, and requireSolanaNetwork() rejects any other
 * network up front.
 *
 * SPL TOKEN TRANSFERS (prompt 0113) — estimateSplTransfer/sendSplTransfer
 * below, added to this file rather than a new module: unlike
 * historyService.js (which genuinely spans both chains + merge logic and
 * so earned its own module), an SPL send is single-chain and shares
 * extensive internals with the native-SOL functions above it —
 * requireSolanaNetwork/requireValidAddress, getLatestBlockhash,
 * getFeeForMessage, getSolBalanceLamports, solanaExplorerUrl — so
 * extending this file avoids duplicating all of that into a sibling.
 *
 * DEPENDENCY DECISION (explicitly flagged by the prompt — reported, not
 * decided silently): the SPL Token `TransferChecked` instruction and the
 * Associated-Token-Account program's `CreateIdempotent` instruction are
 * constructed BY HAND below via bare @solana/web3.js `TransactionInstruction`
 * — @solana/spl-token (already a devDependency, used only by
 * splTokenAdmin.js's Node-only demo/admin helpers) is NOT added to this
 * package's runtime dependencies. This was verified, not assumed: a
 * throwaway script byte-compared this file's hand-rolled instructions
 * (ATA address derivation, TransferChecked's data layout, CreateIdempotent's
 * data layout, program IDs, and every account key's pubkey/signer/writable
 * flags) against @solana/spl-token's own instruction-builder functions
 * (createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction,
 * getAssociatedTokenAddressSync) — every single field matched exactly,
 * confirming the manual construction is correct. This keeps
 * background.bundle.js's size unaffected by this feature (see prompt
 * 0113's own commit report for the before/after bundle size) — the
 * documented, well-specified instruction layouts (both are stable,
 * unchanged since SPL Token's original release) made this the right
 * trade-off here; a more complex/evolving program would warrant
 * re-litigating this decision rather than assuming it always holds.
 *
 * SPL decimals are always read from the CHAIN, per @fluxio/services/
 * tokenService.js's own established Solana rule (never trusted from the
 * registry/custom-token list for Solana, unlike EVM) — see
 * resolveSenderTokenInfo() below for exactly where from (the sender's own
 * token account when it exists, the mint account itself as a fallback
 * when the sender holds none of the token yet).
 */
import { Transaction, SystemProgram, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { fetchRpcWithFallback } from '@fluxio/crypto/rpc';
import { NETWORKS, ACCOUNT_TYPES } from '@fluxio/constants';
import { parseUnits } from '@fluxio/utils/formatUnits';

/** SPL Token program — see this file's header comment for why this and every other program ID below is hand-rolled rather than imported from @solana/spl-token. */
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** Token-2022's program id (prompt 0205) — an ATA's derivation seeds include the mint's OWN token program, so a Token-2022 mint's ATA lives at a different address than the classic derivation would claim. Verified live: Jupiter's verified list carries Token-2022 mints (e.g. PYUSD), each entry's `tokenProgram` naming this id. */
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
/** Associated Token Account program — derives/creates the standard "one deterministic token account per (owner, mint)" address every wallet (including this one) expects a recipient to use. */
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
/** Standard size (bytes) of an SPL token account — what getMinimumBalanceForRentExemption is asked to price when a recipient's ATA needs creating. */
const SPL_TOKEN_ACCOUNT_SIZE = 165;
/** SPL Token instruction discriminants this file emits — both single-byte, from the program's own fixed instruction-index layout (TransferChecked = 12; the ATA program's CreateIdempotent = 1). */
const SPL_INSTRUCTION_TRANSFER_CHECKED = 12;
const ATA_INSTRUCTION_CREATE_IDEMPOTENT = 1;

export async function getTransactions(address) {
  return [];
}

/** Thrown for any caller/input problem (invalid address, insufficient balance, wrong network, ...) — as opposed to an RPC/network failure. */
export class TransactionValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransactionValidationError';
    this.code = code;
  }
}

/**
 * Estimate the network fee for a native SOL transfer, without signing or
 * sending anything.
 * @param {object} params
 * @param {string} params.network - a Solana network key (e.g. 'solana', 'solana-devnet').
 * @param {string} params.from - sender's base58 address (fee payer).
 * @param {string} params.to - recipient's base58 address.
 * @param {bigint|number} params.lamports - amount to send, in lamports.
 * @returns {Promise<{ fee: bigint, blockhash: string, lastValidBlockHeight: number }>}
 */
export async function estimateSolTransfer({ network: networkKey, from, to, lamports }) {
  const network = requireSolanaNetwork(networkKey);
  const fromPubkey = requireValidAddress(from, 'Sender');
  const toPubkey = requireValidAddress(to, 'Recipient');
  const lamportsValue = requirePositiveLamports(lamports);

  const { message, blockhash, lastValidBlockHeight } = await buildTransferMessage(
    network,
    fromPubkey,
    toPubkey,
    lamportsValue
  );
  const fee = await getFeeForMessage(network, message);

  return { fee, blockhash, lastValidBlockHeight };
}

/**
 * Build, sign (via the caller-supplied `sign` callback) and broadcast a
 * native SOL transfer.
 * @param {object} params
 * @param {string} params.network
 * @param {string} params.from
 * @param {string} params.to
 * @param {bigint|number} params.lamports
 * @param {(messageBytes: Uint8Array) => Promise<Uint8Array>} params.sign -
 *   called once with the transaction's compiled (unsigned) message bytes;
 *   must resolve with the raw 64-byte ed25519 signature — the exact shape
 *   @fluxio/crypto/signer's solanaSigner.signTransaction() already
 *   returns, so no new crypto-boundary function was needed for this. An
 *   extension caller passes `(bytes) => walletService.signTransaction(network, bytes)`;
 *   a standalone script with its own derived signer passes
 *   `signer.signTransaction` directly (see scripts/devnet-transfer-demo.mjs).
 * @returns {Promise<{ signature: string, explorerUrl: string }>}
 */
export async function sendSolTransfer({ network: networkKey, from, to, lamports, sign }) {
  if (typeof sign !== 'function') {
    throw new TransactionValidationError('MISSING_SIGNER', 'sendSolTransfer requires a `sign` function.');
  }
  const network = requireSolanaNetwork(networkKey);
  const fromPubkey = requireValidAddress(from, 'Sender');
  const toPubkey = requireValidAddress(to, 'Recipient');
  const lamportsValue = requirePositiveLamports(lamports);

  const { tx, message } = await buildTransferMessage(network, fromPubkey, toPubkey, lamportsValue);
  const fee = await getFeeForMessage(network, message);

  const balance = await getSolBalanceLamports(network, from);
  if (balance < lamportsValue + fee) {
    throw new TransactionValidationError(
      'INSUFFICIENT_BALANCE',
      `Insufficient balance: sending ${lamportsValue} lamports plus a ${fee} lamport fee needs ${lamportsValue + fee}, but the wallet only has ${balance}.`
    );
  }

  const messageBytes = message.serialize();
  const signature = await sign(messageBytes);
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new Error('sign() must resolve to a 64-byte Uint8Array ed25519 signature.');
  }
  tx.addSignature(fromPubkey, Buffer.from(signature));

  const rawTx = tx.serialize().toString('base64');
  // BUG FIX (found against a real solana-test-validator, Agave 4.2.0 — see
  // prompt/0095): the actual Solana JSON-RPC method is `sendTransaction`.
  // `sendRawTransaction` is only ever a @solana/web3.js *client-side*
  // Connection method name (Connection.sendRawTransaction() calls
  // `sendTransaction` on the wire under the hood) — it never existed as an
  // RPC method on any Solana cluster, so this always failed with "Method
  // not found" the moment a real send actually reached this line. Every
  // mocked test here was blind to it by construction (the mock only
  // echoes back whatever method name it's given); only a real RPC
  // round-trip could catch it — see the new local-validator integration
  // test in test/transactionService.local-integration.test.js.
  // preflightCommitment must match the commitment getLatestBlockhash was
  // fetched at ('confirmed' — see buildTransferMessage/getLatestBlockhash
  // above). sendTransaction's own default preflightCommitment is
  // 'finalized', which is a STRICTER bank than the one that produced this
  // blockhash — found by hand against a real validator (see prompt/0095):
  // that mismatch alone reproducibly failed preflight simulation with
  // "Blockhash not found", even though the blockhash was genuinely valid a
  // moment earlier — the finalized bank just hadn't caught up to it yet.
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    params: [rawTx, { encoding: 'base64', preflightCommitment: 'confirmed' }]
  });

  const txSignature = data.result;
  return { signature: txSignature, explorerUrl: solanaExplorerUrl(network, txSignature) };
}

/**
 * Estimate an SPL token transfer — fee, and (when the recipient has no
 * token account for this mint yet) the extra rent-exemption cost of
 * creating one, reported HONESTLY and SEPARATELY rather than folded
 * silently into the fee (see this file's header comment for why the
 * create-account instruction is only included when actually needed: an
 * accurate estimate must match what sendSplTransfer will actually build
 * and charge for the same inputs).
 * @param {object} params
 * @param {string} params.network - a Solana network key.
 * @param {string} params.from - sender's base58 address.
 * @param {string} params.to - recipient's base58 address.
 * @param {string} params.mint - the SPL token mint's base58 address.
 * @param {string} params.amount - human-typed decimal token amount (e.g. "12.5").
 * @returns {Promise<{
 *   decimals: number, amountRaw: bigint, tokenBalanceRaw: bigint,
 *   fee: bigint, ataRent: bigint, needsAta: boolean, nativeBalance: bigint,
 *   blockhash: string, lastValidBlockHeight: number
 * }>}
 */
export async function estimateSplTransfer({ network: networkKey, from, to, mint, amount }) {
  const network = requireSolanaNetwork(networkKey);
  const fromPubkey = requireValidAddress(from, 'Sender');
  const toPubkey = requireValidAddress(to, 'Recipient');
  const mintPubkey = requireValidAddress(mint, 'Token mint');

  const senderAta = deriveAssociatedTokenAddress(fromPubkey, mintPubkey);
  const recipientAta = deriveAssociatedTokenAddress(toPubkey, mintPubkey);

  const [{ decimals, balanceRaw }, recipientAtaExists, nativeBalance] = await Promise.all([
    resolveSenderTokenInfo(network, senderAta, mintPubkey),
    accountExists(network, recipientAta.toBase58()),
    getSolBalanceLamports(network, from)
  ]);

  const amountRaw = requirePositiveTokenAmount(amount, decimals);
  const needsAta = !recipientAtaExists;

  const { message, blockhash, lastValidBlockHeight } = await buildSplTransferMessage({
    network,
    fromPubkey,
    toPubkey,
    mintPubkey,
    senderAta,
    recipientAta,
    amountRaw,
    decimals,
    needsAta
  });
  const fee = await getFeeForMessage(network, message);
  const ataRent = needsAta ? await getMinimumBalanceForRentExemption(network) : 0n;

  return { decimals, amountRaw, tokenBalanceRaw: balanceRaw, fee, ataRent, needsAta, nativeBalance, blockhash, lastValidBlockHeight };
}

/**
 * Build, sign (via the caller-supplied `sign` callback) and broadcast an
 * SPL token transfer — from the sender's associated token account (ATA)
 * to the recipient's, idempotently creating the recipient's ATA in the
 * SAME transaction (sender pays the rent) when it doesn't already exist.
 * Uses the exact same `sign(messageBytes) => Promise<Uint8Array>` signing
 * boundary as sendSolTransfer above — no new signing path.
 * @param {object} params
 * @param {string} params.network
 * @param {string} params.from
 * @param {string} params.to
 * @param {string} params.mint
 * @param {string} params.amount - human-typed decimal token amount.
 * @param {(messageBytes: Uint8Array) => Promise<Uint8Array>} params.sign
 * @returns {Promise<{ signature: string, explorerUrl: string, decimals: number, amountRaw: bigint, ataCreated: boolean }>}
 */
export async function sendSplTransfer({ network: networkKey, from, to, mint, amount, sign }) {
  if (typeof sign !== 'function') {
    throw new TransactionValidationError('MISSING_SIGNER', 'sendSplTransfer requires a `sign` function.');
  }
  const network = requireSolanaNetwork(networkKey);
  const fromPubkey = requireValidAddress(from, 'Sender');
  const toPubkey = requireValidAddress(to, 'Recipient');
  const mintPubkey = requireValidAddress(mint, 'Token mint');

  const senderAta = deriveAssociatedTokenAddress(fromPubkey, mintPubkey);
  const recipientAta = deriveAssociatedTokenAddress(toPubkey, mintPubkey);

  const [{ decimals, balanceRaw }, recipientAtaExists, nativeBalance] = await Promise.all([
    resolveSenderTokenInfo(network, senderAta, mintPubkey),
    accountExists(network, recipientAta.toBase58()),
    getSolBalanceLamports(network, from)
  ]);

  const amountRaw = requirePositiveTokenAmount(amount, decimals);
  if (balanceRaw < amountRaw) {
    throw new TransactionValidationError(
      'INSUFFICIENT_TOKEN_BALANCE',
      `Insufficient token balance: sending ${amountRaw} raw units needs at least that much, but the wallet only holds ${balanceRaw}.`
    );
  }

  const needsAta = !recipientAtaExists;
  const { tx, message } = await buildSplTransferMessage({
    network,
    fromPubkey,
    toPubkey,
    mintPubkey,
    senderAta,
    recipientAta,
    amountRaw,
    decimals,
    needsAta
  });
  const fee = await getFeeForMessage(network, message);
  const ataRent = needsAta ? await getMinimumBalanceForRentExemption(network) : 0n;
  const nativeRequired = fee + ataRent;
  if (nativeBalance < nativeRequired) {
    throw new TransactionValidationError(
      'INSUFFICIENT_BALANCE',
      `Insufficient balance for the network fee${needsAta ? ' plus a new recipient token account’s rent' : ''}: needs ${nativeRequired} lamports, but the wallet only has ${nativeBalance}.`
    );
  }

  const messageBytes = message.serialize();
  const signature = await sign(messageBytes);
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new Error('sign() must resolve to a 64-byte Uint8Array ed25519 signature.');
  }
  tx.addSignature(fromPubkey, Buffer.from(signature));

  const rawTx = tx.serialize().toString('base64');
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    // Same BUG FIX/preflightCommitment reasoning as sendSolTransfer above.
    params: [rawTx, { encoding: 'base64', preflightCommitment: 'confirmed' }]
  });

  const txSignature = data.result;
  return {
    signature: txSignature,
    explorerUrl: solanaExplorerUrl(network, txSignature),
    decimals,
    amountRaw,
    ataCreated: needsAta
  };
}

/**
 * Poll a transaction's confirmation status.
 * @param {object} params
 * @param {string} params.network
 * @param {string} params.signature
 * @returns {Promise<{ status: 'not_found'|'processed'|'confirmed'|'finalized', confirmations: number|null, err: object|null }>}
 */
export async function getTransactionStatus({ network: networkKey, signature }) {
  const network = requireSolanaNetwork(networkKey);
  if (typeof signature !== 'string' || !signature) {
    throw new TransactionValidationError('INVALID_SIGNATURE', 'A transaction signature is required.');
  }

  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getSignatureStatuses',
    params: [[signature], { searchTransactionHistory: true }]
  });

  const status = data.result?.value?.[0];
  if (!status) {
    return { status: 'not_found', confirmations: null, err: null };
  }
  return {
    status: status.confirmationStatus ?? (status.confirmations == null ? 'finalized' : 'processed'),
    confirmations: status.confirmations,
    err: status.err ?? null
  };
}

// ---- Pre-serialized (VersionedTransaction) support — prompt 0200 ----
// The swap flow receives a fully-built v0 transaction from Jupiter's
// /swap endpoint (see @fluxio/services/swapService.js) rather than
// building its own message the way the transfer functions above do.
// These three helpers live HERE (not in swapService, which stays a pure
// Jupiter-REST client, and not in background.js, which has no direct
// @solana/web3.js dependency under pnpm's strict isolation) because they
// are generic Solana RPC/serialization plumbing sharing this file's own
// fetchRpcWithFallback/requireSolanaNetwork/solanaExplorerUrl internals.

/** Current block height at 'confirmed' — the counterpart to a build response's own lastValidBlockHeight for expiry checks. WARNING (prompt 0203 Revisi 2, live-proven): at least one public RPC (publicnode, solana-core 4.3.0-rc.1) returns the SLOT from this method (observed getBlockHeight 447421525 vs getSlot 447421527 while its own getEpochInfo().blockHeight said 425463056) — a slot is ~22M HIGHER than the real block height on mainnet, so comparing this value against a lastValidBlockHeight would false-positive every expiry check. Any EXPIRY VERDICT must use getTrustedBlockHeight() below instead; this raw method is kept only for callers that don't gate anything irreversible on it. */
export async function getBlockHeight({ network: networkKey }) {
  const network = requireSolanaNetwork(networkKey);
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getBlockHeight',
    params: [{ commitment: 'confirmed' }]
  });
  return Number(data.result);
}

/**
 * Minimum plausible mainnet gap between the absolute slot and the block
 * height (prompt 0203 Revisi 2's sanity fence). On mainnet the real gap
 * is ~22 MILLION (skipped slots accumulated since genesis; measured
 * 21,958,473 on 16 Sep 2026 against two independent RPCs), so a
 * "block height" within 1M of the slot — or at/above it — is not a block
 * height at all (the live publicnode bug returns the slot itself,
 * gap ≈ 2). Calibrated for MAINNET ONLY: a fresh local test validator
 * legitimately has blockHeight ≈ slot — but every caller of the trusted
 * getter is the mainnet-only swap verdict path, so that never collides.
 */
export const BLOCK_HEIGHT_MIN_SLOT_GAP = 1_000_000;

/**
 * Block height for EXPIRY VERDICTS (prompt 0203 Revisi 2) — the value a
 * SWAP_BLOCKHASH_EXPIRED verdict compares against lastValidBlockHeight,
 * where a wrong number silently kills a live swap (the real incident:
 * publicnode's getBlockHeight returns the SLOT, ~22M too high, so every
 * swap would be stamped expired instantly through that fallback and the
 * re-broadcast loop would stop way too early).
 *
 * Uses getEpochInfo (NOT getBlockHeight): one response carries BOTH
 * `blockHeight` and `absoluteSlot`, so each endpoint's answer can be
 * sanity-checked against itself — proven consistent on both configured
 * mainnet RPCs even on the endpoint whose getBlockHeight is broken.
 * Each endpoint (default, then fallbacks) is tried in order; an answer
 * failing the fence (blockHeight missing, >= absoluteSlot, or within
 * BLOCK_HEIGHT_MIN_SLOT_GAP of it) is DISCARDED with one contract log
 * line (hostname only — never the full URL, which can carry an API key)
 * and the next endpoint is tried. Returns null when NO endpoint gave a
 * trustworthy answer — the caller must then fall back to something
 * safer than a bogus number (background.js uses a time-based backup),
 * never stamp an expiry verdict from an untrusted height.
 * @param {object} params
 * @param {string} params.network - a Solana network key.
 * @param {string[]} [params.endpoints] - endpoint-list override, FOR TESTS ONLY (the recovery-through-a-second-RPC case needs two endpoints regardless of how many the running config has — a keyless build's solana network legitimately has just one). Production callers never pass it.
 * @returns {Promise<number|null>}
 */
export async function getTrustedBlockHeight({ network: networkKey, endpoints: endpointsOverride }) {
  const network = requireSolanaNetwork(networkKey);
  const endpoints =
    Array.isArray(endpointsOverride) && endpointsOverride.length > 0
      ? endpointsOverride
      : [network.rpc.default, ...network.rpc.fallbacks];
  for (const endpoint of endpoints) {
    let info;
    try {
      // Single-endpoint pseudo-network: reuses fetchRpcWithFallback's
      // own timeout + error normalization without its fall-through (the
      // whole point here is judging each endpoint's answer individually).
      const data = await fetchRpcWithFallback(
        { name: network.name, rpc: { default: endpoint, fallbacks: [] } },
        { jsonrpc: '2.0', id: 1, method: 'getEpochInfo', params: [{ commitment: 'confirmed' }] }
      );
      info = data.result;
    } catch {
      continue; // transport-level failure — try the next endpoint
    }
    const blockHeight = Number(info?.blockHeight);
    const absoluteSlot = Number(info?.absoluteSlot);
    if (
      Number.isFinite(blockHeight) &&
      Number.isFinite(absoluteSlot) &&
      blockHeight < absoluteSlot &&
      absoluteSlot - blockHeight >= BLOCK_HEIGHT_MIN_SLOT_GAP
    ) {
      return blockHeight;
    }
    let host = 'unknown-host';
    try {
      host = new URL(endpoint).hostname;
    } catch {
      // keep the placeholder — never log the raw endpoint (API keys).
    }
    console.warn(
      `[fluxio] block-height sanity fence: ${host} returned blockHeight=${info?.blockHeight} absoluteSlot=${info?.absoluteSlot} — untrusted, trying next RPC`
    );
  }
  return null;
}

/**
 * Verifies that a specific SPL token account currently exists on chain
 * with EXACTLY the expected shape (prompt 0209, the swap fee-account
 * guard; owner decisions 4 and 5). Existence alone is not enough — see
 * accountExists() below, which deliberately answers only "is anything
 * there": a plain lamport transfer to a closed ATA's address leaves a
 * System-owned account there that would pass an existence check but can
 * never receive a token fee. VALID here means all four of: the account
 * exists, its owner program is the SPL Token Program, its parsed mint
 * equals expectedMint, and its parsed owner equals expectedOwner.
 *
 * Endpoint handling follows getTrustedBlockHeight() above: each
 * endpoint is judged INDIVIDUALLY (single-endpoint pseudo-network, no
 * silent fall-through), and an answer whose shape can't be trusted — no
 * `value` property at all, or a Token-Program account that came back
 * without the jsonParsed structure this request demanded — moves on to
 * the next endpoint instead of being read as "account missing" (a live
 * RPC answering with the wrong semantics is more dangerous than a dead
 * one — swap lesson 5). Only a well-formed answer produces a verdict;
 * if no endpoint produces one, the result is 'unverified', never a
 * guessed 'invalid'.
 *
 * @param {object} params
 * @param {string} params.network - a Solana network key (e.g. 'solana').
 * @param {string} params.address - the token account to verify.
 * @param {string} params.expectedMint - the mint the account must hold.
 * @param {string} params.expectedOwner - the wallet that must own it.
 * @param {string[]} [params.endpoints] - test-only endpoint override.
 * @returns {Promise<{ status: 'valid'|'invalid'|'unverified', reason: string|null }>}
 */
export async function verifyTokenAccount({ network: networkKey, address, expectedMint, expectedOwner, endpoints: endpointsOverride }) {
  const network = requireSolanaNetwork(networkKey);
  if (typeof address !== 'string' || !address) {
    throw new TransactionValidationError('INVALID_ADDRESS', 'A token account address is required.');
  }
  if (typeof expectedMint !== 'string' || !expectedMint || typeof expectedOwner !== 'string' || !expectedOwner) {
    throw new TransactionValidationError('INVALID_EXPECTATION', 'Both expectedMint and expectedOwner are required.');
  }
  const endpoints =
    Array.isArray(endpointsOverride) && endpointsOverride.length > 0
      ? endpointsOverride
      : [network.rpc.default, ...network.rpc.fallbacks];
  for (const endpoint of endpoints) {
    let result;
    try {
      const data = await fetchRpcWithFallback(
        { name: network.name, rpc: { default: endpoint, fallbacks: [] } },
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]
        }
      );
      result = data.result;
    } catch {
      continue; // transport-level failure — try the next endpoint
    }
    if (!result || typeof result !== 'object' || !('value' in result)) {
      continue; // not the getAccountInfo shape at all — untrusted answer
    }
    const value = result.value;
    if (value == null) {
      return { status: 'invalid', reason: 'missing' }; // a trusted, well-formed "no account here"
    }
    if (value.owner !== SPL_TOKEN_PROGRAM_ID.toBase58()) {
      return { status: 'invalid', reason: 'wrong_program' };
    }
    const parsedInfo = value.data?.parsed?.info;
    if (!parsedInfo || typeof parsedInfo !== 'object') {
      // A Token-Program account MUST come back parsed under jsonParsed;
      // an endpoint that answers otherwise ignored our encoding — its
      // answer can't be trusted for a verdict. Next endpoint.
      continue;
    }
    if (parsedInfo.mint !== expectedMint) {
      return { status: 'invalid', reason: 'wrong_mint' };
    }
    if (parsedInfo.owner !== expectedOwner) {
      return { status: 'invalid', reason: 'wrong_owner' };
    }
    return { status: 'valid', reason: null };
  }
  return { status: 'unverified', reason: 'no_trusted_answer' };
}

/**
 * simulateTransaction for an already-serialized (base64) transaction —
 * `sigVerify: false` + `replaceRecentBlockhash: true` so an UNSIGNED
 * transaction can be simulated BEFORE any signature exists (the swap
 * flow's pre-sign fence; proven live against a real public RPC in
 * prompt 0199's spike). Returns the simulation verdict, never throws on
 * a failed simulation — `err` non-null IS the result; only a transport/
 * RPC-level failure rejects.
 * @returns {Promise<{ err: object|string|null, logs: string[], unitsConsumed: number|null }>}
 */
export async function simulateSerializedTransaction({ network: networkKey, transactionBase64 }) {
  const network = requireSolanaNetwork(networkKey);
  if (typeof transactionBase64 !== 'string' || !transactionBase64) {
    throw new TransactionValidationError('INVALID_TRANSACTION', 'A base64-serialized transaction is required.');
  }
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'simulateTransaction',
    params: [transactionBase64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]
  });
  const value = data.result?.value || {};
  return {
    err: value.err ?? null,
    logs: Array.isArray(value.logs) ? value.logs : [],
    unitsConsumed: value.unitsConsumed ?? null
  };
}

/**
 * Read-only peek at a serialized transaction's identity fields — lets a
 * caller run the fee-payer fence BEFORE spending an RPC round trip on
 * simulation (prompt 0200's mandated fence order: identity first, then
 * simulate, then sign). signAndSendSerializedTransaction below re-checks
 * the same fence regardless (defense in depth), so skipping this peek can
 * never bypass it.
 * @returns {{ feePayer: string|null, numRequiredSignatures: number, version: number|string }}
 */
export function inspectSerializedTransaction({ transactionBase64 }) {
  let tx;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  } catch (err) {
    throw new TransactionValidationError('INVALID_TRANSACTION', `Could not deserialize the swap transaction: ${err?.message || 'unknown error'}`);
  }
  const feePayer = tx.message.staticAccountKeys[0];
  return {
    feePayer: feePayer ? feePayer.toBase58() : null,
    numRequiredSignatures: tx.message.header.numRequiredSignatures,
    version: tx.message.version
  };
}

/**
 * Deserializes a base64 v0 VersionedTransaction, enforces the identity
 * fence (fee payer — staticAccountKeys[0] — must be `expectedFeePayer`,
 * and exactly ONE signature may be required: this wallet never co-signs
 * a multi-signer transaction it didn't build), signs the message bytes
 * via the injected `sign` callback (same boundary as every send above:
 * this module never sees a key), attaches the signature, and broadcasts.
 * The byte path (deserialize → message.serialize() → 64-byte ed25519 →
 * addSignature → serialize) was proven byte-compatible with the repo's
 * own signer against a REAL Jupiter transaction in prompt 0199.
 * @param {object} params
 * @param {string} params.network - a Solana network key.
 * @param {string} params.transactionBase64 - the unsigned serialized transaction.
 * @param {string} params.expectedFeePayer - base58 address that MUST be the fee payer.
 * @param {(messageBytes: Uint8Array) => Promise<Uint8Array>} params.sign
 * @param {number} [params.maxRetries=3] - sendTransaction's own RPC-side retry count.
 * @returns {Promise<{ signature: string, explorerUrl: string|null }>}
 */
export async function signAndSendSerializedTransaction({ network: networkKey, transactionBase64, expectedFeePayer, sign, maxRetries = 3 }) {
  const network = requireSolanaNetwork(networkKey);
  const feePayerPubkey = requireValidAddress(expectedFeePayer, 'Fee payer');

  let tx;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  } catch (err) {
    throw new TransactionValidationError('INVALID_TRANSACTION', `Could not deserialize the swap transaction: ${err?.message || 'unknown error'}`);
  }
  const feePayer = tx.message.staticAccountKeys[0];
  if (!feePayer || !feePayer.equals(feePayerPubkey)) {
    throw new TransactionValidationError(
      'FEE_PAYER_MISMATCH',
      `The transaction's fee payer (${feePayer ? feePayer.toBase58() : 'none'}) is not the expected wallet address.`
    );
  }
  if (tx.message.header.numRequiredSignatures !== 1) {
    throw new TransactionValidationError(
      'UNEXPECTED_SIGNERS',
      `The transaction requires ${tx.message.header.numRequiredSignatures} signatures; exactly 1 (this wallet) was expected.`
    );
  }

  const signature = await sign(tx.message.serialize());
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new Error('sign() must resolve to a 64-byte Uint8Array ed25519 signature.');
  }
  tx.addSignature(feePayerPubkey, signature);
  const rawTx = Buffer.from(tx.serialize()).toString('base64');

  // Same wire method + preflight reasoning as sendSolTransfer above
  // (sendTransaction, preflightCommitment matching the 'confirmed' bank);
  // skipPreflight stays false deliberately — the RPC's own preflight is a
  // second, independent simulation right before broadcast.
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    params: [rawTx, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries }]
  });
  const txSignature = data.result;
  // rawTransactionBase64: the SIGNED serialized bytes, returned so a
  // caller can re-broadcast the identical transaction later (prompt 0203
  // Revisi 1's re-broadcast loop) — same signature every time, since the
  // bytes are unchanged.
  return { signature: txSignature, explorerUrl: solanaExplorerUrl(network, txSignature), rawTransactionBase64: rawTx };
}

/**
 * Re-broadcasts an ALREADY-SIGNED serialized transaction verbatim
 * (prompt 0203 Revisi 1). A single sendTransaction is one shot at the
 * leader's mempool — under congestion a transaction can be dropped and
 * simply never land (live incident: a real mainnet swap returned a
 * signature, then vanished; getSignatureStatuses [null] on two RPCs).
 * The standard fix is to keep re-sending the SAME bytes until the
 * signature confirms or the blockhash expires: identical bytes mean an
 * identical signature, so a re-send can never double-spend — the chain
 * executes at most one of them. skipPreflight defaults TRUE here (the
 * first send already passed preflight; re-running it would spuriously
 * reject once the transaction lands mid-loop) and maxRetries 0 (the loop
 * itself is the retry mechanism now).
 * @param {object} params
 * @param {string} params.network - a Solana network key.
 * @param {string} params.signedTransactionBase64 - the exact rawTransactionBase64 a previous send returned.
 * @returns {Promise<{ signature: string }>}
 */
export async function sendRawSerializedTransaction({ network: networkKey, signedTransactionBase64, skipPreflight = true, maxRetries = 0 }) {
  const network = requireSolanaNetwork(networkKey);
  if (typeof signedTransactionBase64 !== 'string' || !signedTransactionBase64) {
    throw new TransactionValidationError('INVALID_TRANSACTION', 'A base64-serialized signed transaction is required.');
  }
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    params: [signedTransactionBase64, { encoding: 'base64', skipPreflight, preflightCommitment: 'confirmed', maxRetries }]
  });
  return { signature: data.result };
}

/** Wrapped SOL's mint — duplicated from swapService.NATIVE_SOL_MINT (this file stays self-contained, see its own header) for detectNewAtaCreation's "native SOL output never leaves a rent-funded account behind" rule. */
const NATIVE_SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

/**
 * Does this (unsigned, Jupiter-built) swap transaction create a NEW
 * associated token account for the user's OUTPUT mint — i.e. will the
 * user permanently pay one token account's rent on top of the network
 * fee? (Prompt 0205 bagian A; born from the real incident where a first
 * swap into a token silently cost ~0.0015 SOL more than Review showed.)
 *
 * Detection is LOCAL — zero RPC: prompt 0205's own live experiment
 * proved Jupiter includes the ATA program's CreateIdempotent instruction
 * for the output ATA ONLY when that account doesn't exist yet (same
 * quote built for an address without the output ATA: 8 instructions, 2
 * of them ATA-program; for an address WITH it: 7 and 1 — the remaining
 * one being the temporary wSOL account, whose rent is refunded when it
 * closes in the same transaction). So parsing the build that
 * PREVIEW_SWAP_FEES already fetched answers the question exactly as the
 * chain will execute it.
 *
 * The output ATA is identified program-aware: candidates are derived
 * with BOTH the classic Token program and Token-2022 (an ATA's seeds
 * include the mint's own token program), then matched against the
 * static account keys referenced by each ATA-program instruction — a
 * brand-new user-specific ATA can never come from an address lookup
 * table, so it is always in staticAccountKeys. A native-SOL output
 * returns { createsOutputAta: false } outright: the wSOL account is
 * created AND closed in the same transaction, rent refunded.
 *
 * Throws on any deserialization problem — the caller must fail SAFE
 * (show the rent row as "may apply", never silently drop it).
 * @returns {{ createsOutputAta: boolean, tokenProgram: 'spl-token'|'token-2022'|null }}
 */
export function detectNewAtaCreation({ transactionBase64, ownerAddress, outputMint }) {
  if (outputMint === NATIVE_SOL_MINT_ADDRESS) {
    return { createsOutputAta: false, tokenProgram: null };
  }
  const ownerPubkey = requireValidAddress(ownerAddress, 'Owner');
  const mintPubkey = requireValidAddress(outputMint, 'Output mint');
  let tx;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  } catch (err) {
    throw new TransactionValidationError('INVALID_TRANSACTION', `Could not deserialize the swap transaction: ${err?.message || 'unknown error'}`);
  }
  const candidates = [
    { program: 'spl-token', ata: PublicKey.findProgramAddressSync([ownerPubkey.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0].toBase58() },
    { program: 'token-2022', ata: PublicKey.findProgramAddressSync([ownerPubkey.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0].toBase58() }
  ];
  const staticKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const ataProgram = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
  for (const ix of tx.message.compiledInstructions) {
    if (staticKeys[ix.programIdIndex] !== ataProgram) continue;
    for (const keyIndex of ix.accountKeyIndexes) {
      if (keyIndex >= staticKeys.length) continue; // lookup-table key — can never be a brand-new user ATA
      const hit = candidates.find((c) => c.ata === staticKeys[keyIndex]);
      if (hit) {
        return { createsOutputAta: true, tokenProgram: hit.program };
      }
    }
  }
  return { createsOutputAta: false, tokenProgram: null };
}

/**
 * One token account's CURRENT rent-exempt minimum (lamports, BigInt),
 * live from the chain — prompt 0205's koreksi (a) proved the number
 * MOVES: two real 165-byte accounts on chain hold 1,488,440 lamports
 * while the old hardcoded figure said 2,039,280, so anything DISPLAYED
 * must come from this call, never a constant.
 */
export async function getTokenAccountRentLamports({ network: networkKey }) {
  const network = requireSolanaNetwork(networkKey);
  return getMinimumBalanceForRentExemption(network);
}

/**
 * getTransaction (jsonParsed, v0-capable) with per-endpoint iteration
 * (prompt 0205 koreksi b): fetchRpcWithFallback only falls through on
 * TRANSPORT/RPC errors — but a live endpoint with limited history
 * answers `result: null` with NO error for a transaction it simply
 * doesn't retain (proven live: publicnode returned null for two real
 * 2-day-old mainnet swaps it had once known, while answering fresh
 * transactions fine). A null there is "ask the next endpoint", never an
 * answer — so this iterates the endpoint list itself, single-endpoint
 * pseudo-networks reusing fetchRpcWithFallback's timeout/error
 * normalization (same pattern as getTrustedBlockHeight above), and only
 * returns null once EVERY endpoint either failed or answered null.
 * @param {object} params
 * @param {string} params.network - a Solana network key.
 * @param {string} params.signature
 * @param {string[]} [params.endpoints] - endpoint-list override, FOR TESTS ONLY (same reasoning as getTrustedBlockHeight's).
 * @returns {Promise<object|null>} the raw getTransaction result, or null.
 */
export async function getTransactionDetails({ network: networkKey, signature, endpoints: endpointsOverride }) {
  const network = requireSolanaNetwork(networkKey);
  if (typeof signature !== 'string' || !signature) {
    throw new TransactionValidationError('INVALID_SIGNATURE', 'A transaction signature is required.');
  }
  const endpoints =
    Array.isArray(endpointsOverride) && endpointsOverride.length > 0
      ? endpointsOverride
      : [network.rpc.default, ...network.rpc.fallbacks];
  for (const endpoint of endpoints) {
    try {
      const data = await fetchRpcWithFallback(
        { name: network.name, rpc: { default: endpoint, fallbacks: [] } },
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]
        }
      );
      if (data.result != null) {
        return data.result;
      }
      // result null without an error: limited-history endpoint — next.
    } catch {
      // transport failure — next endpoint.
    }
  }
  return null;
}

/**
 * Dev-only faucet helper. Hard-rejects any network that isn't flagged
 * `isTestnet: true` in @fluxio/constants/networks.js — this is the one
 * guard the whole feature was built around, so a caller can never
 * accidentally airdrop-request against a real network.
 * @param {object} params
 * @param {string} params.network
 * @param {string} params.address
 * @param {bigint|number} params.lamports
 * @returns {Promise<{ signature: string }>}
 */
export async function requestDevnetAirdrop({ network: networkKey, address, lamports }) {
  const network = requireSolanaNetwork(networkKey);
  if (network.isTestnet !== true) {
    throw new TransactionValidationError(
      'MAINNET_AIRDROP_FORBIDDEN',
      `requestDevnetAirdrop refused: ${network.name} is not a test network.`
    );
  }
  const pubkey = requireValidAddress(address, 'Recipient');
  const lamportsValue = requirePositiveLamports(lamports);

  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'requestAirdrop',
    // Airdrop amounts are always small (a few SOL at most) — well within
    // Number precision, and requestAirdrop's RPC param is a plain number,
    // not a hex/string like other lamport-bearing calls.
    params: [pubkey.toBase58(), Number(lamportsValue)]
  });
  return { signature: data.result };
}

/**
 * Read-only lamports balance for a Solana network. A thin public wrapper
 * around the same lookup sendSolTransfer uses internally to check
 * sufficiency — exposed so callers (e.g. scripts/devnet-transfer-demo.mjs,
 * which needs to check an already-funded throwaway account's balance
 * before deciding whether an airdrop is even necessary) don't have to
 * duplicate an RPC call this file already makes.
 * @param {object} params
 * @param {string} params.network
 * @param {string} params.address
 * @returns {Promise<bigint>}
 */
export async function getSolBalance({ network: networkKey, address }) {
  const network = requireSolanaNetwork(networkKey);
  const pubkey = requireValidAddress(address, 'Address');
  return getSolBalanceLamports(network, pubkey.toBase58());
}

// ---- internals ----

function requireSolanaNetwork(networkKey) {
  const network = NETWORKS[networkKey];
  if (!network) {
    throw new TransactionValidationError('UNKNOWN_NETWORK', `Unknown network: ${networkKey}`);
  }
  if (network.accountType !== ACCOUNT_TYPES.SOLANA) {
    throw new TransactionValidationError(
      'UNSUPPORTED_NETWORK',
      `${network.name} is not a Solana network — SOL transfers are only supported on Solana-compatible networks.`
    );
  }
  return network;
}

function requireValidAddress(address, label) {
  try {
    return new PublicKey(address);
  } catch {
    throw new TransactionValidationError('INVALID_ADDRESS', `${label} address is not a valid Solana address.`);
  }
}

function requirePositiveLamports(lamports) {
  let value;
  try {
    value = BigInt(lamports);
  } catch {
    throw new TransactionValidationError('INVALID_AMOUNT', 'Amount must be a whole number of lamports.');
  }
  if (value <= 0n) {
    throw new TransactionValidationError('INVALID_AMOUNT', 'Amount must be greater than zero.');
  }
  return value;
}

async function buildTransferMessage(network, fromPubkey, toPubkey, lamportsValue) {
  const { blockhash, lastValidBlockHeight } = await getLatestBlockhash(network);
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: fromPubkey });
  tx.add(SystemProgram.transfer({ fromPubkey, toPubkey, lamports: lamportsValue }));
  const message = tx.compileMessage();
  return { tx, message, blockhash, lastValidBlockHeight };
}

async function getLatestBlockhash(network) {
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getLatestBlockhash',
    params: [{ commitment: 'confirmed' }]
  });
  return data.result.value; // { blockhash, lastValidBlockHeight }
}

async function getFeeForMessage(network, message) {
  const encodedMessage = message.serialize().toString('base64');
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getFeeForMessage',
    params: [encodedMessage, { commitment: 'confirmed' }]
  });
  if (data.result?.value == null) {
    throw new Error('Unable to estimate a fee for this transaction.');
  }
  return BigInt(data.result.value);
}

async function getSolBalanceLamports(network, address) {
  // BUG FIX (see prompt/0095): this call used to omit `commitment`
  // entirely, which defaults to a stricter level ('finalized' on most
  // nodes) than the 'confirmed' used everywhere else in this file
  // (getLatestBlockhash, getFeeForMessage). Against a real validator that
  // mismatch is a real race, not just a style nit: a signature reaching
  // 'confirmed' status (what waitForConfirmation-style polling checks)
  // does not guarantee a same-moment getBalance call at a stricter
  // commitment reflects it yet. Every RPC call in this file now
  // consistently asks for 'confirmed'.
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getBalance',
    params: [address, { commitment: 'confirmed' }]
  });
  return BigInt(data.result.value);
}

// ---- SPL token internals (prompt 0113 — see this file's header comment) ----

/** Deterministic "one token account per (owner, mint)" address — same derivation @solana/spl-token's own getAssociatedTokenAddressSync uses (verified byte-for-byte, see this file's header comment). */
function deriveAssociatedTokenAddress(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

/** SPL Token `TransferChecked`: 1-byte instruction index + 8-byte little-endian u64 amount + 1-byte decimals. The "Checked" variant (vs. plain `Transfer`) requires the mint account and its decimals explicitly, guarding against a caller silently sending 100x/0.01x the intended amount if it ever got decimals wrong — a real safety property, not just parity with the library. */
function buildTransferCheckedInstruction({ source, mint, destination, owner, amountRaw, decimals }) {
  const data = Buffer.alloc(10);
  data.writeUInt8(SPL_INSTRUCTION_TRANSFER_CHECKED, 0);
  data.writeBigUInt64LE(amountRaw, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: SPL_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false }
    ],
    data
  });
}

/** Associated-Token-Account program's `CreateIdempotent` (instruction index 1, no further data): creates the ATA if it doesn't exist yet, or succeeds as a no-op if it already does — safe to include even when the recipient turns out to already have one, though both estimate/send here only include it when accountExists() has already confirmed it's actually needed, so the fee/rent shown always matches what gets charged. */
function buildCreateAtaIdempotentInstruction({ payer, ata, owner, mint }) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: Buffer.from([ATA_INSTRUCTION_CREATE_IDEMPOTENT])
  });
}

/** Builds the (unsigned) SPL transfer message shared by estimateSplTransfer/sendSplTransfer — same "build once, fee-estimate and send both use the identical shape" discipline as buildTransferMessage() above, so a displayed estimate can never diverge from what actually gets sent/charged. */
async function buildSplTransferMessage({ network, fromPubkey, toPubkey, mintPubkey, senderAta, recipientAta, amountRaw, decimals, needsAta }) {
  const { blockhash, lastValidBlockHeight } = await getLatestBlockhash(network);
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: fromPubkey });
  if (needsAta) {
    tx.add(buildCreateAtaIdempotentInstruction({ payer: fromPubkey, ata: recipientAta, owner: toPubkey, mint: mintPubkey }));
  }
  tx.add(
    buildTransferCheckedInstruction({ source: senderAta, mint: mintPubkey, destination: recipientAta, owner: fromPubkey, amountRaw, decimals })
  );
  const message = tx.compileMessage();
  return { tx, message, blockhash, lastValidBlockHeight };
}

/**
 * Resolves the sender's held raw balance + this mint's decimals, per
 * tokenService.js's own rule (Solana decimals always come from the
 * chain, never a registry): prefers the sender's OWN token account (one
 * call gives both fields authoritatively for exactly the account about
 * to be spent from); falls back to reading the mint account's own
 * decimals when the sender doesn't have a token account for this mint
 * yet (balance is then unambiguously 0 — nothing to read from an
 * account that doesn't exist).
 */
async function resolveSenderTokenInfo(network, senderAta, mintPubkey) {
  const senderInfo = await getSplTokenAccountBalance(network, senderAta.toBase58());
  if (senderInfo) {
    return { decimals: senderInfo.decimals, balanceRaw: senderInfo.amountRaw };
  }
  const decimals = await getMintDecimals(network, mintPubkey.toBase58());
  return { decimals, balanceRaw: 0n };
}

/**
 * `null` covers "no token account at this address", "an account exists
 * there but isn't a token account", AND a genuine RPC-reachability
 * failure — all three are caught broadly and treated the same way here,
 * same "one bad lookup must never take the rest of the flow down with
 * it" per-item isolation principle tokenService.js's own per-mint/
 * per-token loops already established (see that file's comments for the
 * live bug that motivated it there). This is a deliberate, not
 * accidental, choice: verified live against a real solana-test-validator
 * that getTokenAccountBalance reports "could not find account" for a
 * genuinely-absent account and "not a Token account" for a wrong-shaped
 * one, both as ordinary JSON-RPC `{error}` responses — but
 * fetchRpcWithFallback (@fluxio/crypto/rpc) wraps EVERY failure, a
 * `{error}` response included, in the same "Could not reach <network>:
 * ..." message once every fallback endpoint is exhausted, so there is no
 * reliable way to distinguish "this specific account doesn't exist" from
 * "the RPC is genuinely down" from the error alone. resolveSenderTokenInfo()'s
 * own fallback call (getMintDecimals, uncaught) still surfaces a real
 * outage to the caller in that case — it hits the same endpoint moments
 * later and is not swallowed.
 */
async function getSplTokenAccountBalance(network, ataAddress) {
  try {
    const data = await fetchRpcWithFallback(network, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccountBalance',
      params: [ataAddress, { commitment: 'confirmed' }]
    });
    const value = data.result?.value;
    if (!value) return null;
    return { amountRaw: BigInt(value.amount), decimals: value.decimals };
  } catch {
    return null;
  }
}

/** Reads a mint account's own decimals — the fallback path in resolveSenderTokenInfo() above, and the one place this file needs a mint's decimals independent of any specific holder. Mirrors tokenService.js's fetchSolanaMintInfo() (duplicated rather than imported — this file stays a self-contained, storage/service-agnostic module the same way it always has, see its own header comment). */
async function getMintDecimals(network, mintAddress) {
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [mintAddress, { encoding: 'jsonParsed', commitment: 'confirmed' }]
  });
  const value = data.result?.value;
  const parsed = value?.data?.parsed;
  if (!value || parsed?.type !== 'mint') {
    throw new TransactionValidationError('INVALID_MINT', `No SPL mint found at ${mintAddress}.`);
  }
  const decimals = parsed.info?.decimals;
  if (typeof decimals !== 'number') {
    throw new TransactionValidationError('INVALID_MINT', `Could not read decimals for the mint at ${mintAddress}.`);
  }
  return decimals;
}

/** Whether ANY account (of any shape) currently exists at `address` — used only to decide if the recipient's ATA needs creating; the create instruction is idempotent regardless, but including it unconditionally would misreport the fee/rent estimate (see buildSplTransferMessage's own comment). */
async function accountExists(network, address) {
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [address, { encoding: 'base64', commitment: 'confirmed' }]
  });
  return data.result?.value != null;
}

async function getMinimumBalanceForRentExemption(network, size = SPL_TOKEN_ACCOUNT_SIZE) {
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getMinimumBalanceForRentExemption',
    params: [size]
  });
  return BigInt(data.result);
}

function requirePositiveTokenAmount(amount, decimals) {
  let value;
  try {
    value = parseUnits(amount, decimals);
  } catch (err) {
    throw new TransactionValidationError('INVALID_AMOUNT', err.message);
  }
  if (value <= 0n) {
    throw new TransactionValidationError('INVALID_AMOUNT', 'Amount must be greater than zero.');
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls a Solana address's balance until it's at least `minLamports`, or a
 * timeout elapses — general-purpose, not local-validator-specific. Exists
 * to close a real race found by hand against solana-test-validator: a
 * signature reaching 'confirmed' status (per getSignatureStatuses) and
 * that same lamports actually showing up on a getBalance call are tracked
 * by different pieces of validator state and can lag each other by a slot
 * or two, even at matching commitment levels — most visible right after an
 * airdrop against a fresh account (see scripts/devnet-transfer-demo.mjs,
 * the one caller that needs this today), but not exclusive to airdrops or
 * to a local validator; any caller that just funded an address and needs
 * to act on the new balance immediately should prefer this over reading
 * getSolBalance once right after a confirmation and assuming it's current.
 * @param {object} params
 * @param {string} params.network
 * @param {string} params.address
 * @param {bigint} params.minLamports
 * @param {{ timeoutMs?: number, pollIntervalMs?: number }} [opts]
 * @returns {Promise<bigint>} the observed balance once it meets minLamports.
 */
export async function waitForBalanceAtLeast({ network: networkKey, address, minLamports }, opts = {}) {
  const network = requireSolanaNetwork(networkKey);
  const pubkey = requireValidAddress(address, 'Address');
  const minLamportsValue = BigInt(minLamports);
  const timeoutMs = opts.timeoutMs ?? 15000;
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  let balance = await getSolBalanceLamports(network, pubkey.toBase58());
  while (balance < minLamportsValue) {
    if (Date.now() >= deadline) {
      throw new TransactionValidationError(
        'BALANCE_NOT_VISIBLE',
        `Timed out after ${timeoutMs}ms waiting for ${pubkey.toBase58()}'s balance to reach at least ${minLamportsValue} lamports on ${network.name} (last observed: ${balance}).`
      );
    }
    await sleep(pollIntervalMs);
    balance = await getSolBalanceLamports(network, pubkey.toBase58());
  }
  return balance;
}

/**
 * Exported (not just used internally by sendSolTransfer above) so
 * historyService.js's chain-history entries — and background.js's
 * FLUXIO_INTERNAL_GET_HISTORY handler, for local-record entries — can
 * build the exact same explorer link a fresh Send always did, without a
 * second implementation of the clusterQueryOverride/`cluster` logic.
 */
export function solanaExplorerUrl(network, signature) {
  // solana-local sets explorer.clusterQueryOverride (see networks.js) since
  // explorer.solana.com doesn't recognize its `cluster: 'localnet'` value —
  // it needs the `cluster=custom&customUrl=...` query pair instead. Every
  // other network reuses the plain `cluster` field.
  if (network.explorer.clusterQueryOverride) {
    return `${network.explorer.url}/tx/${signature}?${network.explorer.clusterQueryOverride}`;
  }
  const clusterSuffix = network.cluster === 'mainnet-beta' ? '' : `?cluster=${network.cluster}`;
  return `${network.explorer.url}/tx/${signature}${clusterSuffix}`;
}
