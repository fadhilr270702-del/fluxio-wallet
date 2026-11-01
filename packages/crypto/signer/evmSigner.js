/**
 * EVM signing primitive (Ethereum / BNB Chain / Base / any EVM chain).
 *
 * Wraps an `ethers.Wallet` for the private-key-holding half of signing.
 * See solanaSigner.js for the shared architecture note — same rule
 * applies here: this module never sees a dApp request or decides
 * approval, it only signs bytes/typed requests it's handed.
 *
 * Real transaction *sending* (nonce/gas fetching, RPC broadcast) is out
 * of scope for this phase. `signTransaction`/`signMessage` perform real
 * secp256k1 ECDSA signatures via ethers — not a simulated result — over
 * an already-populated transaction request or message.
 */
import { Wallet } from 'ethers';

export function createEvmSigner(privateKey) {
  if (typeof privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('createEvmSigner requires a 0x-prefixed 32-byte private key.');
  }
  let wallet = new Wallet(privateKey);

  return {
    kind: 'evm',

    get address() {
      assertUnlocked(wallet);
      return wallet.address;
    },

    /** Sign a message per EIP-191 (personal_sign semantics). */
    async signMessage(message) {
      assertUnlocked(wallet);
      return wallet.signMessage(message);
    },

    /**
     * Sign a fully-populated transaction request (legacy or EIP-1559).
     * Caller is responsible for supplying `to`, `value`, `data`, `nonce`,
     * `gasLimit`, `chainId`, and fee fields — no gas estimation or nonce
     * lookup happens here.
     */
    async signTransaction(transactionRequest) {
      assertUnlocked(wallet);
      return wallet.signTransaction(transactionRequest);
    },

    /** Sign EIP-712 typed data. */
    async signTypedData(domain, types, value) {
      assertUnlocked(wallet);
      return wallet.signTypedData(domain, types, value);
    },

    /** Best-effort release of the in-memory wallet/private key reference. */
    dispose() {
      wallet = null;
    }
  };
}

function assertUnlocked(wallet) {
  if (!wallet) throw new Error('Signer has been disposed.');
}
