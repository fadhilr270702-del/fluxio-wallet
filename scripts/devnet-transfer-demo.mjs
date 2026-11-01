#!/usr/bin/env node
/**
 * Manual, one-off proof that the real SOL transfer pipeline works
 * end-to-end (construct -> sign via the real tweetnacl signing boundary ->
 * broadcast -> confirm) — NOT part of the app, not wired into any
 * package.json script, run directly by a developer as evidence. Runs
 * against public devnet by default, or a local solana-test-validator via
 * FLUXIO_DEMO_NETWORK=local — see the third env var below.
 *
 * The sender is a throwaway ed25519 account derived from its own BIP-39
 * mnemonic — by default a fresh one generated every run, held only in
 * memory and best-effort zeroed at the end. The mnemonic itself is NEVER
 * written to a file, in either mode below.
 *
 * Two ways to run it:
 *
 *   node scripts/devnet-transfer-demo.mjs
 *     Generates a brand-new throwaway sender every run. If the devnet
 *     airdrop fails (rate-limited — common, see below), the script prints
 *     that sender's mnemonic to the console so you can reuse the exact
 *     same (now possibly-still-unfunded, or manually-funded) account on a
 *     later run instead of starting over with a new address each time —
 *     see the FLUXIO_DEMO_SEED mode below.
 *
 *   FLUXIO_DEMO_SEED="word1 word2 ... word12" node scripts/devnet-transfer-demo.mjs
 *     Reuses a specific throwaway account instead of generating a new one.
 *     The script checks its on-chain balance first and skips the airdrop
 *     entirely if it's already funded enough for the transfer — so a
 *     rate-limited run followed by a manual faucet top-up (or just waiting
 *     out the rate limit) can be retried against the *same* address rather
 *     than the sender changing every attempt.
 *
 * A third env var picks which network the whole demo runs against:
 *
 *   FLUXIO_DEMO_NETWORK=local node scripts/devnet-transfer-demo.mjs
 *     Runs the exact same flow against a local solana-test-validator
 *     instead of the public devnet cluster — see CLAUDE.md's "LOCAL
 *     VALIDATOR" note. Default RPC http://127.0.0.1:8899
 *     (@fluxio/constants/networks.js's `solana-local`), which you must
 *     already have running yourself (e.g. `solana-test-validator` inside
 *     WSL) — this script never starts one. Airdrops against a local
 *     validator are NOT rate-limited, so this mode makes a single airdrop
 *     attempt with no retry/backoff, and a failed airdrop prints
 *     "is the validator running?" guidance instead of the
 *     faucet.solana.com/rate-limit text below (see
 *     printAirdropFailureHelp()'s local-mode branch) — that text doesn't
 *     apply here. FLUXIO_DEMO_SEED above works the same way in this mode.
 *   FLUXIO_DEMO_NETWORK=devnet (or unset) is the original public-devnet
 *     behavior described above — this is still the default.
 *
 * This deliberately calls @fluxio/crypto's lower-level primitives
 * (generateMnemonic, mnemonicToSeed, deriveSolanaAccount, createSigner)
 * directly instead of going through walletService/vault — not as a
 * workaround, but because there is nothing to unlock here: walletService's
 * persistence (createWallet/importWallet/unlock) needs chrome.storage.local
 * or localStorage (see @fluxio/crypto/storage.js's backend selection),
 * neither of which exists in a plain Node process. transactionService.js's
 * sendSolTransfer() was built with this in mind: it never imports
 * walletService itself, instead taking a `sign` callback from its caller —
 * here that's `signer.signTransaction()` from a signer built directly off
 * the throwaway secret key below, the same createSigner()/solanaSigner.js
 * boundary walletService itself uses internally.
 *
 * Devnet airdrops are FREE but rate-limited per source IP (typically a
 * handful of requests per hour, tighter during busy periods, and the limit
 * appears to reset roughly daily rather than on a short rolling window) —
 * and that public faucet has been unreliable for extended periods on top
 * of the rate limit itself, which is the whole reason FLUXIO_DEMO_NETWORK=
 * local exists. If the automatic airdrop fails after retries, the script
 * prints your options clearly (reuse via FLUXIO_DEMO_SEED once the limit
 * clears, fund the printed address manually via https://faucet.solana.com
 * and rerun with the same seed, or switch to FLUXIO_DEMO_NETWORK=local
 * entirely) rather than leaving you to guess.
 */
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '../packages/crypto/mnemonic.js';
import { deriveSolanaAccount } from '../packages/crypto/derivation.js';
import { createSigner } from '../packages/crypto/signer/index.js';
import { ACCOUNT_TYPES } from '../packages/constants/derivationPaths.js';
import { NETWORK_KEYS, NETWORKS } from '../packages/constants/networks.js';
import {
  requestDevnetAirdrop,
  sendSolTransfer,
  getTransactionStatus,
  getSolBalance,
  waitForBalanceAtLeast
} from '../packages/services/transactionService.js';

