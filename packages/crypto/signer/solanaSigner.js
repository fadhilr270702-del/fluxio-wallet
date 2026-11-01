/**
 * Solana signing primitive.
 *
 * Wraps a tweetnacl ed25519 keypair. This is the "Signer" box at the
 * bottom of the wallet's transaction-signing architecture:
 *   Web Page -> Extension Provider -> Background/Wallet Service ->
 *   User Approval -> Secure Vault -> Signer -> Signed Transaction
 *
 * By design this module knows nothing about dApp requests, approval UI,
 * or message transport — it only ever sees bytes it's asked to sign and
 * a secret key handed to it by the caller (which must already have gone
 * through vault unlock + user approval upstream).
 *
 * Real transaction *construction* (building a Solana `Transaction`/
 * `VersionedTransaction` from a dApp's request, fee payer, blockhash,
 * etc.) is intentionally out of scope for this phase — callers pass
 * already-serialized bytes to sign. What's real here is the cryptography:
 * `nacl.sign.detached` performs an actual ed25519 signature, not a
 * simulated one.
 */
import nacl from 'tweetnacl';

export function createSolanaSigner(secretKey) {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) {
    throw new Error('createSolanaSigner requires a 64-byte tweetnacl secret key.');
  }
  // Own a private copy so disposing this signer can't be undone by the
  // caller continuing to hold (and mutate) the original reference.
  let key = Uint8Array.from(secretKey);

  return {
    kind: 'solana',

    /** Sign arbitrary bytes (e.g. a wallet_signMessage request). */
    signMessage(messageBytes) {
      assertUnlocked(key);
      assertBytes(messageBytes, 'messageBytes');
      return nacl.sign.detached(messageBytes, key);
    },

    /**
     * Sign already-serialized transaction bytes. Building the transaction
     * itself (accounts, instructions, blockhash) is a later phase's job;
     * this performs the real ed25519 signature over whatever bytes are
     * handed in.
     */
    signTransaction(serializedTxBytes) {
      assertUnlocked(key);
      assertBytes(serializedTxBytes, 'serializedTxBytes');
      return nacl.sign.detached(serializedTxBytes, key);
    },

    /** Best-effort wipe of the in-memory secret key. */
    dispose() {
      if (key) key.fill(0);
      key = null;
    }
  };
}

function assertUnlocked(key) {
  if (!key) throw new Error('Signer has been disposed.');
}

function assertBytes(value, label) {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${label} must be a Uint8Array.`);
  }
}
