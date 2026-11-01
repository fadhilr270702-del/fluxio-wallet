/**
 * Real integration test against an actual solana-test-validator — the only
 * test in this whole suite that talks to a real RPC endpoint instead of a
 * mock. It exists because two real bugs (see prompt/0095) shipped past
 * every mocked test in transactionService.test.js: a nonexistent RPC
 * method name ('sendRawTransaction' — mocks happily "support" whatever
 * method name the code asks them to, so this was invisible to them by
 * construction) and a commitment-level race between an airdrop's confirmed
 * status and its balance actually becoming visible (mocks have no timing
 * to get wrong). Only a real RPC round-trip against a real validator could
 * ever have caught either one.
 *
 * Skips itself automatically (not a failure) when nothing is listening on
 * solana-local's RPC endpoint — this is opt-in coverage for whoever has a
 * local validator running (`solana-test-validator`, typically via WSL),
 * not a requirement for the normal suite/CI. `pnpm test` stays green
 * either way.
 */
import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  requestDevnetAirdrop,
  sendSolTransfer,
  getTransactionStatus,
  waitForBalanceAtLeast,
  estimateSplTransfer,
  sendSplTransfer
} from '../transactionService.js';
import { mintDemoSplToken } from '../splTokenAdmin.js';
import { fetchRpcWithFallback } from '@fluxio/crypto/rpc';
import { NETWORKS } from '@fluxio/constants';

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

// Determined once, at collection time (top-level await is fine in an ESM
// vitest test file) — describe.skipIf needs a plain boolean, not a promise.
const localValidatorUp = await isLocalValidatorUp();

describe.skipIf(!localValidatorUp)('transactionService — real solana-local integration', () => {
  it(
    'airdrop -> waitForBalanceAtLeast -> sendSolTransfer -> getTransactionStatus all succeed end-to-end against a real validator',
    async () => {
      const sender = nacl.sign.keyPair();
      const recipient = nacl.sign.keyPair();
      const senderAddress = bs58.encode(sender.publicKey);
      const recipientAddress = bs58.encode(recipient.publicKey);
      const AIRDROP_LAMPORTS = 1_000_000_000n; // 1 SOL — unrestricted on a local validator
      const TRANSFER_LAMPORTS = 10_000_000n; // 0.01 SOL

      const { signature: airdropSignature } = await requestDevnetAirdrop({
        network: 'solana-local',
        address: senderAddress,
        lamports: AIRDROP_LAMPORTS
      });
      await waitForConfirmation(airdropSignature);

      // Exercises the real fix for BUG 1 — for real, not mocked.
      const balance = await waitForBalanceAtLeast(
        { network: 'solana-local', address: senderAddress, minLamports: AIRDROP_LAMPORTS },
        { timeoutMs: 15000 }
      );
      expect(balance).toBeGreaterThanOrEqual(AIRDROP_LAMPORTS);

      const sign = async (messageBytes) => nacl.sign.detached(messageBytes, sender.secretKey);
      // Exercises the real fix for BUG 2 — this call used to fail with
      // "Method not found" against a real validator, unconditionally,
      // every single time; no mock could have caught it.
      const { signature, explorerUrl } = await sendSolTransfer({
        network: 'solana-local',
        from: senderAddress,
        to: recipientAddress,
        lamports: TRANSFER_LAMPORTS,
        sign
      });
      expect(typeof signature).toBe('string');
      expect(signature.length).toBeGreaterThan(0);
      expect(explorerUrl).toContain('cluster=custom');

      const finalStatus = await waitForConfirmation(signature);
      expect(['confirmed', 'finalized']).toContain(finalStatus.status);
      expect(finalStatus.err).toBeNull();
    },
    60000
  );
});

/**
 * SPL token transfer (prompt 0113) — real mint -> send -> assert-balance-
 * moved, against the ACTUAL sendSplTransfer implementation (not a mock),
 * proving both halves of Tahap A work end to end against a real validator:
 * the idempotent ATA-creation path (recipient has genuinely never held
 * this mint before — a fresh keypair, never touched) and a plain transfer
 * to an already-existing token account (the second send in the same
 * test, sender -> sender, self-transfer — its own ATA obviously already
 * exists by then). getAssociatedTokenAddressSync (@solana/spl-token, a
 * devDependency — see transactionService.js's own header comment on why
 * it's never imported at runtime) is used here purely as a read-only
 * ORACLE to locate the recipient's ATA for the assertion itself, exactly
 * the same "test-only, not runtime" role it already played in this
 * feature's dependency-decision verification.
 */
