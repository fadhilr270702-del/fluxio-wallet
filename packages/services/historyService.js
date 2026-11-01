/**
 * Transaction Activity — two independent sources, merged:
 *
 *   - Chain history (this file's own job): real on-chain data, Solana
 *     only this slice — getSignaturesForAddress + getTransaction
 *     (jsonParsed) per signature, direction/amount derived from the
 *     owner's own pre/postBalances delta. Captures INCOMING transfers
 *     too, not just ones this wallet sent.
 *   - Local record (background.js's own job, NOT this file's — it needs
 *     chrome.storage.local, which this file deliberately never touches,
 *     same "services stay storage-agnostic, background.js owns
 *     chrome.storage.local" rule tokenService.js/background.js's custom-
 *     token feature already established): what this wallet itself has
 *     broadcast, on either chain, recorded at send time and updated to
 *     a final status via the existing FLUXIO_INTERNAL_TRANSFER_STATUS
 *     poll — see background.js's own TX_HISTORY_STORAGE_KEY comment.
 *
 * This module owns only the chain-fetch half and the pure merge/dedup
 * logic (mergeHistory below) — kept here, not inline in background.js,
 * specifically so the merge/dedup rule is unit-testable in isolation
 * (mocked local entries + mocked chain entries -> assert the merged
 * result) rather than living untested inside a service-worker message
 * handler.
 *
 * New dedicated module rather than extending transactionService.js:
 * transactionService.js is deliberately Solana-only (see its own header
 * comment) and evmTransactionService.js deliberately EVM-only — history
 * is the one concern that has to reason about BOTH chains and about
 * local+chain merging together, which belongs in neither chain-specific
 * file without blurring what each already means. All amount math is
 * BigInt end to end, same reasoning as every other services file here.
 *
 * KNOWN LIMITATION (explicit scope cut, not an oversight): EVM chain
 * history is NOT built this slice. There is no standard EVM JSON-RPC
 * method to list transactions for an address without a paid indexer
 * (Etherscan-style API, or a service like Alchemy/Infura's enhanced
 * APIs) — eth_getLogs can enumerate event-emitting contract calls but
 * not plain native-ETH transfers, and there is no free/keyless
 * equivalent of Solana's getSignaturesForAddress on any EVM chain. EVM
 * Activity is therefore local-record-only: only transfers THIS wallet
 * itself sent through this extension ever appear: nothing incoming, and
 * nothing sent from any other wallet. The real fix (a paid indexer
 * integration) is deferred to whenever this project's scope allows a
 * paid RPC/API dependency — not attempted here.
 *
 * THREE MORE LIMITATIONS, each discovered LIVE against a real
 * solana-test-validator while building/hardening this feature (not
 * assumed — see the specific comments below for how each was proven):
 *
 *   1. getSignaturesForAddress's own address->signature index is
 *      populated asynchronously, independent of confirmation — a
 *      freshly confirmed signature can take ~15-30s+ before this method
 *      starts returning it (see getSolanaChainHistory()'s own comment).
 *
 *   2. A local validator's reported blockTime does not reliably track
 *      real wall-clock time — proven with a direct before/after
 *      Date.now() comparison against a real transaction's blockTime,
 *      not assumed (see parseSolanaChainEntry()'s own comment).
 *
  *   3. An old chain-only entry (no local record to fall back on — e.g. an
 *      airdrop or a genuine incoming transfer) can legitimately disappear
 *      from a later Activity refresh even though nothing this code does
 *      is wrong. CORRECTION, verified after this was first written: an
 *      earlier version of this comment claimed `--enable-rpc-transaction-history`
 *      was the missing flag/fix — checked directly against a real
 *      `solana-test-validator --help` (v4.2.0, Agave client) and that
 *      flag DOES NOT EXIST for solana-test-validator at all (zero matches
 *      for "history" anywhere in its full help output) — it only applies
 *      to the full `agave-validator`/`solana-validator` binary (a real
 *      cluster-connected validator), not the lightweight local dev tool
 *      this project's own local-network setup uses. Passing it to
 *      solana-test-validator would just be an unrecognized-flag error,
 *      not a fix — this project's daily local-validator startup command
 *      should NOT be changed to include it.
 *
 *      Follow-up investigation into the one flag that DOES exist and
 *      plausibly relates to retention, `--limit-ledger-size <SHRED_COUNT>`
 *      (default 10000 — "keep this amount of shreds in root slots"): ran
 *      an isolated solana-test-validator instance with a deliberately
 *      tiny `--limit-ledger-size 50`, confirmed one transaction, waited
 *      35s for it to stabilize as findable (isolating the ~15-30s
 *      indexing-lag finding above as a separate variable), then generated
 *      a 60-transaction/113-slot burst specifically to try to force
 *      pruning past that tiny limit — the original entry was STILL found
 *      via both getSignaturesForAddress and getTransaction afterward, and
 *      `getFirstAvailableBlock` stayed at 0 throughout (no pruning
 *      observed). This does NOT confirm `--limit-ledger-size` is the
 *      mechanism behind this limitation, at least not at the scale/
 *      duration this test could reach — reported honestly as an
 *      inconclusive result rather than a guessed fix, rather than
 *      claiming a config change that wasn't actually verified to work.
 *
 *      Net effect: this project currently has NO verified, working
 *      startup-flag mitigation for old chain-only Activity entries
 *      eventually becoming unavailable on solana-test-validator — this
 *      is reported as an open, unresolved characteristic of the tool
 *      (likely genuinely time/activity-related, given the original
 *      symptom was observed after "beberapa sesi" of real accumulated
 *      usage — a scale this investigation's short test runs couldn't
 *      reach), not something to claim is fixed without evidence. It does
 *      not affect local-record entries (this wallet's own sends), which
 *      never depend on this index existing at all — only genuinely
 *      old/chain-only entries (airdrops, incoming transfers with no local
 *      record) are exposed to it.
 */
