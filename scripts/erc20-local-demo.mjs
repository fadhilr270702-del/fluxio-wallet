#!/usr/bin/env node
/**
 * Manual, one-off proof that tokenService.js's ERC-20 balance path works
 * end-to-end against a REAL deployed contract — compiles and deploys a
 * minimal ERC-20 (see packages/services/erc20Admin.js), transfers some of
 * it to a recipient, then prints a ready-to-paste chrome.storage snippet
 * to register that contract as a custom token in the running extension
 * (see apps/extension/background/background.js's CUSTOM_TOKENS_STORAGE_KEY
 * comment — same mechanism scripts/spl-token-demo.mjs uses on the Solana
 * side) — a fallback path kept for developers without a running UI to
 * click through; the extension's own Manage Tokens screen (Settings ->
 * Manage Tokens, prompt 0109) is the normal way to register a custom
 * token now.
 *
 * NOT part of the app, not wired into any package.json script, run
 * directly by a developer as evidence. Runs ONLY against a local anvil
 * node (127.0.0.1:8545, @fluxio/constants/networks.js's `ethereum-local`)
 * — deploying a fresh contract on every run is exactly the kind of "free,
 * no rate limit" testing anvil exists for (see evm-transfer-demo.mjs's
 * own header for the same reasoning). You must already have `anvil`
 * running yourself (typically via WSL) — this script never starts one,
 * and fails with a clear message up front if it isn't reachable, rather
 * than hanging (ethers' JsonRpcProvider has no default timeout of its
 * own against an unreachable endpoint — confirmed directly while building
 * this script, not just assumed — so the health check below is load-
 * bearing, not just a nicety).
 *
 * The deployer is anvil's well-known default Account #0
 * (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, private key
 * 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80).
 * This is safe to hardcode here: it is anvil's own publicly-documented
 * default dev account, pre-funded automatically by anvil itself on every
 * fresh start — not a real account, and never holds anything of value.
 * Never reuse this key against any network other than a local anvil.
 *
 * Env vars:
 *   FLUXIO_DEMO_RECIPIENT="0x..."
 *     Address to transfer demo tokens to. Defaults to
 *     0x4B2c00fD7647780F1d21694Ce51feA235De7Ca39, per this slice's prompt.
 *
 * Contract compile+deploy+transfer all go through
 * packages/services/erc20Admin.js — a dev/demo-only admin module, NOT
 * reachable via @fluxio/services's package.json exports map and NOT
 * imported by tokenService.js itself (which stays strictly read-only —
 * see its own header comment). This script is one of exactly two real
 * consumers of that module (the other is tokenService's own opt-in local-
 * integration test).
 */
import { NETWORK_KEYS, NETWORKS } from '../packages/constants/networks.js';
import { deployAndTransferDemoErc20 } from '../packages/services/erc20Admin.js';

const NETWORK = NETWORK_KEYS.ETHEREUM_LOCAL;
const LOCAL = NETWORKS[NETWORK];
const HEALTH_CHECK_TIMEOUT_MS = 3000;

// Anvil's well-known default Account #0 — see the file header comment for
// why hardcoding this specific key is safe.
const DEPLOYER_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEFAULT_RECIPIENT = '0x4B2c00fD7647780F1d21694Ce51feA235De7Ca39';

const TOKEN_NAME = 'Fluxio Demo ERC20';
const TOKEN_SYMBOL = 'FDX';
const TOKEN_DECIMALS = 6;
const INITIAL_SUPPLY_RAW = 1_000_000_000_000n; // 1,000,000.000000 tokens
const TRANSFER_AMOUNT_RAW = 1_000_000_000n; // 1,000.000000 tokens

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

/** Fails fast with a clear message instead of letting the deploy step hang indefinitely — see the file header comment. */
async function isAnvilUp() {
  try {
    const res = await withTimeout(
      fetch(LOCAL.rpc.default, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
      }),
      HEALTH_CHECK_TIMEOUT_MS
    );
    if (!res.ok) return false;
    const body = await res.json();
    return typeof body?.result === 'string';
  } catch {
    return false;
  }
}

