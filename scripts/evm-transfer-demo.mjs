#!/usr/bin/env node
/**
 * Manual, one-off proof that the real native ETH transfer pipeline works
 * end-to-end (construct -> sign via the real ethers-based signing boundary
 * -> broadcast -> confirm) — the EVM sibling of devnet-transfer-demo.mjs.
 * NOT part of the app, not wired into any package.json script, run
 * directly by a developer as evidence.
 *
 * The sender is a throwaway secp256k1 account derived from its own BIP-39
 * mnemonic — by default a fresh one generated every run, held only in
 * memory and best-effort discarded at the end. The mnemonic itself is
 * NEVER written to a file, only ever printed to the console, same rule as
 * devnet-transfer-demo.mjs.
 *
 * Two env vars pick the network and (optionally) reuse a specific sender:
 *
 *   FLUXIO_EVM_NETWORK=local (default) | sepolia
 *     "local" runs against a local anvil node (@fluxio/constants/networks.js's
 *     `ethereum-local`, http://127.0.0.1:8545 by default) — you must
 *     already have one running yourself (`anvil`, typically via WSL — see
 *     this script's own closing instructions / CLAUDE.md); this script
 *     never starts one. Funding uses anvil's own `anvil_setBalance` RPC
 *     method (the closest thing to Solana's requestAirdrop — there is no
 *     programmatic EVM-testnet faucet RPC method anywhere in this repo),
 *     which is unrestricted, so there's no rate limit to retry around.
 *
 *     "sepolia" runs against the public Sepolia testnet
 *     (`ethereum-sepolia`). There is no anvil_setBalance equivalent on a
 *     real public testnet — this script CANNOT fund a sepolia sender
 *     itself. You must supply an already-funded account via
 *     FLUXIO_DEMO_SEED (funded manually through a faucet, e.g.
 *     https://sepoliafaucet.com) — the script checks the balance first
 *     and prints clear next-step instructions (in both bash and
 *     PowerShell) if it's insufficient, rather than guessing.
 *
 *   FLUXIO_DEMO_SEED="word1 word2 ... word12"
 *     Reuses a specific throwaway account instead of generating a new one
 *     every run — required for sepolia mode (see above), optional for
 *     local mode (still convenient: same funded address across runs
 *     instead of a fresh anvil_setBalance every time).
 *
 * This deliberately calls @fluxio/crypto's lower-level primitives
 * directly (generateMnemonic, mnemonicToSeed, deriveEvmAccount,
 * createSigner) instead of going through walletService/vault, for the
 * same reason devnet-transfer-demo.mjs does: walletService's persistence
 * needs chrome.storage.local/localStorage, neither of which exists in a
 * plain Node process. evmTransactionService.js was built with this in
 * mind — it never imports walletService, only taking a `sign` callback
 * from its caller (here, `signer.signTransaction` from a signer built
 * directly off the throwaway private key below, the same
 * createSigner()/evmSigner.js boundary walletService itself uses
 * internally — the private key never leaves this signer object).
 */
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '../packages/crypto/mnemonic.js';
import { deriveEvmAccount } from '../packages/crypto/derivation.js';
import { createSigner } from '../packages/crypto/signer/index.js';
import { fetchRpcWithFallback } from '../packages/crypto/rpc.js';
import { ACCOUNT_TYPES } from '../packages/constants/derivationPaths.js';
import { NETWORK_KEYS, NETWORKS } from '../packages/constants/networks.js';
import {
  estimateEthTransfer,
  sendEthTransfer,
  getEvmTransactionStatus,
  getEvmBalance
} from '../packages/services/evmTransactionService.js';
import { ethToWei, weiToEth } from '../packages/utils/ethAmount.js';

/** FLUXIO_EVM_NETWORK=sepolia switches the whole demo to public Sepolia; anything else (including unset) stays on local anvil — see the file header comment above. */
function resolveDemoNetwork() {
  const raw = (process.env.FLUXIO_EVM_NETWORK || 'local').trim().toLowerCase();
  if (raw === 'local') return NETWORK_KEYS.ETHEREUM_LOCAL;
  if (raw === 'sepolia') return NETWORK_KEYS.ETHEREUM_SEPOLIA;
  throw new Error(`Unknown FLUXIO_EVM_NETWORK "${raw}" — expected "local" (default) or "sepolia".`);
}