import { fetchRpcWithFallback } from '@fluxio/crypto/rpc';
import { NETWORKS, ACCOUNT_TYPES } from '@fluxio/constants';
// Prompt 0210 — chain-only SWAP recognition: the Jupiter program id
// (one place, swapService — see its own comment) plus the 0205
// receive-side parser, reused verbatim for the receive amount so a
// chain-derived swap and a locally-recorded swap can never disagree on
// what "received" means.
import { JUPITER_PROGRAM_ID, NATIVE_SOL_MINT } from './swapService.js';
import { parseSwapReceivedRaw } from './swapResultParser.js';

const DEFAULT_HISTORY_LIMIT = 20;

/**
 * Fetches this owner's recent Solana transaction history directly from
 * the chain — getSignaturesForAddress for the signature list, then one
 * getTransaction (jsonParsed) per signature to determine direction/
 * amount from the owner's own balance delta. Captures both outgoing AND
 * incoming transfers (unlike the local record, which only ever knows
 * about sends this wallet itself made).
 *
 * KNOWN BEHAVIOR (discovered live against a real solana-test-validator
 * while building this, not assumed): getSignaturesForAddress's own
 * address->signature index is populated by an ASYNCHRONOUS background
 * process, independent of transaction confirmation itself — a freshly
 * confirmed/finalized signature reproducibly took roughly 20-30 seconds
 * before this method started returning it, even though getTransaction
 * for that exact same signature already returned complete, correct data
 * immediately. This is not a bug in this function (or in the validator);
 * it is real, load-bearing behavior this feature's design already
 * accounts for: FLUXIO_INTERNAL_GET_HISTORY's local-record half (see
 * background.js's TX_HISTORY_STORAGE_KEY comment) records a send the
 * moment it broadcasts, so a just-sent transaction still shows up in the
 * merged Activity list immediately, via the local record, well before
 * this function's own chain-history fetch would independently surface
 * it. A caller relying on getSolanaChainHistory() ALONE (with no local
 * record to fall back on — e.g. testing this function in isolation)
 * should expect this delay and poll/retry rather than assert
 * immediately after sending.
 *
 * @param {object} params
 * @param {string} params.networkKey - a Solana network key.
 * @param {string} params.address - the owner's base58 address (server-resolved by the caller — this function trusts whatever address it's given).
 * @param {number} [params.limit]
 * @returns {Promise<Array<{networkKey,direction,signatureOrHash,from,to,amountRaw:string,unit,timestamp,status,source:'chain'}>>}
 */