/** FLUXIO_DEMO_NETWORK=local switches the whole demo to a local solana-test-validator; anything else (including unset) stays on public devnet — see the file header comment above. */
function resolveDemoNetwork() {
  const raw = (process.env.FLUXIO_DEMO_NETWORK || 'devnet').trim().toLowerCase();
  if (raw === 'devnet') return NETWORK_KEYS.SOLANA_DEVNET;
  if (raw === 'local') return NETWORK_KEYS.SOLANA_LOCAL;
  throw new Error(`Unknown FLUXIO_DEMO_NETWORK "${raw}" — expected "devnet" (default) or "local".`);
}

const NETWORK = resolveDemoNetwork();
const IS_LOCAL = NETWORK === NETWORK_KEYS.SOLANA_LOCAL;
const AIRDROP_LAMPORTS = 1_000_000_000n; // 1 SOL
const TRANSFER_LAMPORTS = 10_000_000n; // 0.01 SOL
// A conservative buffer over a typical ~5000-lamport Solana fee, used only
// for the up-front "is an airdrop even needed?" balance check below —
// sendSolTransfer() itself still does the precise amount+fee check before
// actually broadcasting, this is just to decide whether to skip the airdrop.
const FEE_BUFFER_LAMPORTS = 20_000n;

// A local validator's airdrop isn't rate-limited (see the file header
// comment) — a failure there almost always means the validator just isn't
// reachable, which retrying with the same backoff schedule devnet needs
// won't fix, so local mode makes exactly one attempt.
const AIRDROP_MAX_ATTEMPTS = IS_LOCAL ? 1 : 3;
const AIRDROP_RETRY_DELAY_MS = 5000;
const CONFIRM_MAX_ATTEMPTS = 30;
const CONFIRM_POLL_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fresh throwaway Solana account: its own mnemonic, generated and used only in memory. */
function throwawayAccount() {
  const mnemonic = generateMnemonic(12);
  return { mnemonic, ...deriveSolanaAccount(mnemonicToSeed(mnemonic), 0) };
}

/**
 * Resolves the sender account: FLUXIO_DEMO_SEED if set (validated as a
 * real BIP-39 mnemonic — refuses to silently proceed with garbage input),
 * otherwise a freshly generated throwaway.
 */
function resolveSenderAccount() {
  const envSeed = process.env.FLUXIO_DEMO_SEED;
  if (!envSeed) {
    return { account: throwawayAccount(), reused: false };
  }
  if (!validateMnemonic(envSeed)) {
    throw new Error('FLUXIO_DEMO_SEED is set but is not a valid 12/24-word BIP-39 mnemonic — check for typos or extra whitespace.');
  }
  const account = { mnemonic: envSeed, ...deriveSolanaAccount(mnemonicToSeed(envSeed), 0) };
  return { account, reused: true };
}

