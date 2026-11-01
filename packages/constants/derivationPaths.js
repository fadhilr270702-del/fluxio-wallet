/**
 * Centralized HD derivation path configuration.
 *
 * Solana uses SLIP-0010 ed25519 derivation and (per Solana wallet convention,
 * matching the Sollet/Phantom/Solana CLI default) every path level is
 * hardened, including the "change" level.
 *
 * EVM chains (Ethereum, BNB Chain, Base, ...) use standard BIP-44 derivation
 * with coin type 60 (Ethereum), shared by every EVM-compatible chain since
 * they are all secp256k1/keccak address spaces.
 */

export const ACCOUNT_TYPES = Object.freeze({
  SOLANA: 'solana',
  EVM: 'evm'
});

/** BIP-44 coin types, per SLIP-0044. */
export const COIN_TYPES = Object.freeze({
  solana: 501,
  evm: 60
});

/**
 * Build the standard Solana derivation path for a given account index.
 * m/44'/501'/{account}'/0'
 */
export function getSolanaDerivationPath(accountIndex = 0) {
  assertNonNegativeInteger(accountIndex, 'accountIndex');
  return `m/44'/${COIN_TYPES.solana}'/${accountIndex}'/0'`;
}

/**
 * Build the standard EVM (BIP-44) derivation path for a given account index.
 * m/44'/60'/0'/0/{account}
 */
export function getEvmDerivationPath(accountIndex = 0) {
  assertNonNegativeInteger(accountIndex, 'accountIndex');
  return `m/44'/${COIN_TYPES.evm}'/0'/0/${accountIndex}`;
}

/** Back-compat/legacy export kept for anything importing the old shape. */
export const DERIVATION_PATHS = Object.freeze({
  solana: getSolanaDerivationPath(0),
  evm: getEvmDerivationPath(0)
});

/**
 * Derivation path registry keyed by account type, so new networks can be
 * added without touching call sites — just register a new account type and
 * path builder here.
 */
export const DERIVATION_PATH_BUILDERS = Object.freeze({
  [ACCOUNT_TYPES.SOLANA]: getSolanaDerivationPath,
  [ACCOUNT_TYPES.EVM]: getEvmDerivationPath
});

export function getDerivationPath(accountType, accountIndex = 0) {
  const builder = DERIVATION_PATH_BUILDERS[accountType];
  if (!builder) {
    throw new Error(`Unsupported account type for derivation: ${accountType}`);
  }
  return builder(accountIndex);
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer, got: ${value}`);
  }
}
