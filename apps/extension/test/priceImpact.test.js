// formatPriceImpact (prompt 0219 Revisi 2) — the display clamp the owner
// decided after their own live screen showed "-0.07%" on a real BNB Chain
// quote (Kyber's USD legs can mark the output above the input). Locks the
// three owner-specified vectors verbatim plus the boundary and the
// non-finite placeholder. The raw fraction stays untouched everywhere it
// is stored — this clamp exists in display only.
import { describe, it, expect } from 'vitest';
import { formatPriceImpact } from '../shared/priceImpact.js';

describe('formatPriceImpact', () => {
  it('locks the owner-decided cases (0219 Revisi 2 keputusan 1)', () => {
    expect(formatPriceImpact('-0.0007')).toBe('<0.01%'); // the owner's own live -0.07% screen value class
    expect(formatPriceImpact('0.00005')).toBe('<0.01%'); // tiny positive (0.005%)
    expect(formatPriceImpact('0.0021')).toBe('0.21%'); // the 0219 fase-2 denomination-bug reference value
  });

  it('boundary: exactly 0.01% renders as is, just below clamps', () => {
    expect(formatPriceImpact('0.0001')).toBe('0.01%'); // percent == 0.01, >= threshold
    expect(formatPriceImpact('0.000099')).toBe('<0.01%');
    expect(formatPriceImpact(0)).toBe('<0.01%');
  });

  it('non-finite input keeps the bare em-dash value placeholder', () => {
    expect(formatPriceImpact(null)).toBe('<0.01%'); // Number(null) === 0 — a missing-but-present field clamps, it does not dash
    expect(formatPriceImpact(undefined)).toBe('—');
    expect(formatPriceImpact('abc')).toBe('—');
  });
});
