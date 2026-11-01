import { describe, it, expect } from 'vitest';
import { mnemonicToSeed } from '../mnemonic.js';
import { deriveWallet, getAccountForNetwork, accountsByNetwork } from '../wallet.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('deriveWallet', () => {
  const seed = mnemonicToSeed(MNEMONIC);
  const { wallet, secrets } = deriveWallet(seed);

  it('never includes the mnemonic or private keys in the public wallet model', () => {
    const serialized = JSON.stringify(wallet);
    expect(serialized).not.toContain('abandon');
    expect(serialized.toLowerCase()).not.toContain('privatekey');
    expect(serialized.toLowerCase()).not.toContain('secretkey');
  });

  it('exposes solana and evm accounts with addresses', () => {
    expect(wallet.accounts.solana.address).toBeTruthy();
    expect(wallet.accounts.evm.address).toBeTruthy();
  });

  it('keeps secrets in a separate object from the wallet model', () => {
    expect(secrets.solana.secretKey).toBeInstanceOf(Uint8Array);
    expect(secrets.evm.privateKey).toMatch(/^0x/);
  });

  it('is deterministic for the same seed', () => {
    const { wallet: wallet2 } = deriveWallet(seed);
    expect(wallet2.accounts.solana.address).toBe(wallet.accounts.solana.address);
    expect(wallet2.accounts.evm.address).toBe(wallet.accounts.evm.address);
  });
});

// Multi-account: deriveWallet's own accountIndex option is what
// walletService.setActiveAccount()/deriveAccountAddresses() are built on
// top of — regression-tested at this layer directly so a break here is
// caught before it ever reaches the service/UI layers.
describe('deriveWallet — multi-account (accountIndex option)', () => {
  const seed = mnemonicToSeed(MNEMONIC);

  it('defaults to accountIndex 0, matching a call with no opts at all', () => {
    const { wallet: withDefault } = deriveWallet(seed);
    const { wallet: explicitZero } = deriveWallet(seed, { accountIndex: 0 });
    expect(withDefault.accountIndex).toBe(0);
    expect(explicitZero.accounts.solana.address).toBe(withDefault.accounts.solana.address);
    expect(explicitZero.accounts.evm.address).toBe(withDefault.accounts.evm.address);
  });

  it('a different accountIndex produces different addresses on both chains, and records that index on the model', () => {
    const { wallet: account0 } = deriveWallet(seed, { accountIndex: 0 });
    const { wallet: account1 } = deriveWallet(seed, { accountIndex: 1 });
    expect(account1.accountIndex).toBe(1);
    expect(account1.accounts.solana.address).not.toBe(account0.accounts.solana.address);
    expect(account1.accounts.evm.address).not.toBe(account0.accounts.evm.address);
  });

  it('preserves a given wallet id across account indices (same underlying wallet, different account view)', () => {
    const { wallet: account0 } = deriveWallet(seed, { accountIndex: 0, id: 'fixed-wallet-id' });
    const { wallet: account1 } = deriveWallet(seed, { accountIndex: 1, id: account0.id });
    expect(account1.id).toBe('fixed-wallet-id');
  });
});

describe('getAccountForNetwork / accountsByNetwork', () => {
  const seed = mnemonicToSeed(MNEMONIC);
  const { wallet } = deriveWallet(seed);

  it('reuses the same EVM account for ethereum, bnb and base', () => {
    const ethereum = getAccountForNetwork(wallet, 'ethereum');
    const bnb = getAccountForNetwork(wallet, 'bnb');
    const base = getAccountForNetwork(wallet, 'base');
    expect(ethereum.address).toBe(bnb.address);
    expect(bnb.address).toBe(base.address);
    expect(ethereum.address).toBe(wallet.accounts.evm.address);
  });

  it('resolves solana to its own account', () => {
    const solana = getAccountForNetwork(wallet, 'solana');
    expect(solana.address).toBe(wallet.accounts.solana.address);
  });

  it('throws for an unknown network', () => {
    expect(() => getAccountForNetwork(wallet, 'dogecoin')).toThrow();
  });

  it('accountsByNetwork lists every configured network', () => {
    const map = accountsByNetwork(wallet);
    expect(Object.keys(map).sort()).toEqual(
      ['base', 'bnb', 'ethereum', 'ethereum-sepolia', 'ethereum-local', 'solana', 'solana-devnet', 'solana-local'].sort()
    );
  });

  it('resolves solana-local to the same Solana account as solana/solana-devnet', () => {
    const local = getAccountForNetwork(wallet, 'solana-local');
    expect(local.address).toBe(wallet.accounts.solana.address);
  });
});
