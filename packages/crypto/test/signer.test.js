import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { verifyMessage } from 'ethers';
import { mnemonicToSeed } from '../mnemonic.js';
import { deriveSolanaAccount, deriveEvmAccount } from '../derivation.js';
import { createSolanaSigner, createEvmSigner, createSigner } from '../signer/index.js';
import { ACCOUNT_TYPES } from '@fluxio/constants/derivationPaths';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(MNEMONIC);

describe('SolanaSigner', () => {
  it('produces a real, verifiable ed25519 signature', () => {
    const account = deriveSolanaAccount(seed, 0);
    const signer = createSolanaSigner(account.secretKey);
    const message = new TextEncoder().encode('fluxio test message');

    const signature = signer.signMessage(message);

    expect(nacl.sign.detached.verify(message, signature, account.publicKey)).toBe(true);
  });

  it('a signature does not verify against a different message', () => {
    const account = deriveSolanaAccount(seed, 0);
    const signer = createSolanaSigner(account.secretKey);
    const signature = signer.signMessage(new TextEncoder().encode('message A'));
    expect(
      nacl.sign.detached.verify(new TextEncoder().encode('message B'), signature, account.publicKey)
    ).toBe(false);
  });

  it('throws once disposed', () => {
    const account = deriveSolanaAccount(seed, 0);
    const signer = createSolanaSigner(account.secretKey);
    signer.dispose();
    expect(() => signer.signMessage(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it('rejects a malformed secret key', () => {
    expect(() => createSolanaSigner(new Uint8Array(10))).toThrow();
  });
});

describe('EvmSigner', () => {
  it('produces a real, verifiable EIP-191 signature', async () => {
    const account = deriveEvmAccount(seed, 0);
    const signer = createEvmSigner(account.privateKey);

    const signature = await signer.signMessage('fluxio test message');
    const recovered = verifyMessage('fluxio test message', signature);

    expect(recovered).toBe(account.address);
  });

  it('throws once disposed', async () => {
    const account = deriveEvmAccount(seed, 0);
    const signer = createEvmSigner(account.privateKey);
    signer.dispose();
    await expect(signer.signMessage('hello')).rejects.toThrow();
  });

  it('rejects a malformed private key', () => {
    expect(() => createEvmSigner('not-a-key')).toThrow();
  });
});

describe('createSigner registry', () => {
  it('dispatches to the solana signer', () => {
    const account = deriveSolanaAccount(seed, 0);
    const signer = createSigner(ACCOUNT_TYPES.SOLANA, account.secretKey);
    expect(signer.kind).toBe('solana');
  });

  it('dispatches to the evm signer', () => {
    const account = deriveEvmAccount(seed, 0);
    const signer = createSigner(ACCOUNT_TYPES.EVM, account.privateKey);
    expect(signer.kind).toBe('evm');
  });

  it('throws for an unregistered account type', () => {
    expect(() => createSigner('bitcoin', new Uint8Array(64))).toThrow();
  });
});
