/**
 * Real integration test against an actual anvil node (Foundry's local EVM
 * dev node — `anvil`, default RPC http://127.0.0.1:8545) — the EVM sibling
 * of transactionService.local-integration.test.js. Mocks can't catch
 * everything: transactionService's own local-integration test exists
 * specifically because two real bugs shipped past every mocked Solana
 * test (see prompt/0095) and only a real RPC round-trip against a real
 * node ever caught them. This test exists as the same kind of backstop
 * for the EVM path, not because a specific bug is already known here.
 *
 * Skips itself automatically (not a failure) when nothing is listening on
 * ethereum-local's RPC endpoint — opt-in coverage for whoever has anvil
 * running locally, not a requirement for the normal suite/CI. `pnpm test`
 * stays green either way.
 *
 * UPDATE (prompt 0113): this file's original note said it had never been
 * run against a real anvil — a live anvil instance became available in a
 * later session and this test (plus the sendErc20Transfer one added
 * below) has since run and passed against it for real, so that caveat no
 * longer applies. Still opt-in/skip-if-down, same as every other
 * local-integration test in this repo.
 */
import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import {
  estimateEthTransfer,
  sendEthTransfer,
  getEvmTransactionStatus,
  getEvmBalance,
  estimateErc20Transfer,
  sendErc20Transfer
} from '../evmTransactionService.js';
import { deployAndTransferDemoErc20 } from '../erc20Admin.js';
import { NETWORKS } from '@fluxio/constants';
import { fetchRpcWithFallback } from '@fluxio/crypto/rpc';

const LOCAL = NETWORKS['ethereum-local'];
const HEALTH_CHECK_TIMEOUT_MS = 3000;

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

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function anvilSetBalance(address, weiAmount) {
  await fetchRpcWithFallback(LOCAL, {
    jsonrpc: '2.0',
    id: 1,
    method: 'anvil_setBalance',
    params: [address, `0x${weiAmount.toString(16)}`]
  });
}

