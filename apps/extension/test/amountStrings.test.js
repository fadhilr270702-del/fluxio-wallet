// stripTrailingZeros (prompt 0214) — the MAX-button field cosmetic.
// Locks the exact 0213 real-money figures: dropping trailing zeros must
// NEVER change the raw value parseUnits reads back (the "MAX leaves
// exactly 0" guarantee proven on mainnet in 0213 depends on it), and
// must never round or truncate a significant digit the way the cosmetic
// trimAmount() would.
import { describe, it, expect } from 'vitest';
import { stripTrailingZeros } from '../shared/amountStrings.js';
import { parseUnits } from '../../../packages/utils/formatUnits.js';

describe('stripTrailingZeros', () => {
  it('locks the owner-decided cases (keputusan 4)', () => {
    expect(stripTrailingZeros('2.990000000000000000')).toBe('2.99');
    expect(stripTrailingZeros('0.001985559850000000')).toBe('0.00198555985');
    expect(stripTrailingZeros('0.002990000000000000')).toBe('0.00299');
    expect(stripTrailingZeros('1.000000')).toBe('1');
    expect(stripTrailingZeros('0')).toBe('0');
    expect(stripTrailingZeros('10')).toBe('10');
    expect(stripTrailingZeros('0.000000')).toBe('0');
  });

  it('never changes the raw value: parseUnits before === after on all three 0213 figures', () => {
    for (const [value, decimals] of [
      ['2.990000000000000000', 18], // 0213 Revisi 4: token MAX (2.99 USDT)
      ['0.001985559850000000', 18], // 0213 Revisi 5: native EVM MAX (left exactly 0 wei)
      ['0.002990000000000000', 18] // 0213 Revisi 1: the deposited balance
    ]) {
      expect(parseUnits(stripTrailingZeros(value), decimals)).toBe(parseUnits(value, decimals));
    }
    // And the exact raws, pinned (not just equality with themselves):
    expect(parseUnits(stripTrailingZeros('2.990000000000000000'), 18)).toBe(2990000000000000000n);
    expect(parseUnits(stripTrailingZeros('0.001985559850000000'), 18)).toBe(1985559850000000n);
  });

  it('drops only trailing zeros — a significant digit is never lost (this is NOT trimAmount)', () => {
    expect(stripTrailingZeros('0.00198555985')).toBe('0.00198555985'); // already clean: unchanged
    expect(stripTrailingZeros('1.230000000000000001')).toBe('1.230000000000000001'); // last digit significant: untouched
  });
});
