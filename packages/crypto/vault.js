/**
 * Versioned, password-encrypted wallet vault.
 *
 * The vault is the ONLY place the mnemonic is ever persisted, and it is
 * always encrypted at rest (see encryption.js for the AES-GCM/PBKDF2
 * details). Private keys are never stored — they're re-derived from the
 * mnemonic on demand (see derivation.js) and kept only in short-lived
 * memory (see signer/*.js and services/walletService.js).
 *
 * Format is versioned (`schema`) so a future phase can change the KDF/
 * cipher or payload shape and migrate old vaults forward instead of
 * breaking them.
 */
import { encryptWithPassword, decryptWithPassword } from './encryption.js';

export const VAULT_SCHEMA_VERSION = 1;

/**
 * Create a new encrypted vault sealing a mnemonic.
 * @param {string} mnemonic
 * @param {string} password
 * @returns {Promise<object>} vault record, safe to persist as-is.
 */
export async function createVault(mnemonic, password) {
  if (typeof mnemonic !== 'string' || mnemonic.trim().length === 0) {
    throw new Error('createVault requires a mnemonic string.');
  }
  const payload = { schema: VAULT_SCHEMA_VERSION, mnemonic };
  const encrypted = await encryptWithPassword(payload, password);
  const now = new Date().toISOString();
  return {
    schema: VAULT_SCHEMA_VERSION,
    kdf: 'PBKDF2',
    cipher: 'AES-GCM',
    createdAt: now,
    updatedAt: now,
    ...encrypted
  };
}

/**
 * Unlock a vault, returning the plaintext mnemonic. Only ever resolves in
 * memory — callers are responsible for not persisting the result and for
 * discarding their reference once done (e.g. on lock()).
 * @param {object} vault
 * @param {string} password
 * @returns {Promise<string>} mnemonic
 */
export async function unlockVault(vault, password) {
  assertVaultShape(vault);
  const payload = await decryptWithPassword(vault, password);
  if (!payload || typeof payload.mnemonic !== 'string' || payload.schema !== VAULT_SCHEMA_VERSION) {
    throw new Error('Vault payload is malformed or from an unsupported schema version.');
  }
  return payload.mnemonic;
}

/**
 * Re-encrypt a vault's mnemonic under a new password. Requires the current
 * password to unlock first — this is a change, not a reset.
 */
export async function changeVaultPassword(vault, currentPassword, newPassword) {
  const mnemonic = await unlockVault(vault, currentPassword);
  return createVault(mnemonic, newPassword);
}

/** True if the object looks like a vault this module can attempt to unlock. */
export function isVault(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    value.schema === VAULT_SCHEMA_VERSION &&
    typeof value.ciphertextB64 === 'string' &&
    typeof value.saltB64 === 'string' &&
    typeof value.ivB64 === 'string'
  );
}

function assertVaultShape(vault) {
  if (!isVault(vault)) {
    throw new Error('Not a valid Fluxio vault record (missing/unsupported schema).');
  }
}
