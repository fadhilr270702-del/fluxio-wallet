import { describe, it, expect } from 'vitest';
import { generateMnemonic, validateMnemonic, mnemonicToSeed } from '../mnemonic.js';

// Official BIP-39 reference test vector (bip39/test/vectors.json, English
// wordlist): all-zero 128-bit entropy.
const REFERENCE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const REFERENCE_SEED_HEX =
  '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4';

describe('generateMnemonic', () => {
  it('generates a 12-word mnemonic by default', () => {
    const mnemonic = generateMnemonic();
    expect(mnemonic.trim().split(/\s+/)).toHaveLength(12);
  });

  it('generates a valid 24-word mnemonic when requested', () => {
    const mnemonic = generateMnemonic(24);
    expect(mnemonic.trim().split(/\s+/)).toHaveLength(24);
    expect(validateMnemonic(mnemonic)).toBe(true);
  });

  it('generated mnemonics pass their own checksum validation', () => {
    for (let i = 0; i < 10; i += 1) {
      expect(validateMnemonic(generateMnemonic())).toBe(true);
    }
  });

  it('never produces the same mnemonic twice (CSPRNG sanity check)', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateMnemonic()));
    expect(seen.size).toBe(20);
  });

  it('rejects unsupported word counts', () => {
    expect(() => generateMnemonic(15)).toThrow();
  });
});

describe('validateMnemonic', () => {
  it('accepts the official BIP-39 reference vector', () => {
    expect(validateMnemonic(REFERENCE_MNEMONIC)).toBe(true);
  });

  it('rejects a mnemonic with a bad checksum (last word tampered)', () => {
    const words = REFERENCE_MNEMONIC.split(' ');
    words[words.length - 1] = 'zoo';
    expect(validateMnemonic(words.join(' '))).toBe(false);
  });

  it('rejects a mnemonic with a word not in the wordlist', () => {
    const words = REFERENCE_MNEMONIC.split(' ');
    words[0] = 'notarealbip39word';
    expect(validateMnemonic(words.join(' '))).toBe(false);
  });

  it('rejects the wrong word count', () => {
    expect(validateMnemonic('abandon abandon abandon')).toBe(false);
  });

  it('rejects non-string input without throwing', () => {
    expect(validateMnemonic(undefined)).toBe(false);
    expect(validateMnemonic(null)).toBe(false);
    expect(validateMnemonic(12345)).toBe(false);
  });
});

describe('mnemonicToSeed', () => {
  it('matches the official BIP-39 reference seed', () => {
    const seed = mnemonicToSeed(REFERENCE_MNEMONIC);
    expect(Buffer.from(seed).toString('hex')).toBe(REFERENCE_SEED_HEX);
  });

  it('refuses to derive a seed from an invalid mnemonic', () => {
    expect(() => mnemonicToSeed('not a valid mnemonic at all')).toThrow();
  });

  it('is deterministic for the same mnemonic', () => {
    const a = mnemonicToSeed(REFERENCE_MNEMONIC);
    const b = mnemonicToSeed(REFERENCE_MNEMONIC);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
