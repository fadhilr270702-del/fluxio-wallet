/**
 * Internal wallet/account model.
 *
 * A "wallet" here is a *public* description of a mnemonic-derived wallet:
 * an id, creation metadata, and the derived public accounts. It never
 * contains the mnemonic, seed or any private key — those live only
 * transiently (see derivation.js) or encrypted inside the vault
 * (see vault.js). This object is what's safe to keep in memory/UI state
 * and even persist as plaintext (addresses are public information).
 *
 * EVM accounts are derived once and reused across every EVM-compatible
 * network (Ethereum, BNB Chain, Base, ...) instead of re-deriving a
 * duplicate keypair per chain — see accountsByNetwork()/getAccountForNetwork().
 */
import { deriveSolanaAccount, deriveEvmAccount } from './derivation.js';
import { ACCOUNT_TYPES } from '@fluxio/constants/derivationPaths';
import { NETWORKS } from '@fluxio/constants/networks';

/**
 * Derive the public wallet model (and, separately, the raw private key
 * material) from a BIP-39 seed. The private material is returned in its
 * own object so callers can choose to discard it immediately (e.g. after
 * sealing it into a vault) rather than it living inside the wallet model.
 *
 * @param {Uint8Array} seed
 * @param {{ accountIndex?: number, id?: string }} [opts]
 * @returns {{ wallet: object, secrets: object }}
 */
export function deriveWallet(seed, opts = {}) {
  const accountIndex = opts.accountIndex ?? 0;
  const solana = deriveSolanaAccount(seed, accountIndex);
  const evm = deriveEvmAccount(seed, accountIndex);

  const wallet = {
    id: opts.id ?? generateWalletId(),
    createdAt: new Date().toISOString(),
    accountIndex,
    accounts: {
      solana: {
        type: ACCOUNT_TYPES.SOLANA,
        address: solana.address,
        path: solana.path
      },
      evm: {
        type: ACCOUNT_TYPES.EVM,
        address: evm.address,
        path: evm.path
      }
    }
  };

  const secrets = {
    solana: { secretKey: solana.secretKey, publicKey: solana.publicKey },
    evm: { privateKey: evm.privateKey, publicKey: evm.publicKey }
  };

  return { wallet, secrets };
}

/**
 * Resolve which derived account backs a given network key. Ethereum, BNB
 * Chain and Base all resolve to the same `wallet.accounts.evm` entry.
 */
export function getAccountForNetwork(wallet, networkKey) {
  const network = NETWORKS[networkKey];
  if (!network) {
    throw new Error(`Unknown network: ${networkKey}`);
  }
  const account = wallet.accounts[network.accountType];
  if (!account) {
    throw new Error(`Wallet has no ${network.accountType} account derived.`);
  }
  return account;
}

/** All accounts, keyed by network (not account type) — for UI listing. */
export function accountsByNetwork(wallet) {
  const result = {};
  for (const network of Object.values(NETWORKS)) {
    result[network.key] = getAccountForNetwork(wallet, network.key);
  }
  return result;
}

function generateWalletId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (very old runtimes).
  return `wallet_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
