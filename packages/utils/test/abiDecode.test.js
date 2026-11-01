import { describe, it, expect } from 'vitest';
import { decodeAbiString, decodeAbiUint } from '../abiDecode.js';

// Every string/uint8 fixture below was generated via ethers' own
// AbiCoder.defaultAbiCoder().encode() (`node -e` against this repo's
// existing `ethers` dependency, see this slice's own commit for the
// throwaway script) — an independent, real ABI encoder, not hand-typed
// hex guessed to match this file's own decoder logic.
describe('decodeAbiString', () => {
  it('decodes a short ASCII string ("USDC")', () => {
    const hex =
      '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000045553444300000000000000000000000000000000000000000000000000000000';
    expect(decodeAbiString(hex)).toBe('USDC');
  });

  it('decodes an empty string', () => {
    const hex = '0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000';
    expect(decodeAbiString(hex)).toBe('');
  });

  it('decodes a string spanning multiple 32-byte words ("Wrapped Ether")', () => {
    const hex =
      '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000d5772617070656420457468657200000000000000000000000000000000000000';
    expect(decodeAbiString(hex)).toBe('Wrapped Ether');
  });

  it('decodes a multi-byte UTF-8 character correctly ("€")', () => {
    const hex =
      '0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000003e282ac0000000000000000000000000000000000000000000000000000000000';
    expect(decodeAbiString(hex)).toBe('€');
  });

  it('returns null for an empty eth_call result ("0x") — the "no contract here" case that motivated this file', () => {
    expect(decodeAbiString('0x')).toBeNull();
  });

  it('returns null for a non-hex-string input rather than throwing', () => {
    expect(decodeAbiString(null)).toBeNull();
    expect(decodeAbiString(undefined)).toBeNull();
    expect(decodeAbiString(123)).toBeNull();
  });

  it('returns null for garbage/too-short data rather than throwing', () => {
    expect(decodeAbiString('0x1234')).toBeNull();
    expect(decodeAbiString('0xnotevenhex')).toBeNull();
  });

  it('does not throw on an astronomically large claimed length (0xff...ff) — rejects as unparseable rather than attempting to honor it', () => {
    // offset=0x20, length claims 2^256-1 bytes, but no data follows — a
    // malformed/adversarial response a real contract could return. Far
    // beyond Number.MAX_SAFE_INTEGER once doubled to a hex-char count, so
    // this is correctly refused outright (null), not silently clamped.
    const hex =
      '0x0000000000000000000000000000000000000000000000000000000000000020ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    expect(() => decodeAbiString(hex)).not.toThrow();
    expect(decodeAbiString(hex)).toBeNull();
  });

  it('clamps a moderately large but still safe-integer claimed length to the data actually available, instead of throwing', () => {
    // offset=0x20, length claims 1,000,000 bytes, but zero bytes of
    // string data actually follow — a smaller-scale version of the same
    // over-claimed-length problem, small enough that lengthHexChars is
    // still a safe integer, exercising the clamp path specifically
    // (rather than the "reject outright" path the test above exercises).
    const offsetWord = (32).toString(16).padStart(64, '0'); // offset = 0x20 = 32
    const lengthWord = (1_000_000).toString(16).padStart(64, '0');
    const hex = `0x${offsetWord}${lengthWord}`; // no string data follows the length word at all
    expect(() => decodeAbiString(hex)).not.toThrow();
    expect(decodeAbiString(hex)).toBe('');
  });
});

describe('decodeAbiUint', () => {
  it('decodes decimals=6', () => {
    expect(decodeAbiUint('0x0000000000000000000000000000000000000000000000000000000000000006')).toBe(6n);
  });

  it('decodes decimals=18', () => {
    expect(decodeAbiUint('0x0000000000000000000000000000000000000000000000000000000000000012')).toBe(18n);
  });

  it('decodes decimals=0', () => {
    expect(decodeAbiUint('0x0000000000000000000000000000000000000000000000000000000000000000')).toBe(0n);
  });

  it('returns null for an empty eth_call result ("0x")', () => {
    expect(decodeAbiUint('0x')).toBeNull();
  });

  it('returns null for a non-hex-string input rather than throwing', () => {
    expect(decodeAbiUint(null)).toBeNull();
    expect(decodeAbiUint(42)).toBeNull();
  });

  it('returns null for too-short data rather than throwing', () => {
    expect(decodeAbiUint('0x06')).toBeNull();
  });
});