export async function getSolanaChainHistory({ networkKey, address, limit = DEFAULT_HISTORY_LIMIT }) {
  const network = requireSolanaNetwork(networkKey);

  const sigData = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getSignaturesForAddress',
    params: [address, { limit }]
  });
  const signatures = sigData.result ?? [];

  const entries = [];
  for (const sigInfo of signatures) {
    // One bad/unparseable transaction must never take the rest of the
    // history list down with it — the exact same per-item failure
    // isolation principle tokenService.js's per-mint/per-token loops
    // already established (see that file's own comments for the live
    // bug that motivated it there).
    try {
      const txData = await fetchRpcWithFallback(network, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [sigInfo.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]
      });
      const entry = parseSolanaChainEntry(networkKey, network, address, sigInfo, txData.result);
      if (entry) entries.push(entry);
    } catch {
      continue;
    }
  }
  return entries;
}

function parseSolanaChainEntry(networkKey, network, address, sigInfo, tx) {
  const accountKeys = tx?.transaction?.message?.accountKeys;
  if (!tx?.meta || !Array.isArray(accountKeys)) return null;

  const ownerIdx = accountKeys.findIndex((key) => accountKeyPubkey(key) === address);
  if (ownerIdx === -1) return null;

  // Prompt 0210: a Jupiter swap made on ANOTHER device/install of this
  // wallet has no local record, so it used to render through the plain
  // transfer heuristic below as "Sent to <some AMM account>" — reading
  // like funds leaving to a stranger (the owner's own real history:
  // swaps #9/#10/#11 from the zip card, seen from the work card). Try
  // the swap shape first; a null result falls through to the transfer
  // parsing unchanged.
  const swapEntry = parseSolanaChainSwapEntry(networkKey, address, sigInfo, tx, ownerIdx);
  if (swapEntry) return swapEntry;

  const preBalance = BigInt(tx.meta.preBalances[ownerIdx]);
  const postBalance = BigInt(tx.meta.postBalances[ownerIdx]);
  const delta = postBalance - preBalance;
  if (delta === 0n) return null; // no net effect on this address — nothing to show

  const direction = delta > 0n ? 'in' : 'out';
  const amountRaw = (delta > 0n ? delta : -delta).toString();
  const counterparty = findCounterpartyAddress(accountKeys, tx.meta, ownerIdx);

  return {
    networkKey,
    direction,
    signatureOrHash: sigInfo.signature,
    from: direction === 'out' ? address : counterparty,
    to: direction === 'out' ? counterparty : address,
    amountRaw,
    unit: network.nativeCurrency.symbol,
    // blockTime is Unix seconds; local records store epoch milliseconds
    // (Date.now()) — normalized to the same unit here so merge/sort by
    // `timestamp` never mixes the two. Falls back to "now" in the
    // (very unusual) case a node returns a signature with no blockTime.
    //
    // KNOWN QUIRK, PROVEN live with real data (not assumed): a local
    // solana-test-validator's own reported blockTime does not reliably
    // track real wall-clock time. Proof, not speculation: airdropped to
    // a fresh address, recorded Date.now() immediately before and after
    // confirmation (a ~600ms window), then read that exact transaction's
    // blockTime straight off getTransaction — it reported a time ~8.3
    // hours in the past. The unit conversion itself (*1000, seconds to
    // milliseconds) was verified correct by hand against that same data
    // (1786985918 -> 2026-08-17T16:58:38.000Z, textbook-correct for a
    // Unix-seconds input) — ruled out as the cause before concluding
    // this is validator-side. This is a property of the local validator
    // itself (its internal clock can drift substantially from the host
    // machine's), not a bug in this parsing, and not present on real
    // clusters (devnet/mainnet have accurate, cluster-synchronized
    // blockTime). See `timestampReliable` below for how this is
    // surfaced honestly instead of silently trusted.
    timestamp: typeof sigInfo.blockTime === 'number' ? sigInfo.blockTime * 1000 : Date.now(),
    // Whether `timestamp` above should be trusted for DISPLAY (a
    // formatRelativeTime() string) — false only for solana-local, the
    // one network proven to report an inaccurate blockTime (see above).
    // Still used for SORTING regardless (mergeHistory needs some
    // consistent order, and a wrong-but-present timestamp sorts better
    // than no ordering signal at all) — only the human-facing relative-
    // time STRING is suppressed for an unreliable entry; see
    // background.js's formatHistoryEntry(), which shows "time unknown"
    // instead of a specific, possibly wildly wrong, relative time. A
    // local-record entry never sets this field at all (defaults to
    // reliable) — its timestamp is always this wallet's own real
    // Date.now() at send time, immune to this quirk regardless of
    // network.
    timestampReliable: networkKey !== 'solana-local',
    // getSignaturesForAddress only ever returns signatures the RPC
    // already has confirmed knowledge of, so a chain-derived entry's
    // status is always maximally final — never 'pending'. sigInfo.err
    // (cheaper, present on the signature-list entry itself) is checked
    // first; tx.meta.err is the same fact confirmed from the full
    // transaction, kept as a fallback in case a node ever omits one but
    // not the other.
    status: sigInfo.err || tx.meta.err ? 'failed' : 'confirmed',
    source: 'chain'
  };
}

