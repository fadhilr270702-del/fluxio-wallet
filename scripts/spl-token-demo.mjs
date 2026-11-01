#!/usr/bin/env node
/**
 * Manual, one-off proof that tokenService.js's SPL (Solana) balance path
 * works end-to-end against a REAL SPL mint — creates a brand-new mint,
 * creates a token account for a recipient, mints supply into it, then
 * prints a ready-to-paste chrome.storage snippet to register that mint
 * as a custom token in the running extension (see
 * apps/extension/background/background.js's CUSTOM_TOKENS_STORAGE_KEY
 * comment) — a fallback path kept for developers without a running UI to
 * click through; the extension's own Manage Tokens screen (Settings ->
 * Manage Tokens, prompt 0109) is the normal way to register a custom
 * token now.
 *
 * NOT part of the app, not wired into any package.json script, run
 * directly by a developer as evidence. Runs ONLY against a local
 * solana-test-validator (127.0.0.1:8899, @fluxio/constants/networks.js's
 * `solana-local`) — never devnet/mainnet: creating a mint costs real rent
 * lamports repeatedly, which is exactly the kind of "gratis, tanpa RPC
 * berbayar" testing this repo's local-validator setup exists for (see
 * devnet-transfer-demo.mjs's own header for why solana-local exists at
 * all — same reasoning applies here, doubly so since this script runs an
 * airdrop AND a mint-creation on every invocation). You must already have
 * `solana-test-validator` running yourself (typically via WSL) — this
 * script never starts one, and fails with a clear message if it isn't
 * reachable, rather than hanging.
 *
 * The payer is a throwaway ed25519 account — by default a fresh one
 * generated every run, held only in memory. Same FLUXIO_DEMO_SEED reuse
 * mechanism as devnet-transfer-demo.mjs (useful here so repeated runs
 * don't need a fresh airdrop every time). The mnemonic is NEVER written
 * to a file, only ever printed to the console.
 *
 * Env vars:
 *   FLUXIO_DEMO_SEED="word1 word2 ... word12"
 *     Reuse a specific throwaway payer account instead of generating a
 *     new one every run — see devnet-transfer-demo.mjs's own header for
 *     the full reasoning (identical mechanism, reused verbatim here).
 *   FLUXIO_DEMO_RECIPIENT="<base58 address>"
 *     Address to create the token account for and mint into. Defaults to
 *     HM2tV6hdcRFvPkcspwWvs9KU7rwKTyEa6UXGPc6v6TFy (this project's own
 *     dev wallet address, per this slice's prompt).
 *
 * This deliberately calls @fluxio/crypto's lower-level primitives
 * directly (generateMnemonic, mnemonicToSeed, deriveSolanaAccount)
 * instead of going through walletService — same reasoning as
 * devnet-transfer-demo.mjs: walletService's persistence needs
 * chrome.storage.local/localStorage, neither of which exists in a plain
 * Node process. Mint/account-creation/mintTo themselves go through
 * packages/services/splTokenAdmin.js — a dev/demo-only admin module, NOT
 * reachable via @fluxio/services's package.json exports map and NOT
 * imported by tokenService.js itself (which stays strictly read-only —
 * see its own header comment). This script is one of exactly two real
 * consumers of that module (the other is tokenService's own opt-in local-
 * integration test).
 */
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '../packages/crypto/mnemonic.js';
import { deriveSolanaAccount } from '../packages/crypto/derivation.js';
import { NETWORK_KEYS, NETWORKS } from '../packages/constants/networks.js';
import { requestDevnetAirdrop, getTransactionStatus, waitForBalanceAtLeast, getSolBalance } from '../packages/services/transactionService.js';
import { mintDemoSplToken } from '../packages/services/splTokenAdmin.js';

const NETWORK = NETWORK_KEYS.SOLANA_LOCAL;
const LOCAL = NETWORKS[NETWORK];
const HEALTH_CHECK_TIMEOUT_MS = 3000;
const AIRDROP_LAMPORTS = 1_000_000_000n; // 1 SOL — unrestricted on a local validator, covers mint-account rent + fees comfortably
const FEE_BUFFER_LAMPORTS = 20_000n;
const DEFAULT_RECIPIENT = 'HM2tV6hdcRFvPkcspwWvs9KU7rwKTyEa6UXGPc6v6TFy';
const TOKEN_DECIMALS = 6;
const MINT_AMOUNT_RAW = 1_000_000_000n; // 1000.000000 tokens at 6 decimals
const TOKEN_SYMBOL = 'FDX';
const TOKEN_NAME = 'Fluxio Demo SPL';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