const NETWORK = resolveDemoNetwork();
const IS_LOCAL = NETWORK === NETWORK_KEYS.ETHEREUM_LOCAL;
const FUND_WEI = ethToWei('1'); // 1 ETH, local-mode anvil_setBalance amount
const TRANSFER_ETH = '0.01';
const TRANSFER_WEI = ethToWei(TRANSFER_ETH);
// A conservative buffer over a typical 21000-gas EIP-1559 transfer's max
// fee, used only for the up-front "is funding even needed?" balance check
// below — sendEthTransfer() itself still does the precise amount+maxFee
// check before actually broadcasting, this is just to decide whether to
// skip the funding step.
const FEE_BUFFER_WEI = ethToWei('0.01');
const CONFIRM_MAX_ATTEMPTS = 30;
const CONFIRM_POLL_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fresh throwaway EVM account: its own mnemonic, generated and used only in memory. */
function throwawayAccount() {
  const mnemonic = generateMnemonic(12);
  return { mnemonic, ...deriveEvmAccount(mnemonicToSeed(mnemonic), 0) };
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
  const account = { mnemonic: envSeed, ...deriveEvmAccount(mnemonicToSeed(envSeed), 0) };
  return { account, reused: true };
}

async function anvilSetBalance(address, weiAmount) {
  await fetchRpcWithFallback(NETWORKS[NETWORK], {
    jsonrpc: '2.0',
    id: 1,
    method: 'anvil_setBalance',
    params: [address, `0x${weiAmount.toString(16)}`]
  });
}

async function waitForFinalized(hash) {
  for (let attempt = 1; attempt <= CONFIRM_MAX_ATTEMPTS; attempt++) {
    const status = await getEvmTransactionStatus({ network: NETWORK, hash });
    if (status.status === 'failed') {
      throw new Error(`Transaction reverted on-chain: ${JSON.stringify(status.err)}`);
    }
    if (status.status === 'finalized') {
      return status;
    }
    await sleep(CONFIRM_POLL_DELAY_MS);
  }
  throw new Error(`Timed out waiting for ${hash} to be mined — check the explorer link manually (if this network has one), it may still land.`);
}

/** Printed both when a local anvil node isn't reachable, and when a sepolia sender needs manual faucet funding. Two shells, since this developer is on Windows (bash inside WSL is still the expected way to run anvil itself). */
function printFundingHelp(account) {
  console.error('\n--- Funding needed — here is how to continue ---');
  console.error('This is a throwaway, testnet-only account with no real value — never reuse it for anything but this script.');
  console.error(`\n  Address:      ${account.address}`);
  console.error(`  Seed phrase:  ${account.mnemonic}`);

  if (IS_LOCAL) {
    console.error(`\nFunding via anvil_setBalance failed. This almost always means anvil isn't running (or isn't reachable at ${NETWORKS[NETWORK].rpc.default}), since anvil_setBalance itself has no rate limit to fail on.`);
    console.error('\nStart anvil (typically inside WSL), then rerun against this SAME account:');
    console.error('\n  Bash (WSL):');
    console.error('    anvil');
    console.error(`    FLUXIO_EVM_NETWORK=local FLUXIO_DEMO_SEED="${account.mnemonic}" node scripts/evm-transfer-demo.mjs`);
    console.error('\n  PowerShell (this script, from Windows, pointed at anvil running in WSL on 127.0.0.1:8545):');
    console.error(`    $env:FLUXIO_EVM_NETWORK="local"; $env:FLUXIO_DEMO_SEED="${account.mnemonic}"; node scripts/evm-transfer-demo.mjs\n`);
    return;
  }

  console.error('\nSepolia has no programmatic faucet RPC method — this script cannot fund the sender itself. Pick one:');
  console.error(`  1. Fund this address manually via a Sepolia faucet (e.g. https://sepoliafaucet.com or https://www.alchemy.com/faucets/ethereum-sepolia), then rerun with the SAME seed:`);
  console.error('\n     Bash:');
  console.error(`       FLUXIO_EVM_NETWORK=sepolia FLUXIO_DEMO_SEED="${account.mnemonic}" node scripts/evm-transfer-demo.mjs`);
  console.error('\n     PowerShell:');
  console.error(`       $env:FLUXIO_EVM_NETWORK="sepolia"; $env:FLUXIO_DEMO_SEED="${account.mnemonic}"; node scripts/evm-transfer-demo.mjs`);
  console.error('\n  2. Or sidestep the public faucet entirely: run with FLUXIO_EVM_NETWORK=local (the default) against your own local anvil node instead.\n');
}

