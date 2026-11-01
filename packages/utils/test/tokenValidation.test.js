import { describe, it, expect } from 'vitest';
import { isValidEvmAddress, isValidSolanaAddress, isValidTokenDecimals } from '../tokenValidation.js';

describe('isValidEvmAddress', () => {
  it('accepts a well-formed 0x + 40-hex-char address', () => {
    expect(isValidEvmAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(true);
  });

  it('accepts an all-lowercase address (no checksum required)', () => {
    expect(isValidEvmAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(true);
  });

  it('rejects a Solana (base58) address', () => {
    expect(isValidEvmAddress('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')).toBe(false);
  });

  it('rejects a too-short hex address', () => {
    expect(isValidEvmAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB4')).toBe(false); // 39 hex chars
  });

  it('rejects a too-long hex address', () => {
    expect(isValidEvmAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48A')).toBe(false); // 41 hex chars
  });

  it('rejects an address missing the 0x prefix', () => {
    expect(isValidEvmAddress('A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidEvmAddress('0xZZb86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(false);
  });

  it('rejects non-string input rather than throwing', () => {
    expect(isValidEvmAddress(null)).toBe(false);
    expect(isValidEvmAddress(undefined)).toBe(false);
    expect(isValidEvmAddress(12345)).toBe(false);
  });
});

describe('isValidSolanaAddress', () => {
  it('accepts a real 32-byte mint address (verified live against solana-devnet this session)', () => {
    expect(isValidSolanaAddress('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')).toBe(true);
  });

  it('accepts a real 32-byte wallet address (verified live against solana-local this session)', () => {
    expect(isValidSolanaAddress('HM2tV6hdcRFvPkcspwWvs9KU7rwKTyEa6UXGPc6v6TFy')).toBe(true);
  });

  it('rejects an EVM address', () => {
    expect(isValidSolanaAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(false);
  });

  it('rejects a string that merely looks like base58 (right charset/length) but does not decode to 32 bytes', () => {
    // Same length class as a real address, valid base58 alphabet, but
    // decodes to a different byte length — exactly the case a naive
    // charset+length regex (like popup.js's own UI-only heuristic) would
    // wrongly accept.
    expect(isValidSolanaAddress('1111111111111111111111111111111111111111')).toBe(false);
  });

  it('rejects a string containing characters outside the base58 alphabet (0, O, I, l)', () => {
    expect(isValidSolanaAddress('0OIl6hdcRFvPkcspwWvs9KU7rwKTyEa6UXGPc6v6TFy')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidSolanaAddress('')).toBe(false);
  });

  it('rejects non-string input rather than throwing', () => {
    expect(isValidSolanaAddress(null)).toBe(false);
    expect(isValidSolanaAddress(undefined)).toBe(false);
    expect(isValidSolanaAddress(42)).toBe(false);
  });
});

describe('isValidTokenDecimals', () => {
  it('accepts every integer in the 0..18 range', () => {
    expect(isValidTokenDecimals(0)).toBe(true);
    expect(isValidTokenDecimals(6)).toBe(true);
    expect(isValidTokenDecimals(18)).toBe(true);
  });

  it('rejects negative numbers', () => {
    expect(isValidTokenDecimals(-1)).toBe(false);
  });

  it('rejects anything above 18', () => {
    expect(isValidTokenDecimals(19)).toBe(false);
    expect(isValidTokenDecimals(255)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(isValidTokenDecimals(6.5)).toBe(false);
  });

  it('rejects non-number input rather than throwing', () => {
    expect(isValidTokenDecimals('6')).toBe(false);
    expect(isValidTokenDecimals(null)).toBe(false);
    expect(isValidTokenDecimals(undefined)).toBe(false);
  });
});
