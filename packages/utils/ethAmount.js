/**
 * ETH <-> wei conversion, pure BigInt arithmetic throughout (same
 * precision discipline as solAmount.js/formatUnits.js — a human ETH
 * amount routed through a JS `Number` risks silent rounding, and money
 * math should never do that). Mirrors solAmount.js's exact structure and
 * error wording with 18 decimals in place of Solana's 9.
 *
 * formatUnits.js already covers the reverse (raw -> decimal string)
 * direction generically (`weiToEth` below is literally
 * `formatUnits(wei, 18)`), but there was no decimal-string -> BigInt
 * parser anywhere in the repo before this file — solToLamports was the
 * only one, and it's Solana-specific (hardcoded 9 decimals, SOL-specific
 * error messages). This is that parser for the EVM side, named/shaped to
 * match solAmount.js for symmetry rather than added as a generic
 * `parseUnits(input, decimals)` — @fluxio/services/evmTransactionService
 * and apps/extension/background.js both import named functions
 * (`ethToWei`/`weiToEth`) the same way they already import
 * `solToLamports`/`lamportsToSol`.
 *
 * UPDATE (prompt 0113): a genuinely variable-decimals caller now exists
 * (SPL/ERC-20 token sends — per-mint/per-contract decimals, not a fixed
 * constant), so formatUnits.js gained its own generic `parseUnits(input,
 * decimals)`. This file's ETH-specific `ethToWei`/`weiToEth` were left
 * exactly as they were (not refactored to delegate to it) — both stay the
 * fixed-18-decimal, ETH-specific-error-message convenience wrapper native
 * ETH transfers already use and are already tested against.
 */
const WEI_PER_ETH = 1_000_000_000_000_000_000n;
const ETH_DECIMALS = 18;

/**
 * Parses a human-typed ETH amount string (e.g. "0.05", "1", " 2.5 ") into
 * a wei BigInt. Throws a specific, human-readable error for anything that
 * isn't a valid non-negative decimal number, or that specifies more
 * fractional precision than a wei (18 decimal places) can represent — this
 * is the authoritative amount validator; a UI may do its own quick
 * heuristic for live feedback, but this is what actually decides.
 * @param {string} input
 * @returns {bigint}
 */
export function ethToWei(input) {
  if (typeof input !== 'string') {
    throw new Error('Amount must be a string.');
  }
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Amount must be a positive decimal number.');
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > ETH_DECIMALS) {
    throw new Error(`Amount has more precision than ETH supports (max ${ETH_DECIMALS} decimal places).`);
  }
  const paddedFraction = fraction.padEnd(ETH_DECIMALS, '0');
  return BigInt(whole) * WEI_PER_ETH + BigInt(paddedFraction || '0');
}

/**
 * Converts a wei amount into an exact ETH decimal string — always exactly
 * 18 fractional digits, no trailing-zero trimming (that's a display-layer
 * concern, same convention as solAmount.js/formatUnits.js).
 * @param {bigint|number|string} wei
 * @returns {string} e.g. "1.234500000000000000"
 */
export function weiToEth(wei) {
  const value = typeof wei === 'bigint' ? wei : BigInt(wei);
  if (value < 0n) {
    throw new Error('Wei must be non-negative.');
  }
  const whole = value / WEI_PER_ETH;
  const fraction = (value % WEI_PER_ETH).toString().padStart(ETH_DECIMALS, '0');
  return `${whole}.${fraction}`;
}