describe.skipIf(!localValidatorUp)('sendSplTransfer — real solana-local integration', () => {
  it(
    'mints a real SPL token, sends it to a fresh recipient (idempotently creating their ATA), and the balance genuinely moves on-chain',
    async () => {
      const sender = nacl.sign.keyPair();
      const recipient = nacl.sign.keyPair();
      const senderAddress = bs58.encode(sender.publicKey);
      const recipientAddress = bs58.encode(recipient.publicKey);
      const AIRDROP_LAMPORTS = 1_000_000_000n; // 1 SOL — funds mint-account rent + the token account's own rent + every fee below
      const DECIMALS = 6;
      const MINT_AMOUNT_RAW = 1_000_000_000n; // 1000.000000 tokens
      const TRANSFER_AMOUNT = '250.5';
      const TRANSFER_AMOUNT_RAW = 250_500_000n;

      const { signature: airdropSignature } = await requestDevnetAirdrop({
        network: 'solana-local',
        address: senderAddress,
        lamports: AIRDROP_LAMPORTS
      });
      await waitForConfirmation(airdropSignature);
      await waitForBalanceAtLeast({ network: 'solana-local', address: senderAddress, minLamports: AIRDROP_LAMPORTS }, { timeoutMs: 15000 });

      // Mints directly into the sender's OWN associated token account —
      // sender is both payer/mint-authority and recipient of this step.
      const { mintAddress } = await mintDemoSplToken({
        rpcUrl: NETWORKS['solana-local'].rpc.default,
        payerSecretKey: sender.secretKey,
        recipientAddress: senderAddress,
        decimals: DECIMALS,
        amountRaw: MINT_AMOUNT_RAW
      });

      // Sanity: estimateSplTransfer independently reports needsAta:true for
      // this genuinely-fresh recipient, and its own fee/rent numbers are
      // what sendSplTransfer below actually ends up charging.
      const estimate = await estimateSplTransfer({
        network: 'solana-local',
        from: senderAddress,
        to: recipientAddress,
        mint: mintAddress,
        amount: TRANSFER_AMOUNT
      });
      expect(estimate.needsAta).toBe(true);
      expect(estimate.decimals).toBe(DECIMALS);
      expect(estimate.tokenBalanceRaw).toBe(MINT_AMOUNT_RAW);

      const sign = async (messageBytes) => nacl.sign.detached(messageBytes, sender.secretKey);
      const { signature, explorerUrl, decimals, amountRaw, ataCreated } = await sendSplTransfer({
        network: 'solana-local',
        from: senderAddress,
        to: recipientAddress,
        mint: mintAddress,
        amount: TRANSFER_AMOUNT,
        sign
      });
      expect(decimals).toBe(DECIMALS);
      expect(amountRaw).toBe(TRANSFER_AMOUNT_RAW);
      expect(ataCreated).toBe(true);
      expect(explorerUrl).toContain('cluster=custom');

      const finalStatus = await waitForConfirmation(signature);
      expect(['confirmed', 'finalized']).toContain(finalStatus.status);
      expect(finalStatus.err).toBeNull();

      // The real, on-chain proof: the recipient's token account (which did
      // not exist a moment ago) now genuinely holds the transferred amount.
      const recipientAta = getAssociatedTokenAddressSync(new PublicKey(mintAddress), new PublicKey(recipientAddress));
      const balanceData = await fetchRpcWithFallback(NETWORKS['solana-local'], {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountBalance',
        params: [recipientAta.toBase58(), { commitment: 'confirmed' }]
      });
      expect(balanceData.result.value.amount).toBe(TRANSFER_AMOUNT_RAW.toString());
      expect(balanceData.result.value.decimals).toBe(DECIMALS);

      // Second send to the SAME recipient — its ATA now genuinely exists,
      // so this exercises the "no ATA creation needed" branch for real.
      const secondEstimate = await estimateSplTransfer({
        network: 'solana-local',
        from: senderAddress,
        to: recipientAddress,
        mint: mintAddress,
        amount: '1'
      });
      expect(secondEstimate.needsAta).toBe(false);
      expect(secondEstimate.ataRent).toBe(0n);

      const { ataCreated: secondAtaCreated } = await sendSplTransfer({
        network: 'solana-local',
        from: senderAddress,
        to: recipientAddress,
        mint: mintAddress,
        amount: '1',
        sign
      });
      expect(secondAtaCreated).toBe(false);

      sender.secretKey.fill(0);
      recipient.secretKey.fill(0);
    },
    60000
  );
});
