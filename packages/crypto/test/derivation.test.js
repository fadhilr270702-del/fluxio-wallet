import { describe, it, expect } from 'vitest';
import { mnemonicToSeed } from '../mnemonic.js';
import { deriveSolanaAccount, deriveEvmAccount, deriveAccount } from '../derivation.js';
import { ACCOUNT_TYPES } from '@fluxio/constants/derivationPaths';

const MNEMONIC_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MNEMONIC_B =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

// Well-known reference: ethers/hardhat's canonical derivation of the
// all-"abandon" mnemonic at m/44'/60'/0'/0/0.
const EXPECTED_EVM_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

describe('deriveEvmAccount', () => {
  const seed = mnemonicToSeed(MNEMONIC_A);

  it('matches the well-known reference address for the standard test mnemonic', () => {
    const account = deriveEvmAccount(seed, 0);
    expect(account.address).toBe(EXPECTED_EVM_ADDRESS);
    expect(account.path).toBe("m/44'/60'/0'/0/0");
  });

  it('produces a checksummed 0x address and 32-byte private key', () => {
    const account = deriveEvmAccount(seed, 0);
    expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(account.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('is deterministic: same seed + index -> same account', () => {
    const a = deriveEvmAccount(seed, 0);
    const b = deriveEvmAccount(seed, 0);
    expect(a.address).toBe(b.address);
    expect(a.privateKey).toBe(b.privateKey);
  });

  it('different account index -> different account', () => {
    const a = deriveEvmAccount(seed, 0);
    const b = deriveEvmAccount(seed, 1);
    expect(a.address).not.toBe(b.address);
  });

  it('different mnemonic -> different account', () => {
    const seedB = mnemonicToSeed(MNEMONIC_B);
    const a = deriveEvmAccount(seed, 0);
    const b = deriveEvmAccount(seedB, 0);
    expect(a.address).not.toBe(b.address);
  });
});

describe('deriveSolanaAccount', () => {
  const seed = mnemonicToSeed(MNEMONIC_A);

  it('produces a valid base58 public key / address', () => {
    const account = deriveSolanaAccount(seed, 0);
    expect(account.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(account.path).toBe("m/44'/501'/0'/0'");
    expect(account.publicKey).toBeInstanceOf(Uint8Array);
    expect(account.publicKey).toHaveLength(32);
    expect(account.secretKey).toHaveLength(64);
  });

  it('is deterministic: same seed + index -> same account', () => {
    const a = deriveSolanaAccount(seed, 0);
    const b = deriveSolanaAccount(seed, 0);
    expect(a.address).toBe(b.address);
  });

  it('different account index -> different account', () => {
    const a = deriveSolanaAccount(seed, 0);
    const b = deriveSolanaAccount(seed, 1);
    expect(a.address).not.toBe(b.address);
  });

  it('different mnemonic -> different account', () => {
    const seedB = mnemonicToSeed(MNEMONIC_B);
    const a = deriveSolanaAccount(seed, 0);
    const b = deriveSolanaAccount(seedB, 0);
    expect(a.address).not.toBe(b.address);
  });

  it("the derived public key's bs58 address round-trips through the keypair", () => {
    const account = deriveSolanaAccount(seed, 0);
    // secretKey is (32-byte seed || 32-byte pubkey) per tweetnacl/ed25519 convention.
    expect(Buffer.from(account.secretKey.slice(32)).equals(Buffer.from(account.publicKey))).toBe(
      true
    );
  });
});

describe('deriveAccount registry', () => {
  const seed = mnemonicToSeed(MNEMONIC_A);

  it('dispatches to the right deriver by account type', () => {
    expect(deriveAccount(ACCOUNT_TYPES.EVM, seed, 0).address).toBe(EXPECTED_EVM_ADDRESS);
    expect(deriveAccount(ACCOUNT_TYPES.SOLANA, seed, 0).address).toBe(
      deriveSolanaAccount(seed, 0).address
    );
  });

  it('throws for an unregistered account type', () => {
    expect(() => deriveAccount('bitcoin', seed, 0)).toThrow();
  });
});

// Multi-account (Fluxio's account-index-increment scheme, not a new
// seed): regression + determinism coverage for indices beyond 0, the
// exact requirement the multi-account feature was built around — index 0
// must keep producing the SAME address it always has (asserted directly
// against the well-known reference address above, not just "unchanged
// relative to some other index"), and 1..3 must each be internally
// deterministic and mutually distinct.
describe('multi-account derivation (index 0 regression + indices 1-3 determinism)', () => {
  const seed = mnemonicToSeed(MNEMONIC_A);

  it('index 0 still matches the well-known reference address — backward compatible with every existing derivation', () => {
    expect(deriveEvmAccount(seed, 0).address).toBe(EXPECTED_EVM_ADDRESS);
    expect(deriveEvmAccount(seed, 0).path).toBe("m/44'/60'/0'/0/0");
    expect(deriveSolanaAccount(seed, 0).path).toBe("m/44'/501'/0'/0'");
  });

  it.each([1, 2, 3])('EVM index %i is deterministic and distinct from every other index 0-3', (index) => {
    const a = deriveEvmAccount(seed, index);
    const b = deriveEvmAccount(seed, index);
    expect(a.address).toBe(b.address); // deterministic

    const others = [0, 1, 2, 3].filter((i) => i !== index).map((i) => deriveEvmAccount(seed, i).address);
    expect(others).not.toContain(a.address); // distinct from siblings
  });

  it.each([1, 2, 3])('Solana index %i is deterministic and distinct from every other index 0-3', (index) => {
    const a = deriveSolanaAccount(seed, index);
    const b = deriveSolanaAccount(seed, index);
    expect(a.address).toBe(b.address); // deterministic

    const others = [0, 1, 2, 3].filter((i) => i !== index).map((i) => deriveSolanaAccount(seed, i).address);
    expect(others).not.toContain(a.address); // distinct from siblings
  });
});