/** Fails fast with a clear message instead of letting a later step hang indefinitely against an unreachable endpoint. */
async function isLocalValidatorUp() {
  try {
    const res = await withTimeout(
      fetch(LOCAL.rpc.default, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] })
      }),
      HEALTH_CHECK_TIMEOUT_MS
    );
    return res.ok;
  } catch {
    return false;
  }
}

function throwawayAccount() {
  const mnemonic = generateMnemonic(12);
  return { mnemonic, ...deriveSolanaAccount(mnemonicToSeed(mnemonic), 0) };
}

function resolvePayerAccount() {
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

async function waitForConfirmation(signature) {
  const MAX_ATTEMPTS = 30;
  const POLL_DELAY_MS = 500;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const status = await getTransactionStatus({ network: NETWORK, signature });
    if (status.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    }
    if (status.status === 'confirmed' || status.status === 'finalized') {
      return status;
    }
    await sleep(POLL_DELAY_MS);
  }
  throw new Error(`Timed out waiting for ${signature} to confirm.`);
}

/**
 * Prints two independent ways to register the freshly-minted token —
 * neither replaces the other, both always printed:
 *
 *   1. PRIMARY: the extension's own Manage Tokens UI (Settings -> Manage
 *      Tokens -> pick this network -> Add token), which now does exactly
 *      what the console snippet below does by hand — validates the
 *      address, fetches real on-chain metadata, refuses a dead/duplicate
 *      entry — but through a real form instead of a paste ritual. This
 *      is the path most people should reach for.
 *   2. FALLBACK: the original service-worker-console snippet (chrome://
 *      extensions -> Fluxio -> "Inspect views: service worker"), kept
 *      because it needs no unlocked popup/running UI at all — useful for
 *      scripting/automation, or if the UI path is ever unavailable for
 *      some reason. Still requires typing "allow pasting" first (Chrome's
 *      default paste-blocking self-XSS guard).
 *
 * Deliberately REPLACES every existing custom-token entry for this SAME
 * local network in the snippet path, not just one matching this exact
 * mint address (the UI path has no equivalent "replace everything"
 * behavior — each Add is a single explicit action, and old dead entries
 * are just as easy to Remove individually there now). A restarted
 * solana-test-validator resets its whole chain state — every mint any
 * earlier run of this script created is unconditionally gone, with
 * certainty, not "maybe" — so any other leftover entry for
 * `solana-local` in storage is already known-dead the moment this script
 * runs again. Since a dead custom-token entry no longer breaks the whole
 * network's fetch (see tokenService.js's per-item resilience fix),
 * leaving old entries around is "merely" silent clutter rather than a
 * crash — but for Solana specifically that clutter is genuinely harmless
 * either way (a stale mint in the merged registry only affects symbol/
 * name lookup for a mint the owner would have to actually hold to ever
 * see; it never costs an extra RPC call the way a stale EVM entry does —
 * see erc20-local-demo.mjs's own version of this comment for that
 * asymmetry). Still cleared here for consistency with the EVM script and
 * to keep chrome.storage.local from accumulating dead entries forever
 * across repeated runs.
 */
function printRegistrationInstructions(mintAddress) {
  const entry = { symbol: TOKEN_SYMBOL, name: TOKEN_NAME, decimals: TOKEN_DECIMALS, address: mintAddress };

  console.log('\n--- How to register this token in the extension ---\n');
  console.log('Option 1 (recommended): open the popup -> Settings -> Manage Tokens -> pick this network -> Add token, and paste this address:');
  console.log(`\n  ${mintAddress}\n`);
  console.log(
    `(Symbol/name are optional there — leave them blank for "Unknown", or type ${entry.symbol}/${entry.name} to match this script's own values. Decimals is always read from the mint itself for a Solana token, not something you enter — no need to type ${entry.decimals}.)`
  );

  console.log('\nOption 2 (fallback — no UI needed): paste this into the extension service-worker console instead.');
  console.log(
    'Chrome blocks pasting into the DevTools console by default (a self-XSS guard). If you see a warning instead of your snippet running, type '
  );
  console.log("  allow pasting\n");
  console.log('into the console first (press Enter), then paste the snippet below.\n');
  console.log(
    `chrome.storage.local.get(['fluxio_custom_tokens'], (r) => {\n` +
      `  const all = r.fluxio_custom_tokens || {};\n` +
      `  all['${NETWORK}'] = [${JSON.stringify(entry)}]; // replaces every prior entry for this network — see this function's own comment\n` +
      `  chrome.storage.local.set({ fluxio_custom_tokens: all }, () => console.log('Registered ${entry.symbol} on ${NETWORK}.'));\n` +
      `});\n`
  );
}

