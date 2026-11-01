/**
 * SPL-token admin operations (create a mint, create a token account, mint
 * supply to it) for LOCAL DEV/DEMO USE ONLY — used by
 * scripts/spl-token-demo.mjs and tokenService's local-integration test,
 * never by anything else in this repo.
 *
 * This is deliberately NOT part of @fluxio/services's package.json
 * "exports" map (unlike tokenService.js, balanceService.js, ...) — it is
 * not importable as `@fluxio/services/splTokenAdmin` from outside this
 * package, and nothing inside this package imports it either (tokenService.js
 * stays read-only, per its own header comment). It's reachable only via a
 * direct relative file path, the same way scripts/*.mjs already reach
 * into packages/crypto/*.js — see e.g. devnet-transfer-demo.mjs's own
 * header comment for why that pattern exists (no chrome.storage.local/
 * localStorage in a plain Node process, so walletService can't be used
 * here either).
 *
 * Unlike tokenService.js (raw JSON-RPC via fetchRpcWithFallback, to keep
 * the bundled extension's footprint small), this file uses
 * @solana/web3.js's and @solana/spl-token's higher-level helpers directly
 * — appropriate here because this is signing/admin code that only ever
 * runs in Node (a demo script or a vitest process), never inside the
 * extension bundle. @solana/spl-token is declared as a devDependency of
 * this package for exactly that reason: it's dev/test tooling, not part
 * of the real wallet's runtime dependency surface.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';

/**
 * Creates a brand-new SPL mint, creates (or reuses) an associated token
 * account for `recipientAddress`, and mints `amountRaw` (smallest-unit
 * BigInt/number, per SPL convention — NOT a human decimal amount) into
 * it. The payer is also the mint authority and pays every fee — must
 * already be funded with enough native SOL (see scripts/spl-token-demo.mjs's
 * own funding step, mirroring devnet-transfer-demo.mjs's airdrop pattern).
 *
 * @param {{
 *   rpcUrl: string,
 *   payerSecretKey: Uint8Array,
 *   recipientAddress: string,
 *   decimals: number,
 *   amountRaw: bigint
 * }} params
 * @returns {Promise<{ mintAddress: string, tokenAccountAddress: string, mintSignature: string }>}
 */
export async function mintDemoSplToken({ rpcUrl, payerSecretKey, recipientAddress, decimals, amountRaw }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = Keypair.fromSecretKey(payerSecretKey);
  const recipient = new PublicKey(recipientAddress);

  const mint = await createMint(
    connection,
    payer, // fee payer
    payer.publicKey, // mint authority
    null, // no freeze authority — a demo token has no reason to freeze accounts
    decimals
  );

  const tokenAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mint, recipient);

  const mintSignature = await mintTo(
    connection,
    payer, // fee payer
    mint,
    tokenAccount.address,
    payer, // mint authority signer
    amountRaw
  );

  return {
    mintAddress: mint.toBase58(),
    tokenAccountAddress: tokenAccount.address.toBase58(),
    mintSignature
  };
}