async function airdropWithRetry(address) {
  for (let attempt = 1; attempt <= AIRDROP_MAX_ATTEMPTS; attempt++) {
    try {
      const { signature } = await requestDevnetAirdrop({ network: NETWORK, address, lamports: AIRDROP_LAMPORTS });
      console.log(`  Airdrop requested (attempt ${attempt}/${AIRDROP_MAX_ATTEMPTS}): ${signature}`);
      return signature;
    } catch (err) {
      console.warn(`  Airdrop attempt ${attempt}/${AIRDROP_MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt === AIRDROP_MAX_ATTEMPTS) {
        throw new Error(`${NETWORKS[NETWORK].name} airdrop failed after all retries.`);
      }
      await sleep(AIRDROP_RETRY_DELAY_MS);
    }
  }
}

async function waitForConfirmation(signature) {
  for (let attempt = 1; attempt <= CONFIRM_MAX_ATTEMPTS; attempt++) {
    const status = await getTransactionStatus({ network: NETWORK, signature });
    if (status.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    }
    if (status.status === 'confirmed' || status.status === 'finalized') {
      return status;
    }
    await sleep(CONFIRM_POLL_DELAY_MS);
  }
  throw new Error(`Timed out waiting for ${signature} to confirm — check the explorer link manually, it may still land.`);
}

/**
 * Printed when the automatic airdrop exhausts all retries — lays out every
 * real option instead of leaving the sender's mnemonic (and the address it
 * funds) to vanish with the process. This is the one place this script
 * prints a mnemonic; it's a devnet/local-only, single-purpose throwaway
 * account, never a real wallet — still not written to any file, only to
 * the console, and only reached on this specific failure path.
 */
function printAirdropFailureHelp(account) {
  console.error('\n--- Airdrop failed — here is how to continue ---');
  console.error(`This is a throwaway, ${IS_LOCAL ? 'local-validator-only' : 'devnet-only'} account with no real value — never reuse it for anything but this script.`);
  console.error(`\n  Address:      ${account.address}`);
  console.error(`  Seed phrase:  ${account.mnemonic}`);

  if (IS_LOCAL) {
    // Rate limits/faucet.solana.com don't apply here — see the file header
    // comment — so a failed airdrop against a local validator almost
    // always means the validator itself isn't reachable, not that it's
    // being throttled.
    console.error(`\nAirdrops against a local validator are NOT rate-limited, so this failure most likely means solana-test-validator isn't running (or isn't reachable at ${NETWORKS[NETWORK].rpc.default}). Pick one:`);
    console.error('  1. Start it (e.g. inside WSL: `solana-test-validator`) and rerun against this SAME account:');
    console.error(`       FLUXIO_DEMO_NETWORK=local FLUXIO_DEMO_SEED="${account.mnemonic}" node scripts/devnet-transfer-demo.mjs`);
    console.error(`  2. If it's already running elsewhere, confirm it's actually listening on ${NETWORKS[NETWORK].rpc.default} (no fallback is configured for solana-local — see networks.js).\n`);
    return;
  }

  console.error('\nPick one:');
  console.error('  1. Wait for the devnet faucet\'s rate limit to clear (it appears to reset roughly daily, not hourly) and rerun against this SAME account:');
  console.error(`       FLUXIO_DEMO_SEED="${account.mnemonic}" node scripts/devnet-transfer-demo.mjs`);
  console.error(`  2. Fund it manually via https://faucet.solana.com (paste the address above), then rerun with the same FLUXIO_DEMO_SEED command shown above — the script checks the balance first and will skip the airdrop entirely since the account is already funded.`);
  console.error('  3. Rerun with no FLUXIO_DEMO_SEED at all to try a brand-new throwaway account from scratch (only useful if you suspect the rate limit is tied to the address rather than your network — it\'s usually the latter, so option 1 or 2 is more likely to work).');
  console.error(`  4. Or sidestep the public faucet entirely: run FLUXIO_DEMO_NETWORK=local instead, against your own local validator — see this file's header comment.\n`);
}

async function main() {
  console.log(`--- Fluxio ${NETWORKS[NETWORK].name} SOL transfer demo ---\n`);

  const { account: sender, reused } = resolveSenderAccount();
  const recipient = throwawayAccount();
  console.log(reused ? 'Reusing sender account from FLUXIO_DEMO_SEED.' : 'Generated a fresh throwaway sender account.');
  console.log(`  Sender:    ${sender.address}`);
  console.log(`  Recipient: ${recipient.address}\n`);

  let senderBalance = 0n;
  if (reused) {
    try {
      senderBalance = await getSolBalance({ network: NETWORK, address: sender.address });
      console.log(`Sender's current balance: ${senderBalance} lamports.\n`);
    } catch (err) {
      console.warn(`Could not check sender balance up front (continuing to the airdrop step anyway): ${err.message}\n`);
    }
  }

  if (senderBalance >= TRANSFER_LAMPORTS + FEE_BUFFER_LAMPORTS) {
    console.log('Sender is already funded enough for this transfer — skipping the airdrop.\n');
  } else {
    console.log(`Requesting a 1 SOL airdrop for the sender on ${NETWORKS[NETWORK].name}...`);
    try {
      const airdropSignature = await airdropWithRetry(sender.address);
      console.log('  Waiting for the airdrop to confirm...');
      await waitForConfirmation(airdropSignature);
      console.log('  Airdrop confirmed — waiting for the balance to actually become visible...');
      // General fix, not a local-only workaround (see waitForBalanceAtLeast's
      // own doc comment in transactionService.js): a 'confirmed' airdrop
      // signature does not guarantee an immediately-following getBalance
      // read reflects it. Skipping this step is exactly what produced a
      // reproducible "Insufficient balance: ... only has 0" against a real
      // solana-test-validator immediately after a genuinely successful
      // airdrop.
      await waitForBalanceAtLeast(
        { network: NETWORK, address: sender.address, minLamports: senderBalance + AIRDROP_LAMPORTS },
        { timeoutMs: 15000 }
      );
      console.log('  Balance confirmed visible.\n');
    } catch (err) {
      printAirdropFailureHelp(sender);
      throw err;
    }
  }

  console.log('Sending 0.01 SOL from sender to recipient...');
  const signer = createSigner(ACCOUNT_TYPES.SOLANA, sender.secretKey);
  const { signature, explorerUrl } = await sendSolTransfer({
    network: NETWORK,
    from: sender.address,
    to: recipient.address,
    lamports: TRANSFER_LAMPORTS,
    // The one non-custodial contract this whole feature is built around:
    // transactionService never sees sender.secretKey, only this callback,
    // which routes the compiled message bytes through the same
    // tweetnacl-based signer walletService itself uses.
    sign: (messageBytes) => signer.signTransaction(messageBytes)
  });
  signer.dispose();

  console.log(`  Transaction sent: ${signature}`);
  console.log(`  Explorer: ${explorerUrl}`);
  console.log('  Waiting for confirmation...');
  const finalStatus = await waitForConfirmation(signature);

  console.log(`\nDone — status: ${finalStatus.status}`);
  console.log(`Signature: ${signature}`);
  console.log(`Explorer:  ${explorerUrl}`);

  sender.secretKey.fill(0);
  recipient.secretKey.fill(0);
}

main().catch((err) => {
  console.error(`\nDemo failed: ${err.message}`);
  process.exitCode = 1;
});
