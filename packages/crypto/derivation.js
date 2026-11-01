/**
 * Deterministic key derivation from a BIP-39 seed.
 *
 * Solana: SLIP-0010 ed25519 derivation (all-hardened path), via the
 * `ed25519-hd-key` package — the same approach documented by Solana's own
 * wallet guides and used by reference wallets (Phantom, Sollet, the Solana
 * CLI's paper-wallet flow).
 *
 * EVM (Ethereum / BNB Chain / Base / ...): standard BIP-32/BIP-44
 * secp256k1 derivation via `ethers`'s audited `HDNodeWallet` implementation.
 *
 * Nothing here implements ed25519/secp256k1/HMAC primitives by hand — both
 * paths delegate to established libraries.
 *
 * The registry at the bottom (`DERIVERS`) is what makes this extensible:
 * adding a new account type later means adding one entry, not touching
 * every call site.
 */
import { derivePath as deriveEd25519Path } from 'ed25519-hd-key';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { HDNodeWallet } from 'ethers';
import { ACCOUNT_TYPES, getSolanaDerivationPath, getEvmDerivationPath } from '@fluxio/constants/derivationPaths';

/**
 * Derive a Solana account (ed25519 keypair) from a BIP-39 seed.
 * @param {Uint8Array} seed - 64-byte BIP-39 seed.
 * @param {number} accountIndex
 * @returns {{ address: string, publicKey: Uint8Array, secretKey: Uint8Array, path: string }}
 *   `secretKey` is the 64-byte tweetnacl secret key (seed || pubkey) —
 *   sensitive, caller-owned, never persisted by this function.
 */
export function deriveSolanaAccount(seed, accountIndex = 0) {
  assertSeed(seed);
  const path = getSolanaDerivationPath(accountIndex);
  const seedHex = bytesToHex(seed);
  const { key } = deriveEd25519Path(path, seedHex);
  const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(key));
  const address = bs58.encode(keyPair.publicKey);
  return {
    address,
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    path
  };
}

/**
 * Derive an EVM account (secp256k1 keypair) from a BIP-39 seed. The
 * resulting account is chain-agnostic — the same address/private key is
 * valid on Ethereum, BNB Chain, Base and any other EVM-compatible chain.
 * @param {Uint8Array} seed - 64-byte BIP-39 seed.
 * @param {number} accountIndex
 * @returns {{ address: string, publicKey: string, privateKey: string, path: string }}
 *   `privateKey` is a 0x-prefixed hex string — sensitive, caller-owned.
 */
export function deriveEvmAccount(seed, accountIndex = 0) {
  assertSeed(seed);
  const path = getEvmDerivationPath(accountIndex);
  const root = HDNodeWallet.fromSeed(seed);
  const node = root.derivePath(path.startsWith('m/') ? path.slice(2) : path);
  return {
    address: node.address,
    publicKey: node.publicKey,
    privateKey: node.privateKey,
    path
  };
}

/** Registry so additional networks can be plugged in without touching wallet.js. */
export const DERIVERS = Object.freeze({
  [ACCOUNT_TYPES.SOLANA]: deriveSolanaAccount,
  [ACCOUNT_TYPES.EVM]: deriveEvmAccount
});

export function deriveAccount(accountType, seed, accountIndex = 0) {
  const deriver = DERIVERS[accountType];
  if (!deriver) {
    throw new Error(`Unsupported account type for derivation: ${accountType}`);
  }
  return deriver(seed, accountIndex);
}

function assertSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length < 16) {
    throw new Error('Expected a valid BIP-39 seed (Uint8Array).');
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
