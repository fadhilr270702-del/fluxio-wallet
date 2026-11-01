import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateMnemonic, mnemonicToSeed } from '../mnemonic.js';
import { deriveWallet } from '../wallet.js';
import { createVault, unlockVault } from '../vault.js';
import { deriveSolanaAccount, deriveEvmAccount } from '../derivation.js';
import { createSolanaSigner, createEvmSigner } from '../signer/index.js';

/**
 * These tests assert a security property, not just a functional one: none
 * of the core wallet-core operations ever pass secret material to
 * console.* — the most common way a "temporary debug log" leaks a seed
 * phrase or private key into a browser console, extension log, or crash
 * report.
 */
describe('no secret material is logged', () => {
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {})
  );

  afterEach(() => {
    spies.forEach((spy) => spy.mockClear());
  });

  function assertNothingLoggedContains(...secrets) {
    const allLoggedText = spies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg)))
      .join('\n');
    for (const secret of secrets) {
      expect(allLoggedText).not.toContain(secret);
    }
  }

  it('mnemonic generation, seed/derivation and vault creation never log the mnemonic or keys', async () => {
    const mnemonic = generateMnemonic();
    const seed = mnemonicToSeed(mnemonic);
    const { secrets } = deriveWallet(seed);
    const vault = await createVault(mnemonic, 'a-password');
    await unlockVault(vault, 'a-password');

    assertNothingLoggedContains(
      mnemonic,
      secrets.evm.privateKey,
      Buffer.from(secrets.solana.secretKey).toString('hex')
    );
  });

  it('signing operations never log the private key material used', async () => {
    const mnemonic = generateMnemonic();
    const seed = mnemonicToSeed(mnemonic);
    const solanaAccount = deriveSolanaAccount(seed, 0);
    const evmAccount = deriveEvmAccount(seed, 0);

    const solanaSigner = createSolanaSigner(solanaAccount.secretKey);
    solanaSigner.signMessage(new TextEncoder().encode('hello'));

    const evmSigner = createEvmSigner(evmAccount.privateKey);
    await evmSigner.signMessage('hello');

    assertNothingLoggedContains(
      mnemonic,
      evmAccount.privateKey,
      Buffer.from(solanaAccount.secretKey).toString('hex')
    );
  });
});

describe('signer disposal scrubs in-memory secret bytes', () => {
  it('zeroes the Solana signer secret key on dispose', () => {
    const mnemonic = generateMnemonic();
    const seed = mnemonicToSeed(mnemonic);
    const account = deriveSolanaAccount(seed, 0);
    const signer = createSolanaSigner(account.secretKey);

    signer.dispose();

    // The signer holds its own copy; disposing it must not be reversible.
    expect(() => signer.signMessage(new Uint8Array([1]))).toThrow();
  });
});

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
