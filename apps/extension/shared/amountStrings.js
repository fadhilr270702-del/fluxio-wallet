/**
 * Pure decimal-string cosmetics for amount INPUT fields (prompt 0214).
 *
 * Born from 0213 Revisi 4/5: the MAX button filled the Amount field with
 * the raw full-decimal formatUnits string ("2.990000000000000000",
 * "0.001985559850000000") — functionally correct (parseUnits reads the
 * same raw value either way, proven on the real 0213 figures), ugly to
 * look at. The ONLY legal cleanup here is dropping TRAILING ZEROS:
 * truncating to a fixed decimal count (what trimAmount does for the
 * cosmetic balances list) would silently shrink a MAX amount and leave
 * dust behind, breaking the "MAX leaves exactly 0" guarantee 0213 just
 * proved on mainnet — so this function never rounds, never truncates a
 * significant digit, and has no decimal limit.
 */

/**
 * "2.990000000000000000" -> "2.99"; "0.001985559850000000" ->
 * "0.00198555985"; "1.000000" -> "1"; "0" -> "0"; "10" -> "10".
 * Anything without a '.' is returned unchanged.
 * @param {string} decimalStr - an exact decimal string (e.g. from
 *   formatUnits via background.js). Never a user-typed value in need of
 *   validation — callers pass program-generated strings only.
 * @returns {string}
 */
export function stripTrailingZeros(decimalStr) {
  const [whole, fraction = ''] = String(decimalStr).split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}
