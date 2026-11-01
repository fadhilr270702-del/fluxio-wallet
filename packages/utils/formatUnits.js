/**
 * Converts a raw integer amount (smallest unit — lamports, wei, ...) to an
 * exact decimal string, given the unit's decimal places. Pure BigInt
 * arithmetic throughout — the raw amount is never routed through a JS
 * `Number`, which would silently lose precision for realistic amounts:
 * 18-decimal wei means anything above ~0.009 ETH already exceeds
 * `Number.MAX_SAFE_INTEGER` once expressed in the smallest unit.
 *
 * This returns the *exact* value, not a display-trimmed one — trimming a
 * long decimal string down for UI purposes is plain string truncation
 * (safe, no precision concern) and belongs at the display layer, not here.
 *
 * @param {bigint|number|string} raw - amount in the smallest unit (e.g. a
 *   decimal number/string of lamports, or a "0x..." hex string of wei —
 *   anything BigInt() itself accepts).
 * @param {number} decimals
 * @returns {string} e.g. "1.234500000" — always shows exactly `decimals`
 *   fractional digits, never scientific notation.
 */
export function formatUnits(raw, decimals) {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const sign = negative ? '-' : '';
  if (decimals === 0) return `${sign}${whole}`;
  const fraction = (abs % base).toString().padStart(decimals, '0');
  return `${sign}${whole}.${fraction}`;
}

/**
 * The reverse direction: parses a human-typed decimal amount string (e.g.
 * "0.05", "1", " 2.5 ") into a raw smallest-unit BigInt, given the unit's
 * decimal places. Throws a specific, human-readable error for anything
 * that isn't a valid non-negative decimal number, or that specifies more
 * fractional precision than `decimals` can represent.
 *
 * @fluxio/utils/solAmount.js's `solToLamports` and ethAmount.js's
 * `ethToWei` already do exactly this, but each hardcodes its own fixed
 * decimals (9 and 18) — appropriate there since SOL/ETH decimals are
 * static constants, never per-instance. Token sends (SPL/ERC-20) need a
 * genuinely *variable* decimals value (per mint/contract, read from the
 * chain or registry at send time — see @fluxio/services/tokenService.js),
 * which neither of those fixed-decimal helpers can express — this is that
 * generic parser, added once a second, real, variable-decimals caller
 * existed (prompt 0113), rather than speculatively up front. solAmount.js/
 * ethAmount.js are deliberately left as their own fixed-decimal wrappers,
 * not refactored to delegate here — both are already tested and used on
 * every native transfer; changing them carries regression risk for zero
 * behavioral benefit, since their existing named-import call sites
 * (`solToLamports`/`ethToWei`) don't need to change either.
 *
 * @param {string} input
 * @param {number} decimals
 * @returns {bigint}
 */
export function parseUnits(input, decimals) {
  if (typeof input !== 'string') {
    throw new Error('Amount must be a string.');
  }
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Amount must be a positive decimal number.');
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(`Amount has more precision than this token supports (max ${decimals} decimal places).`);
  }
  const paddedFraction = fraction.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFraction || '0');
}