/**
 * Prints two independent ways to register the freshly-deployed token —
 * neither replaces the other, both always printed:
 *
 *   1. PRIMARY: the extension's own Manage Tokens UI (Settings -> Manage
 *      Tokens -> pick this network -> Add token), which now does exactly
 *      what the console snippet below does by hand — validates the
 *      address, fetches real on-chain symbol()/name()/decimals(),
 *      refuses a dead/duplicate contract — but through a real form
 *      instead of a paste ritual. This is the path most people should
 *      reach for.
 *   2. FALLBACK: the original service-worker-console snippet (chrome://
 *      extensions -> Fluxio -> "Inspect views: service worker"), kept
 *      because it needs no unlocked popup/running UI at all — useful for
 *      scripting/automation, or if the UI path is ever unavailable for
 *      some reason. Still requires typing "allow pasting" first (Chrome's
 *      default paste-blocking self-XSS guard).
 *
 * Deliberately REPLACES every existing custom-token entry for this SAME
 * local network in the snippet path, not just one matching this exact
 * contract address (the UI path has no equivalent "replace everything"
 * behavior — each Add is a single explicit action, and old dead entries
 * are just as easy to Remove individually there now). A restarted anvil
 * resets its whole chain state — every contract any earlier run of this
 * script deployed is unconditionally gone, with certainty, not "maybe" —
 * confirmed directly while verifying the fix that made dead entries
 * non-fatal: this session's own anvil instance restarted between two
 * runs of this script, silently turning a previously-registered "live"
 * contract dead. Clearing here matters MORE on the EVM side than the SPL
 * side (see spl-token-demo.mjs's version of this comment for that
 * asymmetry): a stale EVM entry costs a real eth_call every single popup
 * open forever — not just clutter, an ongoing (if now gracefully-
 * skipped, not crashing) RPC cost — whereas a stale SPL mint entry only
 * affects a symbol/name lookup that's cheap regardless.
 */
function printRegistrationInstructions(contractAddress) {
  const entry = { symbol: TOKEN_SYMBOL, name: TOKEN_NAME, decimals: TOKEN_DECIMALS, address: contractAddress };

  console.log('\n--- How to register this token in the extension ---\n');
  console.log('Option 1 (recommended): open the popup -> Settings -> Manage Tokens -> pick this network -> Add token, and paste this address:');
  console.log(`\n  ${contractAddress}\n`);
  console.log(
    `(Symbol/name/decimals are all optional there — leave them blank to auto-fetch from the contract itself, or type ${entry.symbol}/${entry.name}/${entry.decimals} to match this script's own values.)`
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
  console.log(`--- Fluxio ERC-20 token demo (${LOCAL.name}) ---\n`);

  if (!(await isAnvilUp())) {
    console.error(`Could not reach ${LOCAL.name} at ${LOCAL.rpc.default}.`);
    console.error('Is anvil running? (typically inside WSL: `anvil`)\n');
    process.exitCode = 1;
    return;
  }

  const recipient = process.env.FLUXIO_DEMO_RECIPIENT || DEFAULT_RECIPIENT;
  console.log(`  Deployer:  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (anvil default Account #0)`);
  console.log(`  Recipient: ${recipient}\n`);

  console.log(`Compiling ${TOKEN_NAME} (${TOKEN_SYMBOL}), deploying, and transferring ${TRANSFER_AMOUNT_RAW} raw units to the recipient...`);
  const { contractAddress, transferTxHash } = await deployAndTransferDemoErc20({
    rpcUrl: LOCAL.rpc.default,
    deployerPrivateKey: DEPLOYER_PRIVATE_KEY,
    recipientAddress: recipient,
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    decimals: TOKEN_DECIMALS,
    initialSupplyRaw: INITIAL_SUPPLY_RAW,
    transferAmountRaw: TRANSFER_AMOUNT_RAW
  });

  console.log('\nDone.');
  console.log(`  Contract:    ${contractAddress}`);
  console.log(`  Transfer tx: ${transferTxHash}`);

  printRegistrationInstructions(contractAddress);
}

main().catch((err) => {
  console.error(`\nDemo failed: ${err.message}`);
  process.exitCode = 1;
});
