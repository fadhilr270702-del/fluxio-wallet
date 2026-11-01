import { describe, it, expect } from 'vitest';
import { formatUnits, parseUnits } from '../formatUnits.js';

describe('formatUnits', () => {
  it('formats a raw amount at 9 decimals (lamports-shaped)', () => {
    expect(formatUnits(1_234_500_000n, 9)).toBe('1.234500000');
  });

  it('formats a raw amount at 0 decimals with no fraction', () => {
    expect(formatUnits(42n, 0)).toBe('42');
  });

  it('formats a negative amount with a leading sign', () => {
    expect(formatUnits(-5_000_000_000n, 9)).toBe('-5.000000000');
  });

  it('accepts a hex string (e.g. an EVM eth_call/eth_getBalance result) directly', () => {
    expect(formatUnits('0x2540be400', 9)).toBe('10.000000000');
  });

  // Beyond Number.MAX_SAFE_INTEGER — proves this stays BigInt end to end,
  // same concern this file's own header comment documents for wei.
  it('formats a value well beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
    const raw = 123_456_789_012_345_678_901_234n;
    expect(formatUnits(raw, 18)).toBe('123456.789012345678901234');
  });
});

describe('parseUnits', () => {
  it('parses a whole-number amount at 6 decimals (USDC-shaped)', () => {
    expect(parseUnits('12', 6)).toBe(12_000_000n);
  });

  it('parses a fractional amount', () => {
    expect(parseUnits('12.5', 6)).toBe(12_500_000n);
  });

  it('parses at full precision for the given decimals', () => {
    expect(parseUnits('0.000001', 6)).toBe(1n);
  });

  it('trims surrounding whitespace', () => {
    expect(parseUnits('  2.5  ', 6)).toBe(2_500_000n);
  });

  it('round-trips with formatUnits for an arbitrary decimals value', () => {
    expect(parseUnits(formatUnits(987_654_321n, 4), 4)).toBe(987_654_321n);
  });

  it('handles a large whole-number amount without precision loss', () => {
    expect(parseUnits('12345678.123456789012345678', 18)).toBe(12345678123456789012345678n);
  });

  it('rejects a non-string input', () => {
    expect(() => parseUnits(1, 6)).toThrow(/must be a string/);
  });

  it('rejects a non-numeric string', () => {
    expect(() => parseUnits('abc', 6)).toThrow(/positive decimal number/);
  });

  it('rejects a negative amount', () => {
    expect(() => parseUnits('-1', 6)).toThrow(/positive decimal number/);
  });

  it('rejects empty string', () => {
    expect(() => parseUnits('', 6)).toThrow(/positive decimal number/);
  });

  it('rejects more fractional precision than the given decimals support', () => {
    expect(() => parseUnits('1.1234567', 6)).toThrow(/more precision/);
  });

  it('works at 0 decimals', () => {
    expect(parseUnits('42', 0)).toBe(42n);
    expect(() => parseUnits('42.1', 0)).toThrow(/more precision/);
  });
});
