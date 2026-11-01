/**
 * Pure parser for a confirmed swap's REAL received amount (prompt 0205
 * bagian B) — no network, no @solana/web3.js: it only walks the plain
 * JSON a `getTransaction` (jsonParsed) call already returned, so it can
 * run identically in the bundled service worker, plain Node, and tests.
 *
 * Rules (owner-approved in 0205 fase 1, dry-run-proven against the two
 * real mainnet fixtures from prompt 0203 Revisi 3):
 *  - SPL-token output: the delta of the USER-OWNED token balances for
 *    the output mint (Σ postTokenBalances − Σ preTokenBalances filtered
 *    on owner + mint). Real fixture: swap 1 (SOL→USDC) = 480,995 raw —
 *    what actually landed in the user's ATA, NET of the platform fee
 *    (the 485,118 figure sometimes quoted is the GROSS before the
 *    treasury's 4,123 cut; "You received" must show what the user got).
 *  - Native-SOL output: the user's lamport delta PLUS the fee the user
 *    paid (the fee payer is the user, so their post-balance is already
 *    net of it). Real fixture: swap 2 (USDC→SOL) = 4,808,244 + 105,000
 *    = 4,913,244 lamports. The temporary wSOL account nets to zero here
 *    (created AND closed inside the same transaction, rent refunded),
 *    and a new output ATA can't exist for a native-SOL output — so
 *    neither rent distorts this number. (A new INPUT-side ATA can't
 *    exist either: you can only swap FROM a token you already hold.)
 *
 * Returns null — never a wrong number — when the transaction failed on
 * chain (meta.err non-null) or anything needed is missing/malformed;
 * the caller keeps showing the estimate in that case. It never throws
 * on bad input shape: a parser problem must never be able to disturb
 * the swap's own verdict (0205 koreksi c).
 */

const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * @param {object} params
 * @param {object} params.transaction - a raw getTransaction result (jsonParsed).
 * @param {string} params.ownerAddress - the user's base58 Solana address.
 * @param {string} params.outputMint - the swap's output mint address.
 * @returns {bigint|null} the received amount in raw units, or null.
 */
export function parseSwapReceivedRaw({ transaction, ownerAddress, outputMint }) {
  try {
    const meta = transaction?.meta;
    if (!meta || meta.err != null) return null;
    if (typeof ownerAddress !== 'string' || !ownerAddress || typeof outputMint !== 'string' || !outputMint) return null;

    if (outputMint === NATIVE_SOL_MINT) {
      const keys = accountKeysOf(transaction);
      if (!keys) return null;
      const userIndex = keys.indexOf(ownerAddress);
      if (userIndex < 0) return null;
      const pre = meta.preBalances?.[userIndex];
      const post = meta.postBalances?.[userIndex];
      if (pre == null || post == null || meta.fee == null) return null;
      const received = BigInt(post) - BigInt(pre) + BigInt(meta.fee);
      return received >= 0n ? received : null;
    }

    if (!Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) return null;
    const sum = (list) =>
      list
        .filter((b) => b?.owner === ownerAddress && b?.mint === outputMint && b?.uiTokenAmount?.amount != null)
        .reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), 0n);
    const received = sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
    return received >= 0n ? received : null;
  } catch {
    return null; // malformed shapes (bad BigInt strings, wrong types) — no number is better than a wrong one
  }
}

function accountKeysOf(transaction) {
  const keys = transaction?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys)) return null;
  // No filtering: indexes must stay aligned with preBalances/postBalances.
  return keys.map((k) => (typeof k === 'string' ? k : k?.pubkey));
}
