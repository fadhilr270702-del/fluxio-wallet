/**
 * Real integration tests against an actual solana-test-validator AND an
 * actual anvil node — the token-balance sibling of
 * transactionService.local-integration.test.js /
 * evmTransactionService.local-integration.test.js (see those files' own
 * header comments for why a real RPC round trip matters here, not just a
 * mock: a mock can't catch a wrong RPC method name, an actual response
 * shape mismatch, or a real on-chain nonce/timing race — see
 * erc20Admin.js's own header comment for a live nonce bug this exact
 * kind of test caught while this slice was being built).
 *
 * Each half (Solana / EVM) skips itself automatically (not a failure)
 * when its own local node isn't reachable — opt-in coverage for whoever
 * has one running, not a requirement for the normal suite/CI. `pnpm test`
 * stays green either way. The two halves are independent: an anvil-only
 * or validator-only machine still gets partial coverage instead of an
 * all-or-nothing skip.
 *
 * Mint/deploy/transfer setup goes through splTokenAdmin.js/erc20Admin.js
 * — the same dev-only admin modules scripts/spl-token-demo.mjs and
 * scripts/erc20-local-demo.mjs use — so this test is exercising the exact
 * same on-chain setup path as those scripts, just against fresh
 * throwaway accounts instead of a fixed developer address (so repeated
 * test runs never accumulate balance against one address in a way that
 * would make assertions ambiguous).
 */
import { describe, it, expect } from 'vitest';
import { Wallet as EvmWallet } from 'ethers';
import { getTokenBalances } from '../tokenService.js';
import { mintDemoSplToken } from '../splTokenAdmin.js';
import { deployAndTransferDemoErc20 } from '../erc20Admin.js';
import { generateMnemonic, mnemonicToSeed } from '@fluxio/crypto/mnemonic';
import { deriveSolanaAccount } from '@fluxio/crypto/derivation';
import { fetchRpcWithFallback } from '@fluxio/crypto/rpc';
import { NETWORKS } from '@fluxio/constants';
import { requestDevnetAirdrop, waitForBalanceAtLeast } from '../transactionService.js';

const SOLANA_LOCAL = NETWORKS['solana-local'];
const ETHEREUM_LOCAL = NETWORKS['ethereum-local'];
const HEALTH_CHECK_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

async function isLocalValidatorUp() {
  try {
    const res = await withTimeout(
      fetch(SOLANA_LOCAL.rpc.default, {
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

async function isAnvilUp() {
  try {
    const res = await withTimeout(
      fetch(ETHEREUM_LOCAL.rpc.default, {
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

async function anvilSetBalance(address, weiAmount) {
  await fetchRpcWithFallback(ETHEREUM_LOCAL, {
    jsonrpc: '2.0',
    id: 1,
    method: 'anvil_setBalance',
    params: [address, `0x${weiAmount.toString(16)}`]
  });
}

function walletFor({ solanaAddress, evmAddress }) {
  return {
    accounts: {
      solana: { address: solanaAddress || 'SoLPlaceholder1111111111111111111111111111' },
      evm: { address: evmAddress || '0x0000000000000000000000000000000000dEaD' }
    }
  };
}

// Determined once, at collection time — describe.skipIf needs a plain
// boolean, not a promise (same pattern as the transactionService/
// evmTransactionService local-integration tests).
const [localValidatorUp, anvilUp] = await Promise.all([isLocalValidatorUp(), isAnvilUp()]);

describe.skipIf(!localValidatorUp)('getTokenBalances — real solana-local integration', () => {
  it(
    'a freshly-minted SPL token is discovered by owner with the exact minted amount',
    async () => {
      const payerMnemonic = generateMnemonic(12);
      const payer = deriveSolanaAccount(mnemonicToSeed(payerMnemonic), 0);
      const recipientMnemonic = generateMnemonic(12);
      const recipient = deriveSolanaAccount(mnemonicToSeed(recipientMnemonic), 0);

      const { signature } = await requestDevnetAirdrop({
        network: 'solana-local',
        address: payer.address,
        lamports: 1_000_000_000n
      });
      await waitForBalanceAtLeast({ network: 'solana-local', address: payer.address, minLamports: 1n }, { timeoutMs: 15000 });
      expect(typeof signature).toBe('string');

      const decimals = 6;
      const amountRaw = 4_200_000n; // 4.2 tokens
      const { mintAddress } = await mintDemoSplToken({
        rpcUrl: SOLANA_LOCAL.rpc.default,
        payerSecretKey: payer.secretKey,
        recipientAddress: recipient.address,
        decimals,
        amountRaw
      });

      const tokens = await getTokenBalances('solana-local', walletFor({ solanaAddress: recipient.address }), {});
      const minted = tokens.find((t) => t.address === mintAddress);
      expect(minted).toBeTruthy();
      expect(minted.amountRaw).toBe(amountRaw.toString());
      expect(minted.decimals).toBe(decimals);
      expect(minted.amountFormatted).toBe('4.200000');
      // Not registered as a custom token in this test — should surface as
      // Unknown, exactly like scripts/spl-token-demo.mjs's own output
      // does until its printed snippet is pasted into the extension.
      expect(minted.symbol).toBe('Unknown');

      payer.secretKey.fill(0);
      recipient.secretKey.fill(0);
    },
    60000
  );
});

describe.skipIf(!anvilUp)('getTokenBalances — real ethereum-local (anvil) integration', () => {
  it(
    'a freshly-deployed ERC-20, once registered as a custom token, resolves the exact transferred amount',
    async () => {
      const deployer = EvmWallet.createRandom();
      const recipient = EvmWallet.createRandom();
      await anvilSetBalance(deployer.address, 10n ** 18n); // 1 ETH — plenty for a deploy + one transfer

      const decimals = 6;
      const transferAmountRaw = 7_500_000n; // 7.5 tokens
      const { contractAddress } = await deployAndTransferDemoErc20({
        rpcUrl: ETHEREUM_LOCAL.rpc.default,
        deployerPrivateKey: deployer.privateKey,
        recipientAddress: recipient.address,
        name: 'Integration Test Token',
        symbol: 'ITT',
        decimals,
        initialSupplyRaw: 1_000_000_000n,
        transferAmountRaw
      });

      const tokens = await getTokenBalances('ethereum-local', walletFor({ evmAddress: recipient.address }), {
        customTokens: [{ symbol: 'ITT', name: 'Integration Test Token', decimals, address: contractAddress }]
      });
      expect(tokens).toEqual([
        {
          symbol: 'ITT',
          name: 'Integration Test Token',
          amountRaw: transferAmountRaw.toString(),
          decimals,
          amountFormatted: '7.500000',
          address: contractAddress
        }
      ]);
    },
    60000
  );
});