async function main() {
  console.log(`--- Fluxio SPL token demo (${LOCAL.name}) ---\n`);

  if (!(await isLocalValidatorUp())) {
    console.error(`Could not reach ${LOCAL.name} at ${LOCAL.rpc.default}.`);
    console.error('Is solana-test-validator running? (typically inside WSL: `solana-test-validator`)\n');
    process.exitCode = 1;
    return;
  }

  const recipient = process.env.FLUXIO_DEMO_RECIPIENT || DEFAULT_RECIPIENT;
  const { account: payer, reused } = resolvePayerAccount();
  console.log(reused ? 'Reusing payer account from FLUXIO_DEMO_SEED.' : 'Generated a fresh throwaway payer account.');
  console.log(`  Payer:     ${payer.address}`);
  console.log(`  Recipient: ${recipient}\n`);

  let payerBalance = 0n;
  if (reused) {
    try {
      payerBalance = await getSolBalance({ network: NETWORK, address: payer.address });
      console.log(`Payer's current balance: ${payerBalance} lamports.\n`);
    } catch (err) {
      console.warn(`Could not check payer balance up front (continuing to the airdrop step anyway): ${err.message}\n`);
    }
  }

  if (payerBalance >= FEE_BUFFER_LAMPORTS) {
    console.log('Payer is already funded — skipping the airdrop.\n');
  } else {
    console.log(`Requesting a 1 SOL airdrop for the payer on ${LOCAL.name}...`);
    try {
      const { signature } = await requestDevnetAirdrop({ network: NETWORK, address: payer.address, lamports: AIRDROP_LAMPORTS });
      console.log('  Waiting for the airdrop to confirm...');
      await waitForConfirmation(signature);
      console.log('  Airdrop confirmed — waiting for the balance to actually become visible...');
      // Same fix as devnet-transfer-demo.mjs's own waitForBalanceAtLeast
      // call — a 'confirmed' airdrop signature doesn't guarantee an
      // immediately-following balance read reflects it yet.
      await waitForBalanceAtLeast({ network: NETWORK, address: payer.address, minLamports: payerBalance + AIRDROP_LAMPORTS }, { timeoutMs: 15000 });
      console.log('  Balance confirmed visible.\n');
    } catch (err) {
      console.error(`\nAirdrop failed: ${err.message}`);
      console.error(`This almost always means solana-test-validator isn't actually running/reachable, since a local airdrop has no rate limit to fail on.`);
      if (!reused) {
        console.error(`\nRerun against this SAME payer account once it's up:`);
        console.error(`  FLUXIO_DEMO_SEED="${payer.mnemonic}" node scripts/spl-token-demo.mjs\n`);
      }
      process.exitCode = 1;
      return;
    }
  }

  console.log(`Creating a new SPL mint (decimals=${TOKEN_DECIMALS}), token account for the recipient, and minting ${MINT_AMOUNT_RAW} raw units...`);
  const { mintAddress, tokenAccountAddress, mintSignature } = await mintDemoSplToken({
    rpcUrl: LOCAL.rpc.default,
    payerSecretKey: payer.secretKey,
    recipientAddress: recipient,
    decimals: TOKEN_DECIMALS,
    amountRaw: MINT_AMOUNT_RAW
  });

  console.log('\nDone.');
  console.log(`  Mint:          ${mintAddress}`);
  console.log(`  Token account: ${tokenAccountAddress}`);
  console.log(`  Mint tx:       ${mintSignature}`);

  printRegistrationInstructions(mintAddress);

  payer.secretKey.fill(0);
}

main().catch((err) => {
  console.error(`\nDemo failed: ${err.message}`);
  process.exitCode = 1;
});