/**
 * Chain-only Jupiter-swap recognition (prompt 0210, owner opsi B).
 * A transaction whose TOP-LEVEL instruction list contains the Jupiter
 * program (static accountKeys, proven in 0210 fase 1 against five real
 * swaps incl. an on-chain failure) becomes a `type:'swap'` chain entry
 * shaped like the LOCAL swap record (prompt 0200 field names), so the
 * popup renders it through the same swapActivityRowMarkup with zero new
 * render paths. Everything is read from the getTransaction response the
 * caller already fetched — ZERO extra RPC.
 *
 * Amounts, purely from the user's own deltas (the same chain numbers
 * every 0203..0209 real-money reconciliation trusted):
 *  - receive side = parseSwapReceivedRaw (the 0205 parser, verbatim);
 *  - pay side = the user's token mint with a NEGATIVE delta when one
 *    exists; otherwise native SOL as pre − post − fee − rent of any
 *    token account of the user's BORN in this transaction (lamports
 *    0 -> rent-exempt minimum; e.g. the output ATA a first swap
 *    creates), so the figure equals the swap amount the user chose,
 *    matching what a local record would have said.
 *  - an on-chain FAILURE (meta.err) keeps type 'swap' with NO amounts:
 *    the only real movement was the network fee, and pretending
 *    otherwise would repeat the exact dishonesty this feature fixes.
 *
 * Anything ambiguous (several negative mints, unreadable shapes,
 * non-positive computed amounts) returns null and falls back to the
 * plain transfer heuristic — an approximate "Sent" row is better than a
 * confidently WRONG swap row. Symbols: SOL is set directly (native,
 * unambiguous); token sides start as 'Unknown' and get named at render
 * time by background.js's existing custom > registry > snapshot lookup
 * (the 0206 renamer) — never persisted, never migrated.
 * DFlow and every other DEX stay deliberately UNRECOGNIZED (owner
 * decision, 0210): they are not this wallet's swaps, and gasless-bundle
 * deltas would make the numbers lie (swap lesson #9).
 */
