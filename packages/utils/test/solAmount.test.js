import { describe, it, expect } from 'vitest';
import { solToLamports, lamportsToSol } from '../solAmount.js';

describe('solToLamports', () => {
  it('converts a whole-number SOL string', () => {
    expect(solToLamports('1')).toBe(1_000_000_000n);
  });

  it('converts a fractional SOL string', () => {
    expect(solToLamports('0.05')).toBe(50_000_000n);
  });

  it('converts an amount at full 9-decimal lamport precision exactly', () => {
    expect(solToLamports('0.000000001')).toBe(1n);
  });

  it('trims surrounding whitespace', () => {
    expect(solToLamports('  2.5  ')).toBe(2_500_000_000n);
  });

  it('handles a large whole-number amount without precision loss', () => {
    // Beyond Number.MAX_SAFE_INTEGER once expressed in lamports — proves
    // this genuinely goes through BigInt, not a Number-based shortcut.
    expect(solToLamports('12345678.123456789')).toBe(12345678123456789n);
  });

  it('rejects a non-string input', () => {
    expect(() => solToLamports(1)).toThrow(/must be a string/);
  });

  it('rejects a non-numeric string', () => {
    expect(() => solToLamports('abc')).toThrow(/positive decimal number/);
  });

  it('rejects a negative amount', () => {
    expect(() => solToLamports('-1')).toThrow(/positive decimal number/);
  });

  it('rejects empty string', () => {
    expect(() => solToLamports('')).toThrow(/positive decimal number/);
  });

  it('rejects more than 9 decimal places', () => {
    expect(() => solToLamports('0.1234567891')).toThrow(/more precision than SOL supports/);
  });
});

describe('lamportsToSol', () => {
  it('converts a bigint lamports amount to an exact 9-decimal SOL string', () => {
    expect(lamportsToSol(1_000_000_000n)).toBe('1.000000000');
  });

  it('converts a fractional amount', () => {
    expect(lamportsToSol(50_000_000n)).toBe('0.050000000');
  });

  it('converts 1 lamport to the smallest representable fraction', () => {
    expect(lamportsToSol(1n)).toBe('0.000000001');
  });

  it('converts zero', () => {
    expect(lamportsToSol(0n)).toBe('0.000000000');
  });

  it('accepts a number or numeric string too, not just bigint', () => {
    expect(lamportsToSol(1_000_000_000)).toBe('1.000000000');
    expect(lamportsToSol('1000000000')).toBe('1.000000000');
  });

  it('rejects a negative amount', () => {
    expect(() => lamportsToSol(-1n)).toThrow(/non-negative/);
  });
});

describe('round-trip', () => {
  it('solToLamports and lamportsToSol invert each other for a whole 9-decimal amount', () => {
    const sol = '3.140000000';
    expect(lamportsToSol(solToLamports(sol))).toBe(sol);
  });
});
