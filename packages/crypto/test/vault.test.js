import { describe, it, expect } from 'vitest';
import { createVault, unlockVault, changeVaultPassword, isVault, VAULT_SCHEMA_VERSION } from '../vault.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('createVault / unlockVault', () => {
  it('round-trips the mnemonic through create and unlock', async () => {
    const vault = await createVault(MNEMONIC, 'hunter2-hunter2');
    const unlocked = await unlockVault(vault, 'hunter2-hunter2');
    expect(unlocked).toBe(MNEMONIC);
  });

  it('rejects unlocking with the wrong password', async () => {
    const vault = await createVault(MNEMONIC, 'right-password');
    await expect(unlockVault(vault, 'wrong-password')).rejects.toThrow();
  });

  it('rejects a corrupted vault ciphertext', async () => {
    const vault = await createVault(MNEMONIC, 'a-password');
    const corrupted = { ...vault, ciphertextB64: vault.ciphertextB64.slice(0, -4) + 'AAAA' };
    await expect(unlockVault(corrupted, 'a-password')).rejects.toThrow();
  });

  it('is versioned and tags every vault with the current schema', async () => {
    const vault = await createVault(MNEMONIC, 'a-password');
    expect(vault.schema).toBe(VAULT_SCHEMA_VERSION);
    expect(isVault(vault)).toBe(true);
  });

  it('rejects a vault that is missing required fields', async () => {
    await expect(unlockVault({ schema: VAULT_SCHEMA_VERSION }, 'a-password')).rejects.toThrow();
  });

  it('never stores the mnemonic in plaintext anywhere in the vault record', async () => {
    const vault = await createVault(MNEMONIC, 'a-password');
    expect(JSON.stringify(vault)).not.toContain('abandon');
  });

  it('produces a fresh salt/IV per vault, even for the same mnemonic+password', async () => {
    const a = await createVault(MNEMONIC, 'same-password');
    const b = await createVault(MNEMONIC, 'same-password');
    expect(a.saltB64).not.toBe(b.saltB64);
    expect(a.ivB64).not.toBe(b.ivB64);
  });
});

describe('changeVaultPassword', () => {
  it('re-encrypts under a new password and invalidates the old one', async () => {
    const vault = await createVault(MNEMONIC, 'old-password');
    const rotated = await changeVaultPassword(vault, 'old-password', 'new-password');

    await expect(unlockVault(rotated, 'old-password')).rejects.toThrow();
    await expect(unlockVault(rotated, 'new-password')).resolves.toBe(MNEMONIC);
  });

  it('requires the correct current password to rotate', async () => {
    const vault = await createVault(MNEMONIC, 'old-password');
    await expect(changeVaultPassword(vault, 'wrong-password', 'new-password')).rejects.toThrow();
  });
});