function parseSolanaChainSwapEntry(networkKey, address, sigInfo, tx, ownerIdx) {
  const instructions = tx?.transaction?.message?.instructions;
  if (!Array.isArray(instructions)) return null;
  if (!instructions.some((ix) => String(ix?.programId ?? '') === JUPITER_PROGRAM_ID)) return null;

  const base = {
    networkKey,
    type: 'swap',
    signatureOrHash: sigInfo.signature,
    timestamp: typeof sigInfo.blockTime === 'number' ? sigInfo.blockTime * 1000 : Date.now(),
    timestampReliable: networkKey !== 'solana-local',
    source: 'chain'
  };

  if (sigInfo.err || tx.meta.err) {
    return { ...base, status: 'failed' }; // fee-only movement — no amounts, by design (see header)
  }

  try {
    // Net delta per mint across the USER'S OWN token accounts.
    const mintDelta = new Map();
    const mintDecimals = new Map();
    const collect = (list, sign) => {
      for (const b of list || []) {
        if (b?.owner !== address || b?.uiTokenAmount?.amount == null) continue;
        mintDelta.set(b.mint, (mintDelta.get(b.mint) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
        if (typeof b.uiTokenAmount.decimals === 'number') mintDecimals.set(b.mint, b.uiTokenAmount.decimals);
      }
    };
    collect(tx.meta.preTokenBalances, -1n);
    collect(tx.meta.postTokenBalances, 1n);

    let inputMint = null;
    let inputAmount = null;
    let outputMint = null;
    for (const [mint, delta] of mintDelta) {
      if (delta < 0n) {
        if (inputMint) return null; // more than one paying mint — ambiguous, fall back
        inputMint = mint;
        inputAmount = -delta;
      } else if (delta > 0n) {
        if (outputMint) return null; // more than one receiving mint — ambiguous, fall back
        outputMint = mint;
      }
    }

    const fee = BigInt(tx.meta.fee);
    if (!inputMint) {
      // Paying with native SOL: subtract the fee AND the rent of any
      // token account of the user's created in this same transaction
      // (its index went 0 -> rent-exempt lamports), so the figure is
      // the chosen swap amount, not swap + fee + rent.
      let bornRent = 0n;
      const seen = new Set();
      for (const b of tx.meta.postTokenBalances || []) {
        if (b?.owner !== address || typeof b.accountIndex !== 'number' || seen.has(b.accountIndex)) continue;
        seen.add(b.accountIndex);
        const pre = BigInt(tx.meta.preBalances[b.accountIndex] ?? 0);
        const post = BigInt(tx.meta.postBalances[b.accountIndex] ?? 0);
        if (pre === 0n && post > 0n) bornRent += post;
      }
      const paid = BigInt(tx.meta.preBalances[ownerIdx]) - BigInt(tx.meta.postBalances[ownerIdx]) - fee - bornRent;
      if (paid <= 0n) return null;
      inputMint = NATIVE_SOL_MINT;
      inputAmount = paid;
    }

    const received = parseSwapReceivedRaw({ transaction: tx, ownerAddress: address, outputMint: outputMint ?? NATIVE_SOL_MINT });
    if (received == null || received <= 0n) return null;
    if (!outputMint) outputMint = NATIVE_SOL_MINT;
    if (inputMint === outputMint) return null;

    return {
      ...base,
      status: 'confirmed',
      inputMint,
      inputSymbol: inputMint === NATIVE_SOL_MINT ? 'SOL' : 'Unknown',
      inputAmountRaw: inputAmount.toString(),
      inputDecimals: inputMint === NATIVE_SOL_MINT ? 9 : (mintDecimals.get(inputMint) ?? 0),
      outputMint,
      outputSymbol: outputMint === NATIVE_SOL_MINT ? 'SOL' : 'Unknown',
      outputAmountRaw: received.toString(),
      outputDecimals: outputMint === NATIVE_SOL_MINT ? 9 : (mintDecimals.get(outputMint) ?? 0)
    };
  } catch {
    return null; // malformed shapes — the transfer heuristic below is the honest fallback
  }
}

/**
 * Best-effort counterparty lookup: the OTHER account (not the owner's
 * own index) with the largest-magnitude balance change in this
 * transaction. Correct for a plain wallet-to-wallet SystemProgram
 * transfer — the only kind of Solana transaction this wallet itself
 * constructs (see transactionService.js) and the overwhelmingly common
 * case for a simple incoming transfer too. NOT guaranteed correct for a
 * complex multi-instruction/multi-party transaction (e.g. a DEX swap
 * touching several accounts) — this repo has no transaction *decoding*
 * beyond simple transfers anywhere, so a best-effort heuristic here is
 * consistent with that existing scope, not a new gap.
 */
function findCounterpartyAddress(accountKeys, meta, ownerIdx) {
  let bestIdx = -1;
  let bestMagnitude = 0n;
  for (let i = 0; i < accountKeys.length; i++) {
    if (i === ownerIdx) continue;
    const delta = BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]);
    const magnitude = delta < 0n ? -delta : delta;
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      bestIdx = i;
    }
  }
  return bestIdx === -1 ? null : accountKeyPubkey(accountKeys[bestIdx]);
}

