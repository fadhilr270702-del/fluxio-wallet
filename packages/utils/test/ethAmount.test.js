import { describe, it, expect } from 'vitest';
import { ethToWei, weiToEth } from '../ethAmount.js';

describe('ethToWei', () => {
  it('converts a whole-number ETH string', () => {
    expect(ethToWei('1')).toBe(1_000_000_000_000_000_000n);
  });

  it('converts a fractional ETH string', () => {
    expect(ethToWei('0.05')).toBe(50_000_000_000_000_000n);
  });

  it('converts an amount at full 18-decimal wei precision exactly', () => {
    expect(ethToWei('0.000000000000000001')).toBe(1n);
  });

  it('trims surrounding whitespace', () => {
    expect(ethToWei('  2.5  ')).toBe(2_500_000_000_000_000_000n);
  });

  it('handles a large whole-number amount without precision loss', () => {
    // Beyond Number.MAX_SAFE_INTEGER once expressed in wei — proves this
    // genuinely goes through BigInt, not a Number-based shortcut.
    expect(ethToWei('12345678.123456789012345678')).toBe(12345678123456789012345678n);
  });

  it('rejects a non-string input', () => {
    expect(() => ethToWei(1)).toThrow(/must be a string/);
  });

  it('rejects a non-numeric string', () => {
    expect(() => ethToWei('abc')).toThrow(/positive decimal number/);
  });

  it('rejects a negative amount', () => {
    expect(() => ethToWei('-1')).toThrow(/positive decimal number/);
  });

  it('rejects empty string', () => {
    expect(() => ethToWei('')).toThrow(/positive decimal number/);
  });

  it('rejects more than 18 decimal places', () => {
    expect(() => ethToWei('0.1234567890123456789')).toThrow(/more precision than ETH supports/);
  });
});

describe('weiToEth', () => {
  it('converts a bigint wei amount to an exact 18-decimal ETH string', () => {
    expect(weiToEth(1_000_000_000_000_000_000n)).toBe('1.000000000000000000');
  });

  it('converts a fractional amount', () => {
    expect(weiToEth(50_000_000_000_000_000n)).toBe('0.050000000000000000');
  });

  it('converts 1 wei to the smallest representable fraction', () => {
    expect(weiToEth(1n)).toBe('0.000000000000000001');
  });

  it('converts zero', () => {
    expect(weiToEth(0n)).toBe('0.000000000000000000');
  });

  it('accepts a number or numeric string too, not just bigint', () => {
    expect(weiToEth(1_000_000_000_000_000_000)).toBe('1.000000000000000000');
    expect(weiToEth('1000000000000000000')).toBe('1.000000000000000000');
  });

  it('accepts a "0x..." hex string, matching how EVM RPCs return wei', () => {
    expect(weiToEth(`0x${(10n ** 18n).toString(16)}`)).toBe('1.000000000000000000');
  });

  it('rejects a negative amount', () => {
    expect(() => weiToEth(-1n)).toThrow(/non-negative/);
  });
});

describe('round-trip', () => {
  it('ethToWei and weiToEth invert each other for a whole 18-decimal amount', () => {
    const eth = '3.140000000000000000';
    expect(weiToEth(ethToWei(eth))).toBe(eth);
  });
});
