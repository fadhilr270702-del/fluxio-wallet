/**
 * Real BIP-39 mnemonic generation, validation and seed derivation.
 *
 * Backed by the `bip39` package (https://github.com/bitcoinjs/bip39), which
 * implements the official BIP-39 wordlists/checksum algorithm on top of
 * `@noble/hashes`. We do not hand-roll any of the PBKDF2/checksum logic
 * here — per the project security rule, established libraries are used for
 * anything cryptographic.
 *
 * Randomness comes from bip39's default entropy source, which uses the
 * platform CSPRNG (Web Crypto `crypto.getRandomValues` in browsers/
 * extensions, Node's `crypto.randomBytes` under Vitest/Node) — never
 * `Math.random()`.
 */
import * as bip39 from 'bip39';

/** BIP-39 entropy strengths, in bits, mapped to resulting word count. */
export const MNEMONIC_STRENGTH = Object.freeze({
  12: 128,
  24: 256
});

/**
 * Generate a new cryptographically secure mnemonic.
 * @param {12|24} wordCount - defaults to 12 words (128-bit entropy).
 * @returns {string} space-separated mnemonic phrase.
 */
export function generateMnemonic(wordCount = 12) {
  const strength = MNEMONIC_STRENGTH[wordCount];
  if (!strength) {
    throw new Error(`Unsupported mnemonic word count: ${wordCount}. Use 12 or 24.`);
  }
  return bip39.generateMnemonic(strength);
}

/**
 * Validate a mnemonic's word count, wordlist membership and checksum.
 * Never throws — returns a boolean so callers can safely validate
 * untrusted/user-typed input.
 */
export function validateMnemonic(phrase) {
  if (typeof phrase !== 'string') return false;
  const normalized = normalizeMnemonic(phrase);
  const words = normalized.split(' ');
  if (words.length !== 12 && words.length !== 24) return false;
  return bip39.validateMnemonic(normalized);
}

/**
 * Derive the 64-byte BIP-39 seed from a mnemonic (+ optional passphrase,
 * i.e. the BIP-39 "25th word"). This seed is the single source used to
 * derive every account (Solana, EVM, ...) — see derivation.js.
 * @returns {Uint8Array}
 */
export function mnemonicToSeed(phrase, passphrase = '') {
  if (!validateMnemonic(phrase)) {
    throw new Error('Cannot derive seed: invalid mnemonic.');
  }
  const seedBuffer = bip39.mnemonicToSeedSync(normalizeMnemonic(phrase), passphrase);
  return new Uint8Array(seedBuffer.buffer, seedBuffer.byteOffset, seedBuffer.byteLength);
}

function normalizeMnemonic(phrase) {
  return phrase.trim().split(/\s+/).join(' ').normalize('NFKD');
}
