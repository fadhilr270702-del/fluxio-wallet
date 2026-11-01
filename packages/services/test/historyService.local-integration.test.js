/**
 * Real integration test against an actual solana-test-validator —
 * historyService.js's sibling of transactionService.js's own local-
 * integration test (see that file's header comment for why a real RPC
 * round trip matters here, not just a mock). Sends a real transfer, then
 * polls getSolanaChainHistory() until the resulting signature shows up
 * for BOTH the sender (direction 'out') and the recipient ('in').
 *
 * IMPORTANT, discovered live while building this feature (not assumed):
 * getSignaturesForAddress's own address->signature index is populated by
 * an asynchronous background process on solana-test-validator,
 * independent of the transaction's own confirmation — a freshly
 * confirmed/finalized signature reproducibly took roughly 20-30 seconds
 * before getSignaturesForAddress started returning it, even though
 * getTransaction for that exact signature already returned complete,
 * correct data immediately (confirmed by hand: raw getSignaturesForAddress
 * queries against a fresh throwaway address returned empty at +0s, +2s
 * and +7s after confirmation, then returned the entry at +20s). This
 * test's poll allows a generous timeout specifically to accommodate that
 * real, load-bearing lag — it is not a bug in the validator, this test,
 * or historyService.js's own code (see that file's own comment on
 * getSolanaChainHistory() for the same note, and why the *real* feature
 * doesn't have to wait this long in practice — its local-record half
 * shows a just-sent transaction immediately, well before chain-history
 * would surface it independently).
 *
 * Skips itself automatically (not a failure) when nothing is listening
 * on solana-local's RPC endpoint — opt-in coverage, same as every other
 * *.local-integration.test.js file in this package. `pnpm test` stays
 * green either way.
 */
import { describe, it, expect } from 'vitest';
import { generateMnemonic, mnemonicToSeed } from '@fluxio/crypto/mnemonic';
import { deriveSolanaAccount } from '@fluxio/crypto/derivation';
import { createSigner } from '@fluxio/crypto/signer';
import { NETWORKS } from '@fluxio/constants';
import { requestDevnetAirdrop, sendSolTransfer, getTransactionStatus, waitForBalanceAtLeast } from '../transactionService.js';
import { getSolanaChainHistory } from '../historyService.js';

const LOCAL = NETWORKS['solana-local'];
const HEALTH_CHECK_TIMEOUT_MS = 3000;

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

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConfirmation(signature, { maxAttempts = 40, pollIntervalMs = 500 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await getTransactionStatus({ network: 'solana-local', signature });
    if (status.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    }
    if (status.status === 'confirmed' || status.status === 'finalized') {
      return status;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${signature} to confirm.`);
}

/** Polls getSolanaChainHistory() for `address` until `signature` appears — see this file's own header comment for why the timeout is generous (real getSignaturesForAddress indexing lag, not a bug). */
async function waitForChainHistoryEntry(address, signature, { maxAttempts = 45, pollIntervalMs = 2000 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const entries = await getSolanaChainHistory({ networkKey: 'solana-local', address });
    const found = entries.find((entry) => entry.signatureOrHash === signature);
    if (found) return found;
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `Timed out after ${(maxAttempts * pollIntervalMs) / 1000}s waiting for ${signature} to appear in ${address}'s chain history — ` +
      'getSignaturesForAddress\'s own index can lag real confirmation by 20-30s+ on solana-test-validator, see this file\'s own header comment.'
  );
}

// Determined once, at collection time (top-level await is fine in an ESM
// vitest test file) — describe.skipIf needs a plain boolean, not a promise.
const localValidatorUp = await isLocalValidatorUp();

describe.skipIf(!localValidatorUp)('historyService — real solana-local integration', () => {
  it(
    'a real confirmed SOL transfer eventually appears in getSolanaChainHistory for both the sender (out) and recipient (in)',
    async () => {
      const senderMnemonic = generateMnemonic(12);
      const sender = deriveSolanaAccount(mnemonicToSeed(senderMnemonic), 0);
      const recipientMnemonic = generateMnemonic(12);
      const recipient = deriveSolanaAccount(mnemonicToSeed(recipientMnemonic), 0);

      const AIRDROP_LAMPORTS = 1_000_000_000n; // 1 SOL — unrestricted on a local validator
      const TRANSFER_LAMPORTS = 12_345_000n; // an amount unlikely to collide with anything else in this ledger

      const { signature: airdropSignature } = await requestDevnetAirdrop({
        network: 'solana-local',
        address: sender.address,
        lamports: AIRDROP_LAMPORTS
      });
      await waitForConfirmation(airdropSignature);
      await waitForBalanceAtLeast({ network: 'solana-local', address: sender.address, minLamports: AIRDROP_LAMPORTS }, { timeoutMs: 15000 });

      const signer = createSigner('solana', sender.secretKey);
      const { signature } = await sendSolTransfer({
        network: 'solana-local',
        from: sender.address,
        to: recipient.address,
        lamports: TRANSFER_LAMPORTS,
        sign: (messageBytes) => signer.signTransaction(messageBytes)
      });
      signer.dispose();
      await waitForConfirmation(signature);

      const senderEntry = await waitForChainHistoryEntry(sender.address, signature);
      expect(senderEntry.direction).toBe('out');
      expect(senderEntry.from).toBe(sender.address);
      expect(senderEntry.to).toBe(recipient.address);
      // Includes the network fee, same as balance-delta reality — see
      // historyService.js's own parseSolanaChainEntry() comment.
      expect(BigInt(senderEntry.amountRaw)).toBeGreaterThanOrEqual(TRANSFER_LAMPORTS);
      expect(senderEntry.unit).toBe('SOL');
      expect(senderEntry.status).toBe('confirmed');
      expect(senderEntry.source).toBe('chain');

      const recipientEntry = await waitForChainHistoryEntry(recipient.address, signature);
      expect(recipientEntry.direction).toBe('in');
      expect(recipientEntry.from).toBe(sender.address);
      expect(recipientEntry.to).toBe(recipient.address);
      expect(recipientEntry.amountRaw).toBe(TRANSFER_LAMPORTS.toString()); // recipient's own delta has no fee mixed in

      sender.secretKey.fill(0);
      recipient.secretKey.fill(0);
    },
    // Generous: airdrop + confirm (~seconds) + up to 90s of chain-history
    // indexing-lag polling, for BOTH sender and recipient lookups.
    180000
  );
});