/** jsonParsed's accountKeys entries are `{ pubkey, signer, writable, source }` objects; a plain (non-parsed) encoding would give plain base58 strings instead — this function accepts either, defensively, even though this file always requests jsonParsed. */
function accountKeyPubkey(key) {
  return typeof key === 'string' ? key : key?.pubkey;
}

/**
 * Merges a network's local-record entries with its chain-history
 * entries into one deduplicated, timestamp-descending list.
 *
 * Precedence when the SAME signature/hash appears in both: the LOCAL
 * entry wins for direction/from/to/amount/unit/timestamp; the chain
 * entry only ever contributes an updated `status`. This is the opposite
 * of this function's first version, which let chain win outright — that
 * turned out to be backwards for a transaction this wallet sent to
 * ITSELF, and was fixed after being caught in real manual verification:
 * a self-transfer's own balance delta (what the chain-derived entry is
 * built from) only reflects the network FEE, since the transfer amount
 * itself cancels out for a single address acting as both sender and
 * recipient — chain-derived parsing reported "Sent to unknown address
 * −0.000005 SOL" for what was actually a real 0.1 SOL self-transfer,
 * because (a) the "amount" it computed was just the fee, and (b) the
 * counterparty heuristic (findCounterpartyAddress, see above) correctly
 * found no genuine OTHER account whose balance moved, since there isn't
 * one. The local record, captured directly from this wallet's own Send
 * flow at broadcast time, has no such ambiguity: it always knows exactly
 * what was sent, to whom, and when — chain-derived parsing is a
 * necessary *approximation* for entries with no local record at all
 * (genuine incoming transfers, or a signature from a previous
 * install/session), not a more-authoritative second opinion on a
 * transaction this wallet itself already recorded unambiguously.
 *
 * Status is the one field chain still contributes even when local
 * exists: getSignaturesForAddress/getTransaction only ever return
 * already-processed signatures, so a chain-derived status is always at
 * least as final as anything the local record's own
 * FLUXIO_INTERNAL_TRANSFER_STATUS polling may have observed by the time
 * this merge runs (e.g. if the popup was closed before that polling
 * reached a final state). A local-only entry (no matching chain entry —
 * a signature broadcast moments ago that the RPC node's own signature
 * index hasn't caught up to yet, or an EVM send, which has no chain-
 * history source at all) simply keeps whatever status this wallet last
 * observed for it. A chain-only entry (no local record at all — a
 * genuine incoming transfer, or an old signature from before this
 * feature existed) is used as-is, approximation and all.
 *
 * @param {Array} localEntries
 * @param {Array} chainEntries
 * @returns {Array} merged, sorted newest-first
 */
export function mergeHistory(localEntries, chainEntries) {
  const localBySignature = new Map(localEntries.map((entry) => [entry.signatureOrHash, entry]));
  const chainBySignature = new Map(chainEntries.map((entry) => [entry.signatureOrHash, entry]));
  const allSignatures = new Set([...localBySignature.keys(), ...chainBySignature.keys()]);

  const merged = [];
  for (const signature of allSignatures) {
    const local = localBySignature.get(signature);
    const chain = chainBySignature.get(signature);
    if (local && chain) {
      merged.push({ ...local, status: chain.status });
    } else {
      merged.push(local || chain);
    }
  }
  return merged.sort((a, b) => b.timestamp - a.timestamp);
}

function requireSolanaNetwork(networkKey) {
  const network = NETWORKS[networkKey];
  if (!network) {
    throw new Error(`Unknown network: ${networkKey}`);
  }
  if (network.accountType !== ACCOUNT_TYPES.SOLANA) {
    throw new Error(`${network.name} is not a Solana network — chain history is Solana-only this slice (see this file's own header comment).`);
  }
  return network;
}
