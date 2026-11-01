/**
 * Pure balance gate for the Swap screen's Review button (prompt 0220,
 * owner keputusan 4 / opsi D1 — born from 0219 Revisi 1's finding that
 * NEITHER path had an amount-vs-balance gate: the owner's own screen
 * showed Review ACTIVE with 0 BNB). One decision point serves Solana and
 * EVM alike; the EXECUTE-side guards (Solana's pre-sign simulation, the
 * EVM pagar e balance check) stay as the authoritative second layer.
 *
 * Pure string/BigInt math only — this file is imported by the unbundled
 * popup (same pattern as amountStrings.js) and unit-tested directly.
 */

/**
 * Exact decimal-string -> raw BigInt at `decimals`, or null when the
 * input is not a plain positive decimal number (extra fraction digits
 * beyond `decimals` also return null — such an amount can never be sent
 * exactly, so the gate treats it as not payable).
 * @param {string} value
 * @param {number} decimals
 * @returns {bigint|null}
 */
export function decimalToRaw(value, decimals) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) return null;
  try {
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  } catch {
    return null;
  }
}

/**
 * Raw BigInt -> exact decimal string at `decimals` (trailing zeros
 * stripped). The tiny inverse of decimalToRaw for the EVM native MAX
 * fill; never rounds.
 * @param {bigint} raw
 * @param {number} decimals
 * @returns {string}
 */
export function rawToDecimal(raw, decimals) {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * The gate itself (owner keputusan 4; EXTENDED by prompt 0223 owner K3):
 * a native pay needs amount + the DISPLAYED max fee <= balance. A token
 * pay needs amount <= balance AND, when the caller supplies the native
 * side, native balance >= the native fee it will pay for the swap's own
 * transaction(s) — gas is paid in native, never from the token, so a
 * token pay with an empty native balance must NOT reach Review (the
 * pre-0223 gate ignored this entirely). Callers that pass no native
 * params keep the old token-pay behavior unchanged. A supplied
 * nativeFeeNeededRaw with an unparseable nativeBalance fails CLOSED.
 * Unparseable amounts or balances fail closed either way.
 * @param {object} params
 * @param {boolean} params.isNativePay
 * @param {string} params.amount - the user-typed pay amount.
 * @param {string} params.balance - the pay asset's balance (decimal string).
 * @param {number} params.decimals - the pay asset's decimals.
 * @param {bigint} params.feeMaxRaw - the displayed max network fee in the
 *   native asset's raw unit; for a native pay it adds to the amount, and
 *   for a token pay it is ignored (see nativeFeeNeededRaw instead).
 * @param {string} [params.nativeBalance] - the NATIVE asset's balance
 *   (decimal string), token pay only.
 * @param {number} [params.nativeDecimals] - the native asset's decimals,
 *   token pay only.
 * @param {bigint} [params.nativeFeeNeededRaw] - the native fee the token
 *   pay must still afford (tahap C: approve fee + swap fee reserves).
 * @returns {boolean} true when the balance covers the swap.
 */
export function hasSufficientPayBalance({ isNativePay, amount, balance, decimals, feeMaxRaw, nativeBalance, nativeDecimals, nativeFeeNeededRaw }) {
  const amountRaw = decimalToRaw(amount, decimals);
  const balanceRaw = decimalToRaw(balance, decimals);
  if (amountRaw == null || balanceRaw == null || amountRaw <= 0n) return false;
  if (isNativePay) {
    return amountRaw + (feeMaxRaw ?? 0n) <= balanceRaw;
  }
  if (amountRaw > balanceRaw) return false;
  if (nativeFeeNeededRaw != null) {
    const nativeRaw = decimalToRaw(nativeBalance, nativeDecimals ?? 18);
    if (nativeRaw == null || nativeRaw < nativeFeeNeededRaw) return false;
  }
  return true;
}