async function main() {
  console.log(`--- Fluxio ${NETWORKS[NETWORK].name} ETH transfer demo ---\n`);

  const { account: sender, reused } = resolveSenderAccount();
  const recipient = throwawayAccount();
  console.log(reused ? 'Reusing sender account from FLUXIO_DEMO_SEED.' : 'Generated a fresh throwaway sender account.');
  console.log(`  Sender:    ${sender.address}`);
  console.log(`  Recipient: ${recipient.address}\n`);

  let senderBalance = 0n;
  try {
    senderBalance = await getEvmBalance({ network: NETWORK, address: sender.address });
    console.log(`Sender's current balance: ${weiToEth(senderBalance)} ETH.\n`);
  } catch (err) {
    console.warn(`Could not check sender balance up front (continuing anyway): ${err.message}\n`);
  }

  const needed = TRANSFER_WEI + FEE_BUFFER_WEI;
  if (senderBalance >= needed) {
    console.log('Sender is already funded enough for this transfer — skipping the funding step.\n');
  } else if (IS_LOCAL) {
    console.log(`Funding sender with ${weiToEth(FUND_WEI)} ETH via anvil_setBalance...`);
    try {
      await anvilSetBalance(sender.address, senderBalance + FUND_WEI);
      console.log('  Funded.\n');
    } catch (err) {
      printFundingHelp(sender);
      throw err;
    }
  } else {
    printFundingHelp(sender);
    throw new Error('Sender balance is insufficient on Sepolia and this script cannot fund it automatically — see instructions above.');
  }

  console.log('Estimating the EIP-1559 fee...');
  const estimate = await estimateEthTransfer({
    network: NETWORK,
    from: sender.address,
    to: recipient.address,
    amountEth: TRANSFER_ETH
  });
  console.log(`  maxFeePerGas: ${estimate.maxFeePerGas} wei, maxPriorityFeePerGas: ${estimate.maxPriorityFeePerGas} wei, gasLimit: ${estimate.gasLimit}`);
  console.log(`  Max possible fee: ${weiToEth(estimate.maxFeeWei)} ETH (actual fee charged will likely be lower)\n`);

  console.log(`Sending ${TRANSFER_ETH} ETH from sender to recipient...`);
  const signer = createSigner(ACCOUNT_TYPES.EVM, sender.privateKey);
  const { hash, explorerUrl } = await sendEthTransfer({
    network: NETWORK,
    from: sender.address,
    to: recipient.address,
    amountEth: TRANSFER_ETH,
    // The one non-custodial contract this whole feature is built around:
    // evmTransactionService never sees sender.privateKey, only this
    // callback, which routes the transaction request through the same
    // ethers-based signer walletService itself uses.
    sign: (transactionRequest) => signer.signTransaction(transactionRequest)
  });
  signer.dispose();

  console.log(`  Transaction sent: ${hash}`);
  console.log(explorerUrl ? `  Explorer: ${explorerUrl}` : '  (This network has no block explorer.)');
  console.log('  Waiting for it to be mined...');
  const finalStatus = await waitForFinalized(hash);

  const recipientBalance = await getEvmBalance({ network: NETWORK, address: recipient.address });
  console.log(`\nDone — status: ${finalStatus.status}`);
  console.log(`Hash:               ${hash}`);
  console.log(`Recipient balance:  ${weiToEth(recipientBalance)} ETH`);
}

main().catch((err) => {
  console.error(`\nDemo failed: ${err.message}`);
  process.exitCode = 1;
});
