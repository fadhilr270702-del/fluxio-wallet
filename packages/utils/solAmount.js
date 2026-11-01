/**
 * SOL <-> lamports conversion, pure BigInt arithmetic throughout (same
 * precision discipline as formatUnits.js — a human SOL amount routed
 * through a JS `Number` risks silent rounding, and money math should
 * never do that). This is the one place that conversion happens; callers
 * (currently apps/extension/background.js) never do their own lamports
 * arithmetic — they pass a human-typed SOL string in and get a decimal
 * SOL string back out, everything lamports-shaped stays inside here and
 * @fluxio/services/transactionService.
 */
const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL_DECIMALS = 9;

/**
 * Parses a human-typed SOL amount string (e.g. "0.05", "1", " 2.5 ") into
 * a lamports BigInt. Throws a specific, human-readable error for anything
 * that isn't a valid non-negative decimal number, or that specifies more
 * fractional precision than a lamport (9 decimal places) can represent —
 * this is the authoritative amount validator; a UI may do its own quick
 * heuristic for live feedback, but this is what actually decides.
 * @param {string} input
 * @returns {bigint}
 */
export function solToLamports(input) {
  if (typeof input !== 'string') {
    throw new Error('Amount must be a string.');
  }
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Amount must be a positive decimal number.');
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > SOL_DECIMALS) {
    throw new Error(`Amount has more precision than SOL supports (max ${SOL_DECIMALS} decimal places).`);
  }
  const paddedFraction = fraction.padEnd(SOL_DECIMALS, '0');
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(paddedFraction || '0');
}

/**
 * Converts a lamports amount into an exact SOL decimal string — always
 * exactly 9 fractional digits, no trailing-zero trimming (that's a
 * display-layer concern, same convention as formatUnits.js).
 * @param {bigint|number|string} lamports
 * @returns {string} e.g. "1.234500000"
 */
export function lamportsToSol(lamports) {
  const value = typeof lamports === 'bigint' ? lamports : BigInt(lamports);
  if (value < 0n) {
    throw new Error('Lamports must be non-negative.');
  }
  const whole = value / LAMPORTS_PER_SOL;
  const fraction = (value % LAMPORTS_PER_SOL).toString().padStart(SOL_DECIMALS, '0');
  return `${whole}.${fraction}`;
}