async function waitForFinalized(hash, { maxAttempts = 30, pollIntervalMs = 500 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await getEvmTransactionStatus({ network: 'ethereum-local', hash });
    if (status.status === 'finalized' || status.status === 'failed') {
      return status;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${hash} to be mined.`);
}

// Determined once, at collection time (top-level await is fine in an ESM
// vitest test file) — describe.skipIf needs a plain boolean, not a promise.
const anvilUp = await isAnvilUp();

describe.skipIf(!anvilUp)('evmTransactionService — real ethereum-local (anvil) integration', () => {
  it(
    'anvil_setBalance -> estimateEthTransfer -> sendEthTransfer -> getEvmTransactionStatus all succeed end-to-end against a real node',
    async () => {
      const sender = Wallet.createRandom();
      const recipient = Wallet.createRandom();
      const FUND_WEI = 10n ** 18n; // 1 ETH — anvil_setBalance is unrestricted, no rate limit to work around
      const TRANSFER_WEI = 10_000_000_000_000_000n; // 0.01 ETH

      await anvilSetBalance(sender.address, FUND_WEI);
      const fundedBalance = await getEvmBalance({ network: 'ethereum-local', address: sender.address });
      expect(fundedBalance).toBe(FUND_WEI);

      const estimate = await estimateEthTransfer({
        network: 'ethereum-local',
        from: sender.address,
        to: recipient.address,
        amountEth: '0.01'
      });
      expect(estimate.gasLimit).toBe(21000n);
      expect(estimate.maxFeePerGas).toBeGreaterThan(0n);

      const sign = async (transactionRequest) => sender.signTransaction(transactionRequest);
      const { hash, explorerUrl } = await sendEthTransfer({
        network: 'ethereum-local',
        from: sender.address,
        to: recipient.address,
        amountEth: '0.01',
        sign
      });
      expect(typeof hash).toBe('string');
      expect(hash.startsWith('0x')).toBe(true);
      // ethereum-local has no configured explorer (see networks.js) —
      // confirmed for real here, not just by reading the config.
      expect(explorerUrl).toBeNull();

      const finalStatus = await waitForFinalized(hash);
      expect(finalStatus.status).toBe('finalized');
      expect(finalStatus.err).toBeNull();

      const recipientBalance = await getEvmBalance({ network: 'ethereum-local', address: recipient.address });
      expect(recipientBalance).toBe(TRANSFER_WEI);
    },
    60000
  );
});

/**
 * ERC-20 token transfer (prompt 0113) — real deploy -> send -> assert-
 * balance-moved, against the ACTUAL sendErc20Transfer implementation (not
 * a mock), proving Tahap B works end to end against a real anvil node:
 * real eth_estimateGas-derived gas (asserted well above the native
 * transfer's fixed 21000n), real transfer(address,uint256) calldata, and
 * a genuine on-chain balanceOf() balance movement.
 */
describe.skipIf(!anvilUp)('sendErc20Transfer — real ethereum-local (anvil) integration', () => {
  it(
    'deploys a real ERC-20, sends it to a fresh recipient, and the balance genuinely moves on-chain',
    async () => {
      const deployer = Wallet.createRandom();
      const recipient = Wallet.createRandom();
      const FUND_WEI = 10n ** 18n; // 1 ETH — plenty for a deploy + one transfer
      const DECIMALS = 6;
      const INITIAL_SUPPLY_RAW = 1_000_000_000n; // 1000.000000 tokens, all to the deployer
      const TRANSFER_AMOUNT_RAW = 42_500_000n; // 42.5 tokens

      await anvilSetBalance(deployer.address, FUND_WEI);

      // Deploys the same demo contract deployAndTransferDemoErc20 already
      // uses (see tokenService.local-integration.test.js) — self-transfer
      // 0 to the deployer's own address, so the ENTIRE initial supply
      // stays with `deployer`, the sender under test below.
      const { contractAddress } = await deployAndTransferDemoErc20({
        rpcUrl: LOCAL.rpc.default,
        deployerPrivateKey: deployer.privateKey,
        recipientAddress: deployer.address,
        name: 'Integration Send Token',
        symbol: 'IST',
        decimals: DECIMALS,
        initialSupplyRaw: INITIAL_SUPPLY_RAW,
        transferAmountRaw: 0n
      });

      const estimate = await estimateErc20Transfer({
        network: 'ethereum-local',
        from: deployer.address,
        to: recipient.address,
        tokenAddress: contractAddress,
        amountRaw: TRANSFER_AMOUNT_RAW
      });
      expect(estimate.tokenBalanceRaw).toBe(INITIAL_SUPPLY_RAW);
      // Real eth_estimateGas against real transfer() calldata — must exceed
      // the native transfer's fixed 21000n, not just equal/hardcode it.
      expect(estimate.gasLimit).toBeGreaterThan(21000n);

      const sign = async (transactionRequest) => deployer.signTransaction(transactionRequest);
      const { hash, explorerUrl, amountRaw } = await sendErc20Transfer({
        network: 'ethereum-local',
        from: deployer.address,
        to: recipient.address,
        tokenAddress: contractAddress,
        amountRaw: TRANSFER_AMOUNT_RAW,
        sign
      });
      expect(amountRaw).toBe(TRANSFER_AMOUNT_RAW);
      expect(explorerUrl).toBeNull(); // ethereum-local has no configured explorer

      const finalStatus = await waitForFinalized(hash);
      expect(finalStatus.status).toBe('finalized');
      expect(finalStatus.err).toBeNull();

      // The real, on-chain proof: a direct balanceOf() eth_call against the
      // deployed contract, not a re-use of anything sendErc20Transfer itself computed.
      const paddedRecipient = recipient.address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
      const balanceData = await fetchRpcWithFallback(LOCAL, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: contractAddress, data: `0x70a08231${paddedRecipient}` }, 'latest']
      });
      expect(BigInt(balanceData.result)).toBe(TRANSFER_AMOUNT_RAW);
    },
    60000
  );
});
