import { createSolanaSigner } from './solanaSigner.js';
import { createEvmSigner } from './evmSigner.js';
import { ACCOUNT_TYPES } from '@fluxio/constants/derivationPaths';

export { createSolanaSigner } from './solanaSigner.js';
export { createEvmSigner } from './evmSigner.js';

/** Registry so a future account type can be plugged in without a switch statement. */
export const SIGNER_FACTORIES = Object.freeze({
  [ACCOUNT_TYPES.SOLANA]: createSolanaSigner,
  [ACCOUNT_TYPES.EVM]: createEvmSigner
});

export function createSigner(accountType, secretMaterial) {
  const factory = SIGNER_FACTORIES[accountType];
  if (!factory) {
    throw new Error(`No signer available for account type: ${accountType}`);
  }
  return factory(secretMaterial);
}
