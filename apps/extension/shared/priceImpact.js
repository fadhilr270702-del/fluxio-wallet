/**
 * Pure display formatting for a swap quote's price impact (prompt 0219
 * Revisi 2 — extracted from popup.js so it's unit-testable without a DOM
 * mock, same pattern as amountStrings.js).
 *
 * The input is always a FRACTION of 1 (0.0021 = 0.21%) — Jupiter's own
 * priceImpactPct denomination, and what background.js's EVM branch emits
 * (the 0203 denomination lesson, re-proven by 0219's visual pass). The
 * EVM value can be NEGATIVE (Kyber's USD legs can mark the output worth
 * slightly more than the input when a route momentarily beats the feeds'
 * implied mid — seen live on the owner's 12 Oktober screen as "-0.07%");
 * Jupiter's own field never goes negative. Owner decision (0219 Revisi 2):
 * clamp in DISPLAY only — any percent below 0.01, negatives included,
 * renders "<0.01%"; the raw value stays untouched where it's stored.
 */

/**
 * -0.0007 -> "<0.01%"; 0.00005 -> "<0.01%"; 0.0021 -> "0.21%";
 * non-numeric/absent -> the bare em-dash value placeholder.
 * @param {string|number|null|undefined} pct - price impact as a fraction of 1.
 * @returns {string}
 */
export function formatPriceImpact(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return '—';
  const percent = n * 100;
  return percent < 0.01 ? '<0.01%' : `${percent.toFixed(2)}%`;
}
