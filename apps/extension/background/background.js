/**
 * Background service worker — the trust boundary between untrusted
 * webpage/dApp code and the wallet's secrets.
 *
 *   Web Page (untrusted)
 *        v postMessage, validated origin
 *   content-script/inject.js
 *        v chrome.runtime.sendMessage
 *   Background / Wallet Service   <-- this file
 *        v opens an approval window, waits on a real pending promise
 *   User Approval (approval/approval.html)
 *        v only after explicit Approve
 *   Secure Vault (@fluxio/crypto vault, decrypted only in this worker's memory)
 *        v
 *   Signer (@fluxio/crypto signer) -> Signed message/transaction
 *
 * Two message "trust levels" are handled differently:
 *   - DAPP_MESSAGE_TYPES: relayed from a webpage via the content script.
 *     Always treated as untrusted input — payloads are never assumed
 *     well-formed, and every one of these requires a real user-approval
 *     round trip before touching the vault or signer.
 *   - INTERNAL_MESSAGE_TYPES: only ever sent by the extension's own pages
 *     (the approval window, the popup, the onboarding tab, and the
 *     settings tab). Senders are checked to actually be same-extension
 *     pages (sender.url under our own chrome-extension:// origin) before
 *     being trusted with anything (unlock, create/import a wallet, reveal
 *     the seed phrase, read a balance, approve, reject).
 *
 * Private key material never leaves this file: signMessage/signTransaction
 * return only the signature/signed payload, never the key used to
 * produce it.
 */
import * as walletService from '@fluxio/services/walletService';
import * as balanceService from '@fluxio/services/balanceService';
import * as tokenService from '@fluxio/services/tokenService';
import * as transactionService from '@fluxio/services/transactionService';
import * as evmTransactionService from '@fluxio/services/evmTransactionService';
import * as historyService from '@fluxio/services/historyService';
import * as accountsService from '@fluxio/services/accountsService';
import * as swapService from '@fluxio/services/swapService';
import * as evmSwapService from '@fluxio/services/evmSwapService';
import { parseSwapReceivedRaw } from '@fluxio/services/swapResultParser';
import * as priceService from '@fluxio/services/priceService';
import {
  createApprovalRequest,
  approveRequest,
  rejectRequest,
  getPendingRequest
} from '@fluxio/services/approvalService';
// The only place this file reaches past @fluxio/services into raw
// @fluxio/crypto: these calls are all pure/read-only relative to the
// current session — they never call openSession or mutate it — needed so
// the onboarding UI can show/validate a mnemonic *before* a password
// exists (generateMnemonic/validateMnemonic — see onboarding/onboarding.js)
// and so the Settings UI can re-verify a password and recover the
// mnemonic *without* resetting the already-unlocked session the way
// walletService.unlock() would (loadVault/unlockVault — see
// settings/settings.js).
import { generateMnemonic, validateMnemonic } from '@fluxio/crypto/mnemonic';
import { loadVault } from '@fluxio/crypto/storage';
import { unlockVault } from '@fluxio/crypto/vault';
// Add Token preview's own rpc-unreachable/not-found classification
// (prompt 0119 Revision 1) checks THIS type directly (`instanceof`)
// rather than pattern-matching an error message — see
// FLUXIO_INTERNAL_PREVIEW_CUSTOM_TOKEN's own comment and
// @fluxio/crypto/rpc.js's RpcUnreachableError class for the real bug
// this fixes.
import { RpcUnreachableError } from '@fluxio/crypto/rpc';
import { NETWORKS, ACCOUNT_TYPES, mergeTokens, normalizeTokenAddress } from '@fluxio/constants';
// SOL<->lamports and ETH<->wei conversion (tested — see
// packages/utils/test/{solAmount,ethAmount}.test.js) happens here, not in
// popup.js: popup.js is unbundled and can't import @fluxio/utils, and
// every other amount used across this file (fee, balance, total) is
// already a background-computed value for the same reason — the popup
// only ever displays decimal amount strings it's handed.
import { solToLamports, lamportsToSol } from '@fluxio/utils/solAmount';
import { ethToWei, weiToEth } from '@fluxio/utils/ethAmount';
// "Add custom token" validation — real decode-based checks, not the
// looser live-typing heuristic popup.js's own looksLikeAddress() uses
// (see tokenValidation.js's own header comment for why the two are
// deliberately different strictness levels).
import { isValidEvmAddress, isValidSolanaAddress, isValidTokenDecimals } from '@fluxio/utils/tokenValidation';
import { formatUnits, parseUnits } from '@fluxio/utils/formatUnits';
import { formatRelativeTime } from '@fluxio/utils/relativeTime';
// The one non-@fluxio/* import in this file — a plain sibling ES module,
// not a workspace package. Pulled in specifically because it's the SAME
// pure, DOM/chrome-free decision function popup.js's Settings screen also
// needs (for its <select> options and current-value display) — see that
// module's own header comment for why the logic lives there instead of
// duplicated in both places. esbuild bundles a relative import exactly
// like a package one; this isn't a new capability, just the first time
// this file has reached for it instead of an npm workspace package.
import { shouldAutoLock, AUTO_LOCK_NEVER, AUTO_LOCK_OPTIONS_MINUTES, AUTO_LOCK_DEFAULT_MINUTES } from '../shared/autoLockDecision.js';
// Portfolio fiat total (prompt 0118) — same "pure, DOM/chrome-free
// decision module" pattern autoLockDecision.js established above, but
// split across TWO files as of a Revision 1 bug fix (see
// prompt/0118-fiat-portfolio-value.md): portfolioValue.js needs
// @fluxio/constants (network/token registry data) and is background.js-
// ONLY — it must never be imported by an unbundled page, see its own
// header comment for why. portfolioDisplay.js holds everything that's
// safe for popup.js/settings.js to import directly too (currency list,
// formatting, cache-staleness) — this file is the one place that needs
// BOTH, so it imports from both.
import { MAINNET_NETWORK_KEYS, ALL_PRICED_COIN_IDS, computePortfolioTotal, resolveTokenCoinId } from '../shared/portfolioValue.js';
import {
  ALL_SUPPORTED_CURRENCY_CODES,
  DEFAULT_CURRENCY,
  PRICE_CACHE_MAX_AGE_MS,
  isSupportedCurrency,
  isPriceStale
} from '../shared/portfolioDisplay.js';
import {
  PORTFOLIO_TOTAL_CACHE_STORAGE_KEY,
  DEV_NETWORKS_STORAGE_KEY,
  SWAP_SLIPPAGE_STORAGE_KEY,
  CARD_BACKGROUND_STORAGE_KEY,
  NOTIFICATIONS_STATE_STORAGE_KEY
} from '../shared/messaging.js';
// Notifications inbox (prompt 0170) — pure filter/merge/badge logic, same
// "no DOM/chrome.* reference, plain-Vitest testable" pattern every other
// piece of pure decision logic in this file already follows (see
// shared/swapAssetSources.js's own header comment). See this file's own
// "Notifications inbox" section below for the actual fetch/storage
// orchestration these are used from.
import { filterAnnouncementsForPlatform } from '../shared/announcementsFilter.js';
import { mergeAnnouncementsCache } from '../shared/announcementsMerge.js';
import { countUnread, formatBadgeText } from '../shared/notificationBadge.js';

// Helius mainnet Solana RPC (prompt 0130): NOT wired here any more — see
// @fluxio/constants/networks.js's own header comment for the full
// root-cause story (Revision 1) and where the injection actually lives
// now. The original version of this fix lived here, as a `NETWORKS as
// BASE_NETWORKS` shadow + a local `withRpcOverrides()` call — completely
// inert in practice, since tokenService.js/balanceService.js/
// historyService.js each import `NETWORKS` from `@fluxio/constants`
// directly and look up their own network config internally, never
// touching whatever this file computed locally. Plain `NETWORKS` import
// above is correct again: the object it resolves to is already the
// right one, straight from `@fluxio/constants`, for every consumer alike.

const DAPP_MESSAGE_TYPES = new Set(['CONNECT', 'SIGN_MESSAGE', 'SIGN_TRANSACTION']);
const INTERNAL_MESSAGE_TYPES = new Set([
  'FLUXIO_INTERNAL_GET_APPROVAL',
  'FLUXIO_INTERNAL_GET_STATUS',
  'FLUXIO_INTERNAL_GENERATE_MNEMONIC',
  'FLUXIO_INTERNAL_VALIDATE_MNEMONIC',
  'FLUXIO_INTERNAL_IMPORT_WALLET',
  'FLUXIO_INTERNAL_UNLOCK',
  'FLUXIO_INTERNAL_LOCK',
  'FLUXIO_INTERNAL_RESET_WALLET',
  'FLUXIO_INTERNAL_REVEAL_SEED',
  'FLUXIO_INTERNAL_GET_BALANCE',
  'FLUXIO_INTERNAL_GET_TOKEN_BALANCES',
  'FLUXIO_INTERNAL_LIST_CUSTOM_TOKENS',
  'FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN',
  'FLUXIO_INTERNAL_PREVIEW_CUSTOM_TOKEN',
  'FLUXIO_INTERNAL_REMOVE_CUSTOM_TOKEN',
  'FLUXIO_INTERNAL_ESTIMATE_TRANSFER',
  'FLUXIO_INTERNAL_SEND_TRANSFER',
  'FLUXIO_INTERNAL_TRANSFER_STATUS',
  'FLUXIO_INTERNAL_GET_HISTORY',
  'FLUXIO_INTERNAL_GET_ACCOUNTS',
  'FLUXIO_INTERNAL_ADD_ACCOUNT',
  'FLUXIO_INTERNAL_RENAME_ACCOUNT',
  'FLUXIO_INTERNAL_SET_ACTIVE_ACCOUNT',
  'FLUXIO_INTERNAL_GET_SWAP_TOKENS',
  'FLUXIO_INTERNAL_GET_SWAP_QUOTE',
  'FLUXIO_INTERNAL_EXECUTE_SWAP',
  'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES',
  'FLUXIO_INTERNAL_SWAP_STATUS',
  'FLUXIO_INTERNAL_GET_ACTIVE_SWAP',
  'FLUXIO_INTERNAL_GET_AUTO_LOCK',
  'FLUXIO_INTERNAL_SET_AUTO_LOCK',
  'FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE',
  'FLUXIO_INTERNAL_GET_CURRENCY',
  'FLUXIO_INTERNAL_SET_CURRENCY',
  'FLUXIO_INTERNAL_APPROVE',
  'FLUXIO_INTERNAL_REJECT',
  'FLUXIO_INTERNAL_GET_NOTIFICATIONS',
  'FLUXIO_INTERNAL_MARK_NOTIFICATIONS_READ'
]);

const APPROVAL_WINDOW_SIZE = { width: 360, height: 480 };
const extensionOrigin = chrome.runtime.getURL('');

/**
 * chrome.storage.local key for locally-registered custom tokens — an
 * override/extension of @fluxio/constants/tokens.js's static registry.
 * Shape: { [networkKey]: [{ symbol, name, decimals, address }, ...] }.
 *
 * Two ways this gets written, both funneling through this file (popup.js
 * never touches chrome.storage.local for tokens directly — same "this
 * file is the source of truth, everything else goes through a message"
 * rule as every other piece of session/wallet state):
 *   - The Manage Tokens UI (apps/extension/popup/popup.js's
 *     renderManageTokens* screens), via FLUXIO_INTERNAL_LIST_CUSTOM_TOKENS/
 *     ADD_CUSTOM_TOKEN/REMOVE_CUSTOM_TOKEN below — the normal path as of
 *     this feature; a token's on-chain metadata (symbol/name/decimals) is
 *     fetched and validated at add time (see FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN's
 *     own comment) so a dead/malformed entry should no longer even get
 *     this far in the first place.
 *   - The service-worker console, pasting a snippet
 *     scripts/spl-token-demo.mjs / scripts/erc20-local-demo.mjs prints —
 *     the ORIGINAL mechanism this UI was built to replace as the primary
 *     path, kept as an explicit fallback (see either script's own
 *     "printed snippet" comment) since it needs no unlocked popup/running
 *     UI at all, just DevTools. Pasting hits Chrome's default paste-
 *     blocking self-XSS guard — typing "allow pasting" first is required;
 *     both scripts print that reminder alongside their snippet.
 *
 * Always read fresh (never cached), so either path's write takes effect
 * on the very next balance fetch with no reload needed.
 *
 * A registered entry is only ever as good as the local chain state it
 * points at: a restarted solana-test-validator/anvil wipes every
 * previously-minted/deployed address unconditionally, so a stale entry
 * left over from before a restart is a routine occurrence, not an edge
 * case — getTokenBalances() (see @fluxio/services/tokenService.js) is
 * built to skip a dead entry silently rather than fail the whole
 * network's fetch over it, and both demo scripts' snippets replace every
 * prior entry for their own network on each run specifically to avoid
 * ever accumulating dead ones in the first place — see either script's
 * own printRegistrationSnippet() comment for the full reasoning.
 */
const CUSTOM_TOKENS_STORAGE_KEY = 'fluxio_custom_tokens';

/** Reads the whole `{ [networkKey]: [...] }` map — the one place either storage shape consumer (getCustomTokens below, or the Manage Tokens handlers) actually touches chrome.storage.local for reading. */
function readCustomTokensStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CUSTOM_TOKENS_STORAGE_KEY], (result) => {
      resolve(result?.[CUSTOM_TOKENS_STORAGE_KEY] || {});
    });
  });
}

/** Persists the whole `{ [networkKey]: [...] }` map back — the one place anything writes this key. */
function writeCustomTokensStorage(allNetworks) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CUSTOM_TOKENS_STORAGE_KEY]: allNetworks }, () => resolve());
  });
}

async function getCustomTokens(networkKey) {
  const allNetworks = await readCustomTokensStorage();
  return allNetworks[networkKey] || [];
}

/**
 * Shared "is this even addable" validation for BOTH steps of the two-step
 * Add Token flow (prompt 0119) — network exists, `address` is a
 * well-formed address for this network's chain, and it isn't already
 * registered (registry OR custom). Extracted out of
 * FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN (which used to inline all of this)
 * specifically so FLUXIO_INTERNAL_PREVIEW_CUSTOM_TOKEN's own step-1
 * check can never drift from the final commit-time check — both messages
 * call this SAME function, so there is exactly one place that decides
 * "addable or not," not two copies that could silently disagree.
 * @returns {Promise<{ network: object, isEvm: boolean }>}
 */
async function validateNewCustomTokenAddress(networkKey, address) {
  const network = NETWORKS[networkKey];
  if (!network) {
    throw new Error(`Unknown network: ${networkKey}`);
  }
  const isEvm = network.accountType === ACCOUNT_TYPES.EVM;
  if (isEvm ? !isValidEvmAddress(address) : !isValidSolanaAddress(address)) {
    throw new Error(`"${address}" is not a valid ${isEvm ? 'EVM' : 'Solana'} address.`);
  }

  const existingCustom = await getCustomTokens(networkKey);
  const merged = mergeTokens(networkKey, existingCustom);
  const normalizedNewAddress = normalizeTokenAddress(networkKey, address);
  if (merged.some((t) => normalizeTokenAddress(networkKey, t.address) === normalizedNewAddress)) {
    throw new Error('This token is already registered for this network.');
  }

  return { network, isEvm };
}

/**
 * Resolves `tokenAddress` against the registry+custom-token list for
 * `networkKey` (same mergeTokens/normalizeTokenAddress duplicate-check
 * machinery FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN already uses) — the
 * server-side "is this token actually registered here" validation
 * FLUXIO_INTERNAL_ESTIMATE_TRANSFER/SEND_TRANSFER's token branches both
 * need before ever touching transactionService/evmTransactionService:
 * neither of those services has any notion of a token registry, so an
 * unregistered address must be refused here, not deeper in. Throws a
 * plain Error (not TransactionValidationError — that class belongs to
 * @fluxio/services, not this file) if nothing matches.
 */
async function resolveRegisteredToken(networkKey, tokenAddress) {
  const customTokens = await getCustomTokens(networkKey);
  const normalizedTarget = normalizeTokenAddress(networkKey, tokenAddress);
  const known = mergeTokens(networkKey, customTokens).find(
    (t) => normalizeTokenAddress(networkKey, t.address) === normalizedTarget
  );
  if (!known) {
    throw new Error(`This token is not registered for ${NETWORKS[networkKey]?.name || networkKey}.`);
  }
  return known;
}

/**
 * Appends validator/anvil-specific guidance to an RPC-unreachable error
 * from FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN's metadata fetch, for
 * solana-local/ethereum-local specifically — the two networks with no
 * configured fallback endpoint (see networks.js), where "unreachable"
 * almost always just means the developer hasn't started their local node
 * yet, not a real outage to wait out. Every other error (bad address, no
 * contract found, decimals unreadable, ...) — and every other network's
 * "Could not reach" error — passes through unchanged.
 *
 * REVISION 1 (prompt 0119's own bug fix): this now checks
 * `error instanceof RpcUnreachableError` — a real, structural type (see
 * @fluxio/crypto/rpc.js's own comment) — instead of pattern-matching the
 * message text for "Could not reach". The hinted error it returns is
 * ALSO still a real RpcUnreachableError, not a plain Error, specifically
 * so FLUXIO_INTERNAL_PREVIEW_CUSTOM_TOKEN's own classification below (an
 * `instanceof` check) keeps working correctly on the hinted result, not
 * just the original.
 */
function withLocalRpcHint(networkKey, error) {
  const isLocalNetwork = networkKey === 'solana-local' || networkKey === 'ethereum-local';
  if (!isLocalNetwork || !(error instanceof RpcUnreachableError)) return error;
  const hint = networkKey === 'solana-local' ? 'solana-test-validator' : 'anvil';
  return new RpcUnreachableError(`${error.message} Is ${hint} running?`);
}

/**
 * chrome.storage.local key for this wallet's OWN local record of
 * transactions it has broadcast — every network, both chains. Shape:
 * { [networkKey]: [{ networkKey, direction:'out', signatureOrHash, from,
 * to, amountRaw (string, smallest unit), unit, timestamp (epoch ms),
 * status: 'pending'|'confirmed'|'failed' }, ...] }, newest first, capped
 * per network at MAX_LOCAL_HISTORY_PER_NETWORK entries.
 *
 * This is genuinely a LOCAL, per-browser-profile record, not a synced or
 * recoverable one: reinstalling the extension (or clearing its storage)
 * loses it completely, the same way every other chrome.storage.local-
 * backed piece of state in this file does (custom tokens, developer-
 * networks toggle, ...). Only ever records PUBLIC transaction facts —
 * network, addresses, amount, status, timestamp — never key material,
 * and (explicit scope cut for this slice) never a memo/personal label
 * either, even though nothing here would technically prevent adding one
 * later.
 *
 * Two write paths, both in this file:
 *   - FLUXIO_INTERNAL_SEND_TRANSFER appends a new 'pending' entry the
 *     moment a send succeeds (recordLocalTransaction).
 *   - FLUXIO_INTERNAL_TRANSFER_STATUS updates that entry's status once
 *     it observes a final one (updateLocalTransactionStatus) — this
 *     PIGGYBACKS the polling popup.js's own Send-result screen already
 *     does (pollConfirmation) rather than this file starting a second,
 *     independent poll loop; see finalLocalStatusFor()'s own comment for
 *     the Solana/EVM status-mapping rule.
 *
 * A SECOND entry shape, `{ networkKey, type: 'swap', signatureOrHash,
 * inputMint, inputSymbol, inputAmountRaw, inputDecimals, outputMint,
 * outputSymbol, outputAmountRaw, outputDecimals, timestamp, status }`,
 * is recognized by formatHistoryEntry()/formatSwapHistoryEntry() (prompt
 * 0115) and — as of prompt 0200 — is REALLY WRITTEN by
 * FLUXIO_INTERNAL_EXECUTE_SWAP's success path (plus the extra
 * otherAmountThresholdRaw/platformFee/lastValidBlockHeight fields that
 * handler records; the renderer reads only the 0115 subset).
 *
 * @see @fluxio/services/historyService.js for the Solana-chain-history
 * half of Activity, and its own mergeHistory() for how the two combine.
 */
const TX_HISTORY_STORAGE_KEY = 'fluxio_tx_history';
const MAX_LOCAL_HISTORY_PER_NETWORK = 50;

function readTxHistoryStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([TX_HISTORY_STORAGE_KEY], (result) => {
      resolve(result?.[TX_HISTORY_STORAGE_KEY] || {});
    });
  });
}

function writeTxHistoryStorage(allNetworks) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [TX_HISTORY_STORAGE_KEY]: allNetworks }, () => resolve());
  });
}

async function getLocalTransactions(networkKey) {
  const allNetworks = await readTxHistoryStorage();
  return allNetworks[networkKey] || [];
}

async function recordLocalTransaction(entry) {
  const allNetworks = await readTxHistoryStorage();
  const list = allNetworks[entry.networkKey] || [];
  list.unshift(entry);
  allNetworks[entry.networkKey] = list.slice(0, MAX_LOCAL_HISTORY_PER_NETWORK);
  await writeTxHistoryStorage(allNetworks);
}

async function updateLocalTransactionStatus(networkKey, signatureOrHash, status, extraFields) {
  const allNetworks = await readTxHistoryStorage();
  const list = allNetworks[networkKey] || [];
  const entry = list.find((e) => e.signatureOrHash === signatureOrHash);
  if (!entry || entry.status === status) return; // nothing to persist — either not a local entry, or already at this status
  entry.status = status;
  // extraFields (prompt 0203 Revisi 1): a final verdict can carry a
  // machine-readable reason (e.g. failureCode: 'SWAP_BLOCKHASH_EXPIRED')
  // so Activity can distinguish "failed on chain" from "never included".
  if (extraFields && typeof extraFields === 'object') {
    Object.assign(entry, extraFields);
  }
  allNetworks[networkKey] = list;
  await writeTxHistoryStorage(allNetworks);
}

/** Merges fields into a local entry WITHOUT touching its status (prompt 0205 — the real-received amount arrives after the verdict, on its own schedule). No-op when the entry doesn't exist. */
async function updateLocalTransactionFields(networkKey, signatureOrHash, fields) {
  const allNetworks = await readTxHistoryStorage();
  const list = allNetworks[networkKey] || [];
  const entry = list.find((e) => e.signatureOrHash === signatureOrHash);
  if (!entry) return;
  Object.assign(entry, fields);
  allNetworks[networkKey] = list;
  await writeTxHistoryStorage(allNetworks);
}

// ---- Real received amount for confirmed swaps (prompt 0205 bagian B) ----
// "You received (est.)" showed the QUOTE's estimate forever; the chain
// knows the real number. Once a swap entry is confirmed, the verdict
// surfaces below fetch the transaction (getTransactionDetails — per-
// endpoint, commitment 'confirmed' explicitly since the default
// 'finalized' answers null for a dozen+ seconds after confirmation,
// live-proven on both keyless endpoints; a limited-history endpoint's
// `result: null` means "ask the next one") and store the parsed real
// amount on the entry. Hard rules (0205 koreksi c): this NEVER changes a
// verdict — confirmed stays confirmed whether or not a number is
// obtained — and a parser failure only means the estimate keeps showing.
//
// Pacing (0205 Revisi 1 — the original per-poll counter burned all its
// attempts in ~12s of Swapped-screen polling and then gave up FOREVER,
// so a transaction whose data arrived at t=15s never got its number):
//  - attempts are spaced by TIME (REAL_AMOUNT_ATTEMPT_GAP_MS): a call
//    landing inside the gap returns without consuming anything;
//  - the polling surfaces (Swapped screen's SWAP_STATUS, the re-broadcast
//    loop, a fresh confirm) stop after MAX_REAL_AMOUNT_POLL_ATTEMPTS
//    SPACED attempts (≥ ~28s of coverage) — polite, bounded;
//  - the on-demand surfaces (opening Activity, the worker-wake sweep)
//    may ALWAYS try again later — no attempt ceiling — but at most
//    MAX_REAL_AMOUNT_ENTRIES_PER_SURFACE entries per invocation and
//    still gap-spaced, so an endpoint chain that simply doesn't retain
//    the transaction is never flooded.
const REAL_AMOUNT_ATTEMPT_GAP_MS = 4000;
const MAX_REAL_AMOUNT_POLL_ATTEMPTS = 8;
const MAX_REAL_AMOUNT_ENTRIES_PER_SURFACE = 3;

/**
 * One token account's LIVE rent-exempt minimum, cached for this worker's
 * lifetime (prompt 0205 koreksi a: the chain's real figure is 1,488,440
 * lamports while the old hardcoded 2,039,280 was stale — displayed
 * numbers must come from the chain, never a constant).
 */
let cachedTokenAccountRentLamports = null;
async function getCachedTokenAccountRentLamports() {
  if (cachedTokenAccountRentLamports == null) {
    cachedTokenAccountRentLamports = await transactionService.getTokenAccountRentLamports({ network: 'solana' });
  }
  return cachedTokenAccountRentLamports;
}

function missingRealReceived(entry) {
  // source 'chain' (prompt 0210): a chain-derived swap entry's
  // outputAmountRaw ALREADY IS the chain's real received amount (the
  // same delta parseSwapReceivedRaw computes) — fetching the
  // transaction again to "resolve" it would burn an RPC call to learn
  // nothing, and there is no stored record to persist a result onto.
  return entry.type === 'swap' && entry.status === 'confirmed' && entry.receivedRealRaw == null && entry.source !== 'chain';
}

async function tryResolveRealReceived(networkKey, entry, { attemptLimit = null } = {}) {
  if (!missingRealReceived(entry)) return;
  const attempts = (entry.receivedRealAttempts || 0);
  if (attemptLimit != null && attempts >= attemptLimit) return; // this surface's polite stop — Activity/sweep may still try later
  const lastAttemptAt = entry.receivedRealLastAttemptAt || 0;
  if (Date.now() - lastAttemptAt < REAL_AMOUNT_ATTEMPT_GAP_MS) return; // inside the gap — skip WITHOUT consuming an attempt
  try {
    const tx = await transactionService.getTransactionDetails({ network: networkKey, signature: entry.signatureOrHash });
    let fields = { receivedRealAttempts: attempts + 1, receivedRealLastAttemptAt: Date.now() };
    if (tx) {
      // The swap's owner is the transaction's own fee payer (the
      // identity fence guarantees it at execute time) — read it from
      // the transaction itself, so this works with a LOCKED wallet and
      // for entries recorded before this feature existed.
      const keys = tx?.transaction?.message?.accountKeys;
      const first = Array.isArray(keys) ? keys[0] : null;
      const feePayer = typeof first === 'string' ? first : first?.pubkey;
      const received = feePayer ? parseSwapReceivedRaw({ transaction: tx, ownerAddress: feePayer, outputMint: entry.outputMint }) : null;
      if (received != null) {
        fields = { ...fields, receivedRealRaw: received.toString() };
      }
    }
    Object.assign(entry, fields); // the CURRENT render sees it too
    await updateLocalTransactionFields(networkKey, entry.signatureOrHash, fields);
  } catch {
    // Best-effort only — the verdict and the entry stay untouched.
  }
}

/**
 * Maps a raw FLUXIO_INTERNAL_TRANSFER_STATUS result to the 3-value local-
 * record status ('pending'|'confirmed'|'failed'), or `null` if there's
 * nothing final enough yet to persist (still pending / not found — the
 * local record keeps whatever it already had, no write needed).
 * Solana's 'processed'/'confirmed'/'finalized' both collapse to
 * 'confirmed' here — the local record's status field only needs to
 * answer "is this done, and did it succeed", not track every
 * intermediate commitment level the way the Send flow's own live poll
 * does.
 */
function finalLocalStatusFor(network, result) {
  if (network.accountType === ACCOUNT_TYPES.SOLANA) {
    if (result.err) return 'failed';
    if (result.status === 'confirmed' || result.status === 'finalized') return 'confirmed';
    return null;
  }
  if (network.accountType === ACCOUNT_TYPES.EVM) {
    if (result.status === 'failed') return 'failed';
    if (result.status === 'finalized') return 'confirmed';
    return null;
  }
  return null;
}

/**
 * Shapes one merged history entry (from historyService.mergeHistory —
 * either a local-record entry or a chain-derived one, same fields
 * either way) into what popup.js actually renders: a display-ready
 * decimal amount (via formatUnits — popup.js can't import @fluxio/utils
 * itself, same "background pre-formats every amount" rule as the rest of
 * this file), a relative-time string (via formatRelativeTime — computed
 * once, now, not live-ticking; see that helper's own comment for why
 * that's consistent with every other value in this popup), the correct
 * single "other party" address for whichever direction this entry is,
 * and an explorer URL (or null) built from the exact same
 * solanaExplorerUrl()/evmExplorerUrl() a fresh Send already uses.
 *
 * `relativeTime` is deliberately NOT computed from `entry.timestamp` when
 * `entry.timestampReliable === false` (set only for a solana-local
 * chain-derived entry — see historyService.js's parseSolanaChainEntry()
 * comment for the live-proven blockTime-inaccuracy finding this exists
 * for) — showing a specific but possibly wildly wrong relative time
 * (e.g. "10h ago" for something sent moments earlier) would be actively
 * misleading, so an honest "time unknown" is shown instead. A local-
 * record entry never sets this field (defaults to reliable), since its
 * timestamp is always this wallet's own real Date.now() at send time.
 *
 * `amountFormatted`'s decimals (prompt 0113): a TOKEN local record
 * (`entry.isToken === true` — set only by FLUXIO_INTERNAL_SEND_TRANSFER's
 * token branch below, see recordLocalTransaction's call sites) carries
 * its OWN `tokenDecimals`, which must be used instead of
 * `network.nativeCurrency.decimals` — a token's decimals are almost never
 * the same as the network's native coin's (e.g. 6 for USDC vs. 9 for
 * native SOL), and using the wrong one would silently mis-scale the
 * displayed amount by orders of magnitude. A chain-derived entry (always
 * native-only this slice — see historyService.js's own header comment)
 * never sets `isToken`, so it falls through to the native decimals
 * unchanged, exactly as before this feature. `isToken`/`tokenAddress` are
 * passed through as-is so popup.js's Activity rendering can visually
 * distinguish a token entry from a native one, per this feature's
 * explicit requirement.
 */
function formatHistoryEntry(network, entry) {
  if (entry.type === 'swap') {
    return formatSwapHistoryEntry(network, entry);
  }
  // Approval entries (tahap C, 0223 Revisi 3): the ERC-20 approve leg of a
  // token-in swap leaves its own trace — gas was spent even when the swap
  // leg never followed. Local-record only (EVM has no chain history), and
  // mergeHistory needs nothing new (it keys by signatureOrHash).
  if (entry.type === 'approval') {
    return {
      type: 'approval',
      signatureOrHash: entry.signatureOrHash,
      // 0227 (0225 K8): 'reset' marks the approve(0) leg — the popup's
      // row then reads "Reset approval for swap" instead of the normal
      // approve label.
      approvalKind: entry.approvalKind ?? null,
      tokenSymbol: entry.tokenSymbol ?? null,
      amountFormatted: entry.amountRaw != null ? formatUnits(BigInt(entry.amountRaw), entry.tokenDecimals ?? 18) : null,
      status: entry.status,
      relativeTime: formatRelativeTime(entry.timestamp),
      timestamp: entry.timestamp,
      explorerUrl:
        network.accountType === ACCOUNT_TYPES.SOLANA
          ? transactionService.solanaExplorerUrl(network, entry.signatureOrHash)
          : evmTransactionService.evmExplorerUrl(network, entry.signatureOrHash)
    };
  }
  const counterpartyAddress = entry.direction === 'out' ? entry.to : entry.from;
  const decimals = entry.isToken === true ? entry.tokenDecimals : network.nativeCurrency.decimals;
  return {
    direction: entry.direction,
    signatureOrHash: entry.signatureOrHash,
    counterpartyAddress: counterpartyAddress || null,
    amountFormatted: formatUnits(BigInt(entry.amountRaw), decimals),
    unit: entry.unit,
    isToken: entry.isToken === true,
    tokenAddress: entry.isToken === true ? entry.tokenAddress : null,
    status: entry.status,
    relativeTime: entry.timestampReliable === false ? 'time unknown' : formatRelativeTime(entry.timestamp),
    timestamp: entry.timestamp,
    explorerUrl:
      network.accountType === ACCOUNT_TYPES.SOLANA
        ? transactionService.solanaExplorerUrl(network, entry.signatureOrHash)
        : evmTransactionService.evmExplorerUrl(network, entry.signatureOrHash)
  };
}

/**
 * Formats a swap-type local record (prompt 0115) — a genuinely different
 * shape from a transfer entry: no single direction/counterparty/amount,
 * but an INPUT asset and an OUTPUT asset, each with their own amount +
 * symbol + decimals ("X SOL -> Y USDC"). Written for real by
 * FLUXIO_INTERNAL_EXECUTE_SWAP's success path as of prompt 0200 (this
 * renderer itself needed zero changes that day — the exact point of
 * preparing it in 0115). Swaps are Solana-only (Jupiter has no other chain
 * — see swapService.js), so this always uses solanaExplorerUrl(), never
 * evmExplorerUrl(). historyService.js's mergeHistory() needs no changes
 * for this: it only ever keys/sorts by signatureOrHash/timestamp, both
 * present here, so a swap-shaped local entry already merges correctly
 * against any (mis-parsed, native-transfer-shaped) chain-derived entry
 * for the same signature — the existing "local wins on a matched
 * signature" rule (see mergeHistory's own comment, originally fixed for
 * a self-transfer) is exactly what keeps a future real swap entry
 * displaying correctly too, with zero extra work.
 */
function formatSwapHistoryEntry(network, entry) {
  // receivedRealRaw (prompt 0205): the chain's REAL received amount,
  // stored once the confirmed transaction was fetched and parsed — shown
  // instead of the quote's estimate when present. Entries recorded
  // before this field existed (or whose amount was never obtainable)
  // fall back to the estimate exactly as before, no migration.
  const receivedIsReal = entry.receivedRealRaw != null;
  // Prompt 0210: a chain-derived swap that FAILED on chain carries NO
  // amounts, deliberately (historyService's own comment: the only real
  // movement was the network fee). The popup renders the honest note
  // instead of amount lines. Local records always have amounts.
  const hasAmounts = entry.inputAmountRaw != null && entry.outputAmountRaw != null;
  return {
    type: 'swap',
    signatureOrHash: entry.signatureOrHash,
    inputAmountFormatted: hasAmounts ? formatUnits(BigInt(entry.inputAmountRaw), entry.inputDecimals) : null,
    inputSymbol: entry.inputSymbol ?? null,
    outputAmountFormatted: hasAmounts ? formatUnits(BigInt(receivedIsReal ? entry.receivedRealRaw : entry.outputAmountRaw), entry.outputDecimals) : null,
    outputSymbol: entry.outputSymbol ?? null,
    receivedIsReal,
    chainNote: !hasAmounts && entry.status === 'failed' ? 'Swap failed on chain. Only the network fee was charged.' : null,
    status: entry.status,
    relativeTime: formatRelativeTime(entry.timestamp),
    timestamp: entry.timestamp,
    // Branch by accountType exactly like formatHistoryEntry above — this
    // line used to call solanaExplorerUrl unconditionally (swap entries
    // were Solana-only until 0220), which appended "?cluster=undefined"
    // to the FIRST real EVM swap's BscScan link (caught live by the
    // owner, 0220 Revisi 2; the cluster query belongs to Solana's
    // explorer alone — devnet/local — and an EVM URL stays clean).
    explorerUrl:
      network.accountType === ACCOUNT_TYPES.SOLANA
        ? transactionService.solanaExplorerUrl(network, entry.signatureOrHash)
        : evmTransactionService.evmExplorerUrl(network, entry.signatureOrHash)
  };
}

/**
 * Opportunistically resolves one still-'pending' EVM local-record entry
 * via the existing FLUXIO_INTERNAL_TRANSFER_STATUS logic, mutating it in
 * place for THIS render and persisting the result if it turned out to be
 * final. Solana TRANSFER entries never need this: a pending Solana send
 * gets superseded by fresh chain-history data (see historyService.js's
 * mergeHistory) the moment it actually lands on-chain, every time the
 * Activity screen is opened/refreshed — but a Solana SWAP that never
 * lands has nothing to supersede it (see resolvePendingSwapEntry below,
 * prompt 0203 Revisi 1's incident fix) — and EVM has no chain-history
 * source at all this slice (see historyService.js's own header comment),
 * so this is the ONLY way a pending EVM entry ever resolves without the
 * Send flow's own result screen still being open and polling it. Still
 * not a new timer/poll loop — it only runs once, on-demand, exactly when
 * the Activity screen itself is opened or refreshed, piggybacking the
 * same TRANSFER_STATUS logic every other poll here already uses.
 */
async function resolvePendingEvmEntry(networkKey, network, entry) {
  try {
    const result = await evmTransactionService.getEvmTransactionStatus({ network: networkKey, hash: entry.signatureOrHash });
    const finalStatus = finalLocalStatusFor(network, result);
    if (finalStatus) {
      entry.status = finalStatus;
      await updateLocalTransactionStatus(networkKey, entry.signatureOrHash, finalStatus);
      if (finalStatus === 'confirmed' && entry.type === 'swap') {
        await tryResolveRealReceivedEvm(networkKey, entry); // prompt 0220 — never affects the verdict above
      }
    }
  } catch {
    // Best-effort only — leave it 'pending' for this render; the next
    // open/refresh will try again.
  }
}

/**
 * The SOLANA-SWAP sibling of resolvePendingEvmEntry above — prompt 0203
 * Revisi 1's real-incident fix. The old assumption ("a pending Solana
 * entry gets superseded by fresh chain-history data the moment it lands")
 * has a hole a live mainnet swap fell straight through: a transaction
 * that NEVER lands has no chain entry to supersede it, so a dropped swap
 * stayed 'pending' forever once the Swapped screen's own poll was gone
 * (that poll only lives while the popup shows that screen — MV3 popup JS
 * dies the instant it closes). This gives a pending swap entry the same
 * definitive verdict FLUXIO_INTERNAL_SWAP_STATUS already computes:
 * confirmed/failed from getSignatureStatuses, or — the case the incident
 * hit — 'failed' with failureCode SWAP_BLOCKHASH_EXPIRED once the chain's
 * block height passes the entry's own recorded lastValidBlockHeight
 * (recorded by EXECUTE_SWAP since 0200), because a v0 transaction can
 * never be included after that point. Mutates the entry in place for the
 * CURRENT render and persists, exactly like the EVM sibling.
 */
async function resolvePendingSwapEntry(networkKey, network, entry) {
  try {
    const result = await transactionService.getTransactionStatus({ network: networkKey, signature: entry.signatureOrHash });
    const finalStatus = finalLocalStatusFor(network, result);
    if (finalStatus) {
      entry.status = finalStatus;
      await updateLocalTransactionStatus(networkKey, entry.signatureOrHash, finalStatus);
      if (finalStatus === 'confirmed') {
        await tryResolveRealReceived(networkKey, entry, { attemptLimit: MAX_REAL_AMOUNT_POLL_ATTEMPTS }); // prompt 0205 — never affects the verdict above
      }
      return;
    }
    if (result.status === 'not_found' && entry.lastValidBlockHeight != null) {
      // Trusted-height (or time-backup) verdict only — see
      // isSwapDefinitivelyExpired (prompt 0203 Revisi 2).
      const expired = await isSwapDefinitivelyExpired({
        lastValidBlockHeight: entry.lastValidBlockHeight,
        sentAtMs: entry.timestamp ?? null
      });
      if (expired) {
        entry.status = 'failed';
        entry.failureCode = 'SWAP_BLOCKHASH_EXPIRED';
        await updateLocalTransactionStatus(networkKey, entry.signatureOrHash, 'failed', { failureCode: 'SWAP_BLOCKHASH_EXPIRED' });
      }
    }
  } catch {
    // Best-effort only — same rule as the EVM sibling.
  }
}

/**
 * Startup sweep (prompt 0203 Revisi 1): closes out any still-'pending'
 * swap entry the moment the service worker next comes alive — Activity
 * doesn't have to be opened for the verdict to land. This is what
 * retroactively fails the incident's own stuck entry (its
 * lastValidBlockHeight IS recorded — 0200 always wrote it) on the first
 * extension start after this build. Per-entry isolation: one bad RPC
 * round can't block the rest.
 */
async function sweepPendingSwapEntries() {
  try {
    const list = await getLocalTransactions('solana');
    const pending = list.filter((e) => e.type === 'swap' && e.status === 'pending');
    const network = NETWORKS['solana'];
    for (const entry of pending) {
      await resolvePendingSwapEntry('solana', network, entry);
    }
    // Prompt 0205 (Revisi 1 pacing): confirmed swaps still missing their
    // REAL received amount get another chance on every worker wake — an
    // on-demand surface, so NO attempt ceiling, but braked to a few
    // entries per wake and still gap-spaced inside tryResolveRealReceived.
    // Entries just resolved in the loop above already had their attempt
    // inside resolvePendingSwapEntry — skip them here.
    const missingReal = list.filter((e) => missingRealReceived(e) && !pending.includes(e)).slice(0, MAX_REAL_AMOUNT_ENTRIES_PER_SURFACE);
    for (const entry of missingReal) {
      await tryResolveRealReceived('solana', entry);
    }
  } catch {
    // Best-effort — the GET_HISTORY piggyback covers the next open anyway.
  }
}

// ---- Active-swap re-broadcast (prompt 0203 Revisi 1) --------------------
// A single sendTransaction is ONE shot at inclusion; under mainnet
// congestion the transaction can be dropped from the relay mempool and
// silently never land (the real incident this exists for: signature
// returned, then getSignatureStatuses [null] on two RPCs, funds never
// moved). Fix: after the first send, keep re-broadcasting the IDENTICAL
// signed bytes (same signature — can never double-execute) every
// SWAP_REBROADCAST_INTERVAL_MS until the signature confirms, the
// blockhash expires (definitive failure), or ~60s passes.
//
// MV3-survivability: the loop runs in this service worker, but a worker
// can be killed at any time — so the loop's entire state lives in
// chrome.storage.session (signature, signed bytes, lastValidBlockHeight,
// a display summary), never in module memory, and THREE things restart
// it: (1) module init below (worker wake of any cause), (2) a
// chrome.alarms tick while a swap is active (the alarm API's 30s floor
// makes it a safety net, not the cadence driver), (3) the popup's
// FLUXIO_INTERNAL_GET_ACTIVE_SWAP call on open. storage.session (not
// .local) deliberately: it clears on browser restart, and a signed
// transaction older than a browser restart is guaranteed blockhash-dead —
// nothing worth persisting to disk.

const ACTIVE_SWAP_STORAGE_KEY = 'fluxio_active_swap';
const SWAP_REBROADCAST_ALARM_NAME = 'fluxio-swap-rebroadcast';
const SWAP_REBROADCAST_INTERVAL_MS = 2000;
const SWAP_REBROADCAST_MAX_MS = 60_000;

/**
 * Time-based BACKUP expiry (prompt 0203 Revisi 2): used ONLY when no RPC
 * gave a trustworthy block height (see getTrustedBlockHeight's fence).
 * 90s is comfortably past a mainnet blockhash's real lifetime (~60-90s),
 * so a not-found signature this old genuinely cannot land anymore.
 */
const SWAP_TIME_BACKUP_EXPIRY_MS = 90_000;

/**
 * THE one expiry check every SWAP_BLOCKHASH_EXPIRED verdict goes through
 * (prompt 0203 Revisi 2 — reviewer finding: publicnode's getBlockHeight
 * returns the SLOT, ~22M above the real block height, so the old direct
 * getBlockHeight comparison would stamp every swap expired instantly
 * whenever that fallback answered, killing the re-broadcast loop early).
 * Order: a TRUSTED height (getEpochInfo, self-sanity-checked per
 * endpoint) wins when any RPC provides one; with none, fall back to the
 * time backup — and with no sentAtMs either, refuse the verdict (a swap
 * is only ever declared dead on real evidence, never a bogus number).
 */
async function isSwapDefinitivelyExpired({ lastValidBlockHeight, sentAtMs }) {
  if (lastValidBlockHeight == null) return false;
  const height = await transactionService.getTrustedBlockHeight({ network: 'solana' });
  if (height != null) {
    return height > Number(lastValidBlockHeight);
  }
  return sentAtMs != null && Date.now() - Number(sentAtMs) >= SWAP_TIME_BACKUP_EXPIRY_MS;
}

async function readActiveSwap() {
  const result = await chrome.storage.session.get(ACTIVE_SWAP_STORAGE_KEY);
  return result?.[ACTIVE_SWAP_STORAGE_KEY] || null;
}

async function writeActiveSwap(state) {
  await chrome.storage.session.set({ [ACTIVE_SWAP_STORAGE_KEY]: state });
}

async function clearActiveSwap() {
  try {
    await chrome.storage.session.remove(ACTIVE_SWAP_STORAGE_KEY);
  } catch {
    // Best-effort.
  }
  try {
    await chrome.alarms.clear(SWAP_REBROADCAST_ALARM_NAME);
  } catch {
    // Best-effort.
  }
}

// Loop-generation token: each module instance bumps the shared counter
// and a running loop exits the moment a NEWER instance exists. In a real
// MV3 worker this is always 1 (a worker restart gets a fresh globalThis),
// so it never fires in production — it exists for the e2e bundle suite,
// where many cache-busted bundle instances share one test globalThis and
// a previous test's still-sleeping loop must never act on (or re-send
// into) the current test's mocks.
const SWAP_LOOP_GENERATION = (globalThis.__FLUXIO_SWAP_LOOP_GENERATION__ =
  (globalThis.__FLUXIO_SWAP_LOOP_GENERATION__ || 0) + 1);

let swapRebroadcastLoopRunning = false;

/** Idempotent starter — safe to call from every wake path; a second call while the loop runs is a no-op. */
function ensureSwapRebroadcastLoop() {
  if (swapRebroadcastLoopRunning) return;
  swapRebroadcastLoopRunning = true;
  runSwapRebroadcastLoop()
    .catch(() => {})
    .finally(() => {
      swapRebroadcastLoopRunning = false;
    });
}

async function runSwapRebroadcastLoop() {
  for (;;) {
    // A newer module instance owns the loop now — see SWAP_LOOP_GENERATION.
    if (globalThis.__FLUXIO_SWAP_LOOP_GENERATION__ !== SWAP_LOOP_GENERATION) {
      return;
    }
    // Re-read EVERY iteration (never cache): the state is the loop's
    // ownership token — gone (done elsewhere, or a fresh session) means
    // stop immediately.
    const state = await readActiveSwap();
    if (!state || !state.signature || (!state.rawTransactionBase64 && !state.rawSignedTx)) {
      return;
    }

    // ---- EVM branch (tahap B, prompt 0220) — receipt-based verdicts,
    // identical-bytes re-send every 15s, and an HONEST PENDING past the
    // 10-minute window (EVM has no blockhash expiry: the tx can still
    // land, so the entry stays 'pending' and the status poll or the
    // GET_HISTORY resolver settles it later — never a failure verdict).
    if (state.kind === 'evm') {
      // Tahap C staged legs (prompt 0223): a halted record is terminal —
      // the popup reads it via GET_ACTIVE_SWAP; nothing left to drive.
      if (state.stage === 'halted') {
        return;
      }
      // 0227 (0225 K8): the approve RESET leg — approve(0) sent first when
      // 0 < allowance < amountIn (USDT-class tokens revert a non-zero
      // approve over a non-zero allowance). Mirrors the 'approve' stage:
      // receipt 0x1 hands over to the continuation that signs the REAL
      // approve with the next local nonce; a revert or the shared window
      // closing stops honestly.
      if (state.stage === 'approveReset') {
        let resetVerdict = null;
        try {
          const resetReceipt = await evmSwapService.getEvmTransactionReceipt({ networkKey: state.networkKey, hash: state.resetHash });
          if (resetReceipt) resetVerdict = resetReceipt.status === '0x1' ? 'confirmed' : 'failed';
        } catch {
          // Transient RPC problem — no verdict this tick.
        }
        if (resetVerdict === 'failed') {
          try {
            await updateLocalTransactionStatus(state.networkKey, state.resetHash, 'failed');
          } catch {
            // Best-effort — the halt still happens.
          }
          await haltEvmStagedSwap(state, 'APPROVE_RESET_FAILED', { step: 'receipt', detail: 'approve reset receipt status 0x0' });
          return;
        }
        if (resetVerdict === 'confirmed') {
          try {
            await updateLocalTransactionStatus(state.networkKey, state.resetHash, 'confirmed');
          } catch {
            // Best-effort.
          }
          const done = await continueEvmTokenInApproveAfterReset(state);
          if (!done) {
            await new Promise((resolve) => setTimeout(resolve, evmSwapService.EVM_SWAP_REBROADCAST_INTERVAL_MS));
          }
          continue; // re-read the state: 'approve' polls on, 'halted' returns
        }
        if (Date.now() - state.startedAt >= evmSwapService.EVM_SWAP_PENDING_TIMEOUT_MS) {
          await haltEvmStagedSwap(state, 'APPROVE_PENDING_TIMEOUT', { step: 'window', detail: 'reset receipt not found before the window closed' });
          return;
        }
        try {
          await evmSwapService.sendEvmRawTransaction({ networkKey: state.networkKey, signedRawTx: state.resetRawSignedTx });
        } catch (err) {
          console.log('[fluxio] evm approve reset rebroadcast rejected (expected once known):', err?.message || String(err));
        }
        state.attempts = (state.attempts || 0) + 1;
        await writeActiveSwap(state);
        await new Promise((resolve) => setTimeout(resolve, evmSwapService.EVM_SWAP_REBROADCAST_INTERVAL_MS));
        continue;
      }
      if (state.stage === 'approve') {
        let approveVerdict = null;
        let approveReceipt = null;
        try {
          approveReceipt = await evmSwapService.getEvmTransactionReceipt({ networkKey: state.networkKey, hash: state.approveHash });
          if (approveReceipt) approveVerdict = approveReceipt.status === '0x1' ? 'confirmed' : 'failed';
        } catch {
          // Transient RPC problem — no verdict this tick.
        }
        if (approveVerdict === 'failed') {
          // The approve itself reverted: no allowance, no swap, only the
          // approve gas was charged — honest terminal stop. The approval
          // Activity entry (0223 Revisi 3) gets the same honest verdict.
          try {
            await updateLocalTransactionStatus(state.networkKey, state.approveHash, 'failed');
          } catch {
            // Best-effort — the halt still happens.
          }
          await haltEvmStagedSwap(state, 'APPROVE_FAILED', { step: 'receipt', detail: 'approve receipt status 0x0' });
          return;
        }
        if (approveVerdict === 'confirmed') {
          // The approval Activity entry confirms NOW, independent of the
          // swap leg's own fate (0223 Revisi 3 — gas spent must trace).
          try {
            await updateLocalTransactionStatus(state.networkKey, state.approveHash, 'confirmed');
          } catch {
            // Best-effort.
          }
          // The approve receipt rides along (0223 Revisi 1): its block/
          // gas figures let K4 stay exact when both legs share one block.
          const done = await continueEvmTokenInSwapAfterApprove(state, approveReceipt);
          if (!done) {
            // Transient trouble inside the continuation — retry next tick.
            await new Promise((resolve) => setTimeout(resolve, evmSwapService.EVM_SWAP_REBROADCAST_INTERVAL_MS));
          }
          continue; // re-read the state: 'swap' polls on, 'halted' returns
        }
        if (Date.now() - state.startedAt >= evmSwapService.EVM_SWAP_PENDING_TIMEOUT_MS) {
          // Past the one shared window the continuation is forbidden
          // anyway (condition i) — stop resending, tell the user honestly.
          await haltEvmStagedSwap(state, 'APPROVE_PENDING_TIMEOUT', { step: 'window', detail: 'approve receipt not found before the window closed' });
          return;
        }
        try {
          await evmSwapService.sendEvmRawTransaction({ networkKey: state.networkKey, signedRawTx: state.approveRawSignedTx });
        } catch (err) {
          console.log('[fluxio] evm approve rebroadcast rejected (expected once known):', err?.message || String(err));
        }
        state.attempts = (state.attempts || 0) + 1;
        await writeActiveSwap(state);
        await new Promise((resolve) => setTimeout(resolve, evmSwapService.EVM_SWAP_REBROADCAST_INTERVAL_MS));
        continue;
      }
      let evmVerdict = null;
      try {
        const receipt = await evmSwapService.getEvmTransactionReceipt({ networkKey: state.networkKey, hash: state.signature });
        if (receipt) evmVerdict = receipt.status === '0x1' ? 'confirmed' : 'failed';
      } catch {
        // Transient RPC problem — no verdict this tick.
      }
      if (evmVerdict) {
        try {
          await updateLocalTransactionStatus(state.networkKey, state.signature, evmVerdict);
        } catch {
          // Best-effort — the verdict still ends the loop.
        }
        if (evmVerdict === 'confirmed') {
          try {
            const entry = (await getLocalTransactions(state.networkKey)).find((e) => e.signatureOrHash === state.signature);
            if (entry) await tryResolveRealReceivedEvm(state.networkKey, entry);
          } catch {
            // Best-effort.
          }
        }
        await clearActiveSwap();
        return;
      }
      if (Date.now() - state.startedAt >= evmSwapService.EVM_SWAP_PENDING_TIMEOUT_MS) {
        await clearActiveSwap();
        return;
      }
      try {
        await evmSwapService.sendEvmRawTransaction({ networkKey: state.networkKey, signedRawTx: state.rawSignedTx });
      } catch (err) {
        // An "already known" class rejection is EXPECTED once the tx is in
        // the mempool/landed — ignored but logged (owner keputusan 0220
        // butir 2); the next receipt check settles it either way.
        console.log('[fluxio] evm swap rebroadcast rejected (expected once known):', err?.message || String(err));
      }
      state.attempts = (state.attempts || 0) + 1;
      await writeActiveSwap(state);
      await new Promise((resolve) => setTimeout(resolve, evmSwapService.EVM_SWAP_REBROADCAST_INTERVAL_MS));
      continue;
    }

    const network = NETWORKS[state.networkKey] || NETWORKS['solana'];

    // Verdict check first: confirmed/failed-on-chain, or definitively
    // expired (blockHeight past lastValidBlockHeight while still not
    // found — same rule as FLUXIO_INTERNAL_SWAP_STATUS).
    let verdict = null; // 'confirmed' | 'failed' | 'expired'
    try {
      const result = await transactionService.getTransactionStatus({ network: state.networkKey, signature: state.signature });
      const finalStatus = finalLocalStatusFor(network, result);
      if (finalStatus) {
        verdict = finalStatus;
      } else if (result.status === 'not_found' && state.lastValidBlockHeight != null) {
        // Trusted-height (or time-backup) verdict only — see
        // isSwapDefinitivelyExpired (prompt 0203 Revisi 2).
        const expired = await isSwapDefinitivelyExpired({
          lastValidBlockHeight: state.lastValidBlockHeight,
          sentAtMs: state.startedAt ?? null
        });
        if (expired) {
          verdict = 'expired';
        }
      }
    } catch {
      // Transient RPC problem — no verdict this tick, keep going.
    }

    if (verdict) {
      try {
        if (verdict === 'expired') {
          await updateLocalTransactionStatus(state.networkKey, state.signature, 'failed', { failureCode: 'SWAP_BLOCKHASH_EXPIRED' });
        } else {
          await updateLocalTransactionStatus(state.networkKey, state.signature, verdict);
        }
      } catch {
        // Best-effort — the verdict still ends the loop either way.
      }
      if (verdict === 'confirmed') {
        // Prompt 0205: first shot at the REAL received amount — the
        // transaction is seconds old here, exactly when every endpoint
        // still has it. Never affects the verdict above.
        try {
          const entry = (await getLocalTransactions(state.networkKey)).find((e) => e.signatureOrHash === state.signature);
          if (entry) await tryResolveRealReceived(state.networkKey, entry, { attemptLimit: MAX_REAL_AMOUNT_POLL_ATTEMPTS });
        } catch {
          // Best-effort.
        }
      }
      await clearActiveSwap();
      return;
    }

    if (Date.now() - state.startedAt >= SWAP_REBROADCAST_MAX_MS) {
      // Re-broadcast window over without a verdict (blockhash can outlive
      // it by a few tens of seconds). Stop re-sending; the pending-swap
      // sweep / GET_HISTORY piggyback owns the final verdict from here.
      await clearActiveSwap();
      return;
    }

    try {
      await transactionService.sendRawSerializedTransaction({
        network: state.networkKey,
        signedTransactionBase64: state.rawTransactionBase64
      });
      state.attempts = (state.attempts || 0) + 1;
      await writeActiveSwap(state);
    } catch {
      // A rejected re-send (e.g. "already processed" once it lands
      // mid-loop) is fine — the next verdict check settles it.
    }

    await new Promise((resolve) => setTimeout(resolve, SWAP_REBROADCAST_INTERVAL_MS));
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SWAP_REBROADCAST_ALARM_NAME) return;
  ensureSwapRebroadcastLoop();
});

// Worker wake (any cause — browser start, message, alarm): resume a
// re-broadcast the previous worker instance didn't finish, and close out
// any stuck pending swap entries. Both are cheap no-ops when there's
// nothing to do (one storage read each, zero RPC).
ensureSwapRebroadcastLoop();
sweepPendingSwapEntries();

const dappRequestHandlers = {
  CONNECT: async ({ payload, origin }) => {
    await requireApproval({ origin, type: 'CONNECT', summary: await currentAccountSummary() });
    const wallet = walletService.getPublicWallet();
    return {
      // Ethereum/BNB/Base share one account; Solana has its own.
      solana: wallet.accounts.solana.address,
      evm: wallet.accounts.evm.address
    };
  },

  SIGN_MESSAGE: async ({ payload, origin }) => {
    const { network, message } = requireSignMessagePayload(payload);
    await requireApproval({
      origin,
      type: 'SIGN_MESSAGE',
      summary: { network, message, ...(await currentAccountSummary(network)) }
    });
    const bytesOrString = network === 'solana' ? textToBytes(message) : message;
    const signature = await walletService.signMessage(network, bytesOrString);
    return { network, signature: serializeSignature(signature) };
  },

  SIGN_TRANSACTION: async ({ payload, origin }) => {
    const { network, transaction } = requireSignTransactionPayload(payload);
    await requireApproval({
      origin,
      type: 'SIGN_TRANSACTION',
      summary: { network, ...(await currentAccountSummary(network)) }
    });
    const signature = await walletService.signTransaction(network, transaction);
    return { network, signature: serializeSignature(signature) };
  }
};

/**
 * Multi-account: snapshots which account (name + the address that will
 * actually act, if a specific network is given) is active RIGHT NOW, for
 * the approval popup to display. There is no persistent per-origin
 * "connected account" anywhere in this codebase (approvalService.js is a
 * one-shot pending-request queue — every CONNECT/SIGN_* always requires a
 * fresh approval) so there's nothing to keep "in sync" beyond this: each
 * approval simply reflects whichever account is active at the moment the
 * dApp's request comes in, read fresh, never cached. Returns `{}` if
 * locked (requireApproval's own hasWallet()/approval-window flow handles
 * that case; this never blocks on it).
 */
async function currentAccountSummary(networkKey) {
  if (!walletService.isUnlocked()) return {};
  const wallet = walletService.getPublicWallet();
  const { accounts } = await accountsService.getAccountsState();
  const accountName = accounts.find((a) => a.index === wallet.accountIndex)?.name || `Account ${wallet.accountIndex + 1}`;
  const address = networkKey ? walletService.getAccountForNetwork(wallet, networkKey).address : null;
  return address ? { accountName, address } : { accountName };
}

/**
 * Gate every dApp-facing action behind a real approval round trip: opens
 * an approval window and blocks on `promise`, which only settles once the
 * user (via approval.js -> FLUXIO_INTERNAL_APPROVE/REJECT) makes a
 * decision, or the window is closed unanswered.
 */
async function requireApproval({ origin, type, summary }) {
  if (!(await walletService.hasWallet())) {
    throw new Error('WALLET_NOT_INITIALIZED');
  }

  const { id, promise } = createApprovalRequest({ origin, type, summary });
  const windowId = await openApprovalWindow(id);

  const onWindowClosed = (closedId) => {
    if (closedId === windowId) {
      try {
        rejectRequest(id, 'Approval window closed without a decision.');
      } catch {
        // Already resolved — nothing to do.
      }
    }
  };
  chrome.windows.onRemoved.addListener(onWindowClosed);

  try {
    await promise;
  } finally {
    chrome.windows.onRemoved.removeListener(onWindowClosed);
  }
}

function openApprovalWindow(requestId) {
  return new Promise((resolve, reject) => {
    chrome.windows.create(
      {
        url: chrome.runtime.getURL(`approval/approval.html?id=${encodeURIComponent(requestId)}`),
        type: 'popup',
        ...APPROVAL_WINDOW_SIZE
      },
      (win) => {
        if (chrome.runtime.lastError || !win) {
          reject(new Error(chrome.runtime.lastError?.message || 'Failed to open approval window.'));
          return;
        }
        resolve(win.id);
      }
    );
  });
}

/**
 * In-memory cache of Jupiter's verified token list (prompt 0115) — the
 * "You receive" picker's data source. Deliberately just a plain module
 * variable, not chrome.storage.local: it's large (thousands of entries),
 * purely a read-through cache of a public/non-sensitive API response
 * (never anything this wallet needs to persist across restarts), and a
 * service worker's module state naturally resets every time Chrome tears
 * it down and reinitializes it — exactly the "cache for this service-
 * worker's lifetime, nothing longer" scope this feature asked for, with
 * zero expiry/TTL logic needed to get that behavior.
 */
let verifiedSwapTokensCache = null;

// ---- Token-metadata snapshot (prompt 0206, owner decision 2-A) ----
// The verified list the Swap screen ALREADY fetches carries every mint's
// symbol/name/decimals — snapshotting that (naming fields only, no
// logoUri: the remote-logo idea was cancelled by the owner) lets the
// dashboard and Activity name tokens like USDT without their own Jupiter
// call, ever. Deliberate scope: ONLY mints present in the verified
// snapshot get a name from it — an unknown airdropped token must keep
// looking unknown, never accidentally legitimate. Lookup priority when
// naming (enforced at the use sites): user-created custom token >
// built-in registry > this snapshot > "Unknown".
const TOKEN_METADATA_STORAGE_KEY = 'fluxio_token_metadata';
const TOKEN_METADATA_MAX_AGE_MS = 24 * 60 * 60 * 1000; // rewrite at most once per 24h (owner's brake)

async function maybeStoreTokenMetadataSnapshot(tokens) {
  const existing = await new Promise((resolve) => {
    chrome.storage.local.get([TOKEN_METADATA_STORAGE_KEY], (r) => resolve(r?.[TOKEN_METADATA_STORAGE_KEY] || null));
  });
  if (existing?.updatedAt && Date.now() - existing.updatedAt < TOKEN_METADATA_MAX_AGE_MS && existing.byMint) {
    return; // fresh enough — the brake
  }
  const byMint = {};
  for (const t of tokens || []) {
    if (t?.address && t.symbol) byMint[t.address] = { symbol: t.symbol, name: t.name || t.symbol, decimals: t.decimals };
  }
  await new Promise((resolve) => {
    chrome.storage.local.set({ [TOKEN_METADATA_STORAGE_KEY]: { updatedAt: Date.now(), byMint } }, () => resolve());
  });
}

async function readTokenMetadataSnapshot() {
  return new Promise((resolve) => {
    chrome.storage.local.get([TOKEN_METADATA_STORAGE_KEY], (r) => resolve(r?.[TOKEN_METADATA_STORAGE_KEY]?.byMint || null));
  });
}

// ---- Swap quote cache (prompt 0200) ----
// FLUXIO_INTERNAL_GET_SWAP_QUOTE hands the popup an opaque quoteId and
// keeps Jupiter's raw quote object HERE — the popup never sees or sends
// back a raw quote (so EXECUTE_SWAP can never be fed a tampered/foreign
// quote; it only ever spends an id this worker itself minted for this
// session's own address). Entries are single-use and expire after
// SWAP_QUOTE_TTL_MS — an expired/consumed/unknown id is one error:
// SWAP_QUOTE_EXPIRED, and the popup re-quotes.
const SWAP_QUOTE_TTL_MS = 60_000;
const SWAP_QUOTE_CACHE_MAX = 8;
const swapQuoteCache = new Map(); // quoteId -> { raw, address, inputMint, outputMint, ..., createdAt }

function pruneSwapQuoteCache() {
  const now = Date.now();
  for (const [id, entry] of swapQuoteCache) {
    if (now - entry.createdAt > SWAP_QUOTE_TTL_MS) swapQuoteCache.delete(id);
  }
  while (swapQuoteCache.size > SWAP_QUOTE_CACHE_MAX) {
    // Map iterates in insertion order — the first key is the oldest.
    swapQuoteCache.delete(swapQuoteCache.keys().next().value);
  }
}

function takeSwapQuote(quoteId, address) {
  pruneSwapQuoteCache();
  const entry = swapQuoteCache.get(quoteId);
  // Single-use: consumed on lookup regardless of outcome, so a retried
  // EXECUTE_SWAP always re-quotes rather than replaying a stale build.
  if (entry) swapQuoteCache.delete(quoteId);
  if (!entry || entry.address !== address) return null;
  return entry;
}

/** Read-only sibling of takeSwapQuote — PREVIEW_SWAP_FEES must NOT consume the id the later EXECUTE_SWAP still needs. */
function peekSwapQuote(quoteId, address) {
  pruneSwapQuoteCache();
  const entry = swapQuoteCache.get(quoteId);
  if (!entry || entry.address !== address) return null;
  return entry;
}

/**
 * Caches one parsed getSwapQuote() result under a fresh quoteId and
 * shapes the exact response FLUXIO_INTERNAL_GET_SWAP_QUOTE has always
 * returned (prompt 0205 Revisi 4 refactor): the SAME code now also backs
 * EXECUTE_SWAP's quote-changed path, so the Review screen re-rendered
 * after SWAP_QUOTE_CHANGED can never drift from a normal quote response.
 * Includes the 0203-Revisi-3 fee-display correction (an input-side fee
 * amount is computed from the input amount, never Jupiter's
 * output-denominated platformFee.amount).
 */
function cacheAndShapeQuote({ quote, feeInfo, inputMint, outputMint, inputDecimals, outputDecimals, inputSymbol, outputSymbol, address }) {
  const platformFeeAmountRaw = feeInfo
    ? swapService.computePlatformFeeDisplayRaw({
        feeSide: feeInfo.feeSide,
        feeBps: swapService.SWAP_FEE_BPS,
        inAmountRaw: quote.inAmountRaw,
        quoteFeeAmountRaw: quote.feeAmountRaw
      })
    : null;

  const quoteId = crypto.randomUUID();
  pruneSwapQuoteCache();
  swapQuoteCache.set(quoteId, {
    raw: quote.raw,
    address,
    inputMint,
    outputMint,
    inputDecimals,
    outputDecimals,
    inputSymbol: inputSymbol || '?',
    outputSymbol: outputSymbol || '?',
    inAmountRaw: quote.inAmountRaw,
    outAmountRaw: quote.outAmountRaw,
    minReceivedRaw: quote.minReceivedRaw,
    feeInfo,
    feeBps: quote.feeBps,
    feeAmountRaw: platformFeeAmountRaw,
    createdAt: Date.now()
  });

  // A fee on the INPUT side is denominated in the input mint (0199's
  // ExactOut/either-side finding) — format at the matching decimals.
  const feeDecimals = feeInfo && feeInfo.feeSide === 'input' ? inputDecimals : outputDecimals;
  return {
    quoteId,
    response: {
      quoteId,
      inAmountFormatted: formatUnits(quote.inAmountRaw, inputDecimals),
      outAmountFormatted: formatUnits(quote.outAmountRaw, outputDecimals),
      minReceivedFormatted: formatUnits(quote.minReceivedRaw, outputDecimals),
      priceImpactPct: quote.priceImpactPct,
      slippageBps: quote.slippageBps,
      feeIncluded: quote.feeIncluded,
      feeBps: quote.feeBps,
      feeSide: feeInfo ? feeInfo.feeSide : null,
      feeAmountFormatted: platformFeeAmountRaw != null ? formatUnits(platformFeeAmountRaw, feeDecimals) : null
    }
  };
}

/**
 * EVM sibling of cacheAndShapeQuote (prompt 0219, tahap A): caches one
 * KyberSwap quote under the SAME single-use quoteId cache and shapes the
 * SAME response field names the popup's quote panel/Review already read,
 * so the popup needs no new response shape for EVM. The cached entry
 * carries `kind: 'evm'` plus everything tahap B's build will need —
 * owner keputusan 0219 butir 4: `routeSummary` stored UNTOUCHED
 * (Kyber's build checksum depends on its exact contents), plus
 * routerAddress, gasEstimate, slippageBps and fetchedAt. There is NO
 * Fluxio fee on EVM (owner opsi A) — the fee fields are explicitly
 * null/false, and the popup renders its own "Fluxio fee: none" row.
 * "Minimum received" is computed HERE — Kyber's routes endpoint does not
 * apply slippage (unlike Jupiter's otherAmountThreshold) — as
 * floor(amountOut × (10000 − slippageBps) / 10000) in BigInt, and the
 * popup labels it "(est.)" per owner keputusan (iii).
 */
function cacheAndShapeEvmQuote({ networkKey, quote, inputRef, outputRef, inputDecimals, outputDecimals, inputSymbol, outputSymbol, slippageBps, address }) {
  const bps = BigInt(Math.max(0, Math.min(10000, Number(slippageBps) || 0)));
  const minReceivedRaw = (quote.amountOutRaw * (10000n - bps)) / 10000n;
  // Price impact from Kyber's own USD legs when both are present —
  // display-only, never used for any money math. Emitted as a FRACTION
  // of 1 (0.0021 = 0.21%), the same denomination Jupiter's
  // priceImpactPct uses, because the popup's formatPriceImpact()
  // multiplies by 100 — caught by 0219's own visual pass (a percent
  // here rendered as 21.00% instead of 0.21%), the 0203 denomination
  // lesson striking again. Since the Fluxio fee rides inside every
  // route (0221), Kyber's outUsd is NET of it — so the impact compares
  // against the input NET of the same fee (0221 Revisi 1, owner
  // keputusan): the fee has its own labeled row and must not inflate
  // this number (~1.01% where the route itself moved ~0.16%).
  let priceImpactPct = null;
  const inUsd = Number(quote.amountInUsd);
  const outUsd = Number(quote.amountOutUsd);
  if (Number.isFinite(inUsd) && inUsd > 0 && Number.isFinite(outUsd)) {
    const feeOpts = evmSwapService.EVM_SWAP_FEE_OPTIONS;
    const inNet = feeOpts.chargeFeeBy === 'currency_in' ? (inUsd * (10000 - feeOpts.feeAmount)) / 10000 : inUsd;
    priceImpactPct = String((inNet - outUsd) / inNet);
  }

  const quoteId = crypto.randomUUID();
  pruneSwapQuoteCache();
  swapQuoteCache.set(quoteId, {
    kind: 'evm',
    networkKey,
    address,
    inputRef,
    outputRef,
    inputDecimals,
    outputDecimals,
    inputSymbol: inputSymbol || '?',
    outputSymbol: outputSymbol || '?',
    inAmountRaw: quote.amountInRaw,
    outAmountRaw: quote.amountOutRaw,
    minReceivedRaw,
    gasEstimate: quote.gasEstimate,
    routerAddress: quote.routerAddress,
    routeSummary: quote.routeSummary,
    slippageBps: Number(slippageBps) || 0,
    fetchedAt: Date.now(),
    createdAt: Date.now()
  });

  return {
    quoteId,
    response: {
      quoteId,
      inAmountFormatted: formatUnits(quote.amountInRaw, inputDecimals),
      outAmountFormatted: formatUnits(quote.amountOutRaw, outputDecimals),
      minReceivedFormatted: formatUnits(minReceivedRaw, outputDecimals),
      priceImpactPct,
      slippageBps: Number(slippageBps) || 0,
      // The Fluxio fee rides on every BNB Chain quote since 0221 (owner
      // keputusan: 85 bps, every pair, charged from the PAY side inside
      // the router — Kyber's own outAmount is already net of it). The
      // display amount is OUR floor(amountIn × 85 / 10000) in the pay
      // currency (keputusan 5), never a re-read of Kyber's numbers.
      feeIncluded: true,
      feeBps: evmSwapService.EVM_SWAP_FEE_OPTIONS.feeAmount,
      feeSide: 'input',
      feeAmountFormatted: formatUnits(evmSwapService.computeEvmSwapFeeRaw(quote.amountInRaw), inputDecimals)
    }
  };
}

// ---- EVM swap execute (tahap B, prompt 0220) -----------------------------

/**
 * EVM sibling of tryResolveRealReceived (prompt 0220, pola 0205): once an
 * EVM swap entry is confirmed, the REAL received amount is the sum of the
 * receipt's own ERC-20 Transfer logs into the owner's address — parsed by
 * evmSwapService.parseErc20ReceivedFromReceipt (pure, fixture-proven) and
 * persisted on the entry, never able to change a verdict.
 */
async function tryResolveRealReceivedEvm(networkKey, entry) {
  if (!entry || entry.type !== 'swap' || entry.receivedRealRaw != null) return;
  if (!entry.outputMint || !entry.ownerAddress) return;
  try {
    const receipt = await evmSwapService.getEvmTransactionReceipt({ networkKey, hash: entry.signatureOrHash });
    if (!receipt || receipt.status !== '0x1') return;
    // Tahap C (prompt 0223, owner K4): a NATIVE output cannot be read from
    // Transfer logs — the real received BNB is the balance delta around
    // the receipt's own block plus the gas the tx itself paid, both
    // eth_getBalance reads at EXPLICIT block tags (an endpoint refusing a
    // historic block falls through to the next one, the 0213 pattern).
    // Out-of-bounds results keep the estimate, labeled est. — the delta
    // can be polluted by unrelated transfers in the same block, so bounds
    // fail SAFE, never fail wrong. Never able to change a verdict.
    if (entry.outputMint === 'native') {
      const blockNumber = BigInt(receipt.blockNumber);
      // 0232 Revisi 3 — on an op-stack network (l1 oracle constant), a
      // seconds-old receipt can carry a NOT YET CANONICAL l1Fee (proven
      // on Base: first read 22.257.870.609 vs canonical 99.847.647.673,
      // understating the shown received by 77.589.777.064 wei). Lock the
      // final figure only when the receipt is at least 2 blocks old, or
      // when two consecutive reads agree on the same l1Fee; until then
      // the screen keeps the existing est. label. Networks without an
      // l1 oracle (ethereum, bnb) keep locking on the first read.
      const isL1Network = evmSwapService.EVM_L1_FEE_ORACLE_BY_NETWORK[networkKey] != null;
      let resolvedAtBlock = null;
      if (isL1Network) {
        let lockAllowed = false;
        try {
          const latest = await evmSwapService.getEvmBlockNumber({ networkKey });
          resolvedAtBlock = latest.toString();
          if (latest >= blockNumber + 2n) lockAllowed = true;
        } catch {
          // No latest read — fall through to the two identical reads rule.
        }
        if (!lockAllowed && entry.pendingL1FeeWei != null && receipt.l1Fee != null && BigInt(entry.pendingL1FeeWei) === BigInt(receipt.l1Fee)) {
          lockAllowed = true;
        }
        if (!lockAllowed) {
          entry.pendingL1FeeWei = receipt.l1Fee ?? null;
          await updateLocalTransactionFields(networkKey, entry.signatureOrHash, { pendingL1FeeWei: entry.pendingL1FeeWei });
          return; // belum terkunci — layar tetap angka est.
        }
      }
      const [after, before] = await Promise.all([
        evmSwapService.getEvmBalanceAtBlock({ networkKey, address: entry.ownerAddress, blockHex: '0x' + blockNumber.toString(16) }),
        evmSwapService.getEvmBalanceAtBlock({ networkKey, address: entry.ownerAddress, blockHex: '0x' + (blockNumber - 1n).toString(16) })
      ]);
      // 0223 Revisi 1 (K4, same-block correction): when the approve leg
      // landed in the SAME block as the swap, the balance delta already
      // paid the approve gas too — add it back from the figures the entry
      // recorded at swap time; different blocks (or no approve) keep the
      // plain formula.
      let extra = {};
      try {
        if (
          entry.approveBlockNumber != null &&
          receipt.blockNumber != null &&
          BigInt(entry.approveBlockNumber) === BigInt(receipt.blockNumber)
        ) {
          extra = { extraGasUsed: entry.approveGasUsed, extraEffectiveGasPrice: entry.approveEffectiveGasPrice };
        }
      } catch {
        // Malformed block figures — fall back to the plain formula.
      }
      const raw = evmSwapService.computeEvmNativeReceivedFromBalances({
        balanceBeforeWei: before,
        balanceAfterWei: after,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        ...extra,
        // 0227 (0226-proven): an op-stack receipt (Base) carries l1Fee —
        // charged OUTSIDE gasUsed × effectiveGasPrice, so the delta only
        // closes exactly when it is added back. Presence-driven from the
        // receipt's own field, never assumed per network.
        ...(receipt.l1Fee != null ? { l1FeeWei: receipt.l1Fee } : {})
      });
      if (raw == null) return;
      const rawBig = BigInt(raw);
      if (entry.otherAmountThresholdRaw != null && rawBig < BigInt(entry.otherAmountThresholdRaw)) return;
      if (entry.outputAmountRaw != null && rawBig > 2n * BigInt(entry.outputAmountRaw)) return;
      entry.receivedRealRaw = raw;
      // 0232 Revisi 3 — forensik: l1 yang DIPAKAI dan blok saat terkunci,
      // supaya selisih macam insiden Base terbaca tanpa menebak.
      entry.l1FeeUsedWei = receipt.l1Fee ?? null;
      entry.receivedResolvedAtBlock = resolvedAtBlock ?? blockNumber.toString();
      await updateLocalTransactionFields(networkKey, entry.signatureOrHash, { receivedRealRaw: raw, l1FeeUsedWei: entry.l1FeeUsedWei, receivedResolvedAtBlock: entry.receivedResolvedAtBlock });
      return;
    }
    const raw = evmSwapService.parseErc20ReceivedFromReceipt({
      receipt,
      tokenAddress: entry.outputMint,
      recipient: entry.ownerAddress
    });
    if (raw != null) {
      entry.receivedRealRaw = raw;
      await updateLocalTransactionFields(networkKey, entry.signatureOrHash, { receivedRealRaw: raw });
    }
  } catch {
    // Best-effort — the estimate keeps showing, labeled est.
  }
}

/**
 * EXECUTE for the EVM native-in direction (tahap B, prompt 0220 —
 * BNB to token only; token-in needs the tahap C approve flow). Every
 * guard below runs BEFORE walletService.signTransaction is reachable;
 * any failed guard is a structured error and nothing is signed
 * (KONTEKS 5, each guard locked by its own e2e proving the broadcast
 * never fires). The unlock gate already ran in the EXECUTE_SWAP handler.
 */
/**
 * 0227 Revisi 1 K2 — the estimated op-stack L1 data fee a PREVIEW adds to
 * the displayed total on an oracle network (base; detected by CONSTANT,
 * ethereum/bnb return 0n without any call). The REAL build calldata is
 * fetched from Kyber (the cached quote's own untouched routeSummary, the
 * same sender/recipient disclosure boundary EXECUTE's build has) and
 * priced through GasPriceOracle.getL1Fee. ANY failure returns 0n with a
 * log line — the owner's explicit choice: the x1,2 gas headroom usually
 * covers the small L1 fee (fase 1 measured 0,26% of the ceiling), so a
 * failed estimate must never block the preview.
 * @returns {Promise<bigint>}
 */
async function previewEvmSwapL1FeeWei(entry, evmAddr, { gasLimit, maxFeePerGas, valueRaw }) {
  if (!evmSwapService.EVM_L1_FEE_ORACLE_BY_NETWORK[entry.networkKey]) return 0n;
  try {
    const build = await evmSwapService.buildEvmSwapTransaction({
      networkKey: entry.networkKey,
      routeSummary: entry.routeSummary,
      sender: evmAddr,
      recipient: evmAddr,
      slippageBps: entry.slippageBps
    });
    const l1 = await evmSwapService.estimateL1FeeWei({
      networkKey: entry.networkKey,
      calldata: build.calldata,
      gasLimit,
      maxFeePerGas,
      to: build.routerAddress,
      valueRaw
    });
    if (l1 == null) {
      console.log('[fluxio] l1 fee preview unavailable (oracle) — ceiling shown without it');
      return 0n;
    }
    return l1;
  } catch (err) {
    console.log('[fluxio] l1 fee preview unavailable (build):', err?.message || String(err));
    return 0n;
  }
}

/** EvmSwapValidationError carries its code as a PROPERTY; only the message string crosses the extension message boundary — re-throw with the code prefixed, the exact convention every Solana swap error already follows ('SWAP_LOCKED: …'). */
function rethrowEvmCoded(err) {
  if (err && err.name === 'EvmSwapValidationError' && err.code) {
    throw new Error(`${err.code}: ${err.message}`);
  }
  throw err;
}

async function executeEvmSwap({ quoteId, networkKey }) {
  // Pagar (a) — the emergency build switch (direction gate is pagar b's).
  if (!evmSwapService.EVM_SWAP_EXECUTION_ENABLED) {
    throw new Error('EVM_SWAP_NOT_AVAILABLE: Swaps on this network are not enabled in this build. No funds moved.');
  }
  const network = NETWORKS[networkKey];
  // K6 (0225): error texts name the NETWORK's own native coin — the same
  // registry field GET_SWAP_TOKENS already reads for its native entry.
  const nativeSymbol = network.nativeCurrency.symbol;
  const wallet = walletService.getPublicWallet();
  const { address } = walletService.getAccountForNetwork(wallet, networkKey);

  // Pagar (b) — single-use quoteId, kind evm, bound to THIS session's own
  // EVM address. PEEK first (0205 R4 pattern): a failed re-quote must
  // leave the displayed quote alive so the popup can return to Review.
  const displayed = peekSwapQuote(quoteId, address);
  if (!displayed || displayed.kind !== 'evm' || displayed.networkKey !== networkKey) {
    throw new Error('SWAP_QUOTE_EXPIRED: The quote has expired. Refresh the quote and try again.');
  }
  // Direction gate (tahap C, prompt 0223 — owner keputusan K5): native-in
  // (0220) and token-in to NATIVE out execute; token to token stays
  // coming soon with the same honest text.
  const isTokenIn = displayed.inputRef !== 'native';
  if (isTokenIn && displayed.outputRef !== 'native') {
    throw new Error('EVM_SWAP_NOT_AVAILABLE: Swapping a token to another token is coming soon. No funds moved.');
  }

  // Pagar (c) — fresh quote with IDENTICAL parameters (0205 R4 in EVM
  // form): within 0,1% continues silently; worse re-caches under a NEW id
  // and returns to Review; a failed re-quote never executes the old one.
  // Token-in note (0223): this pre-approve freshness check is ON TOP of
  // K2's mandated post-approve re-quote in the continuation — stricter
  // than the keputusan's literal order, never looser.
  let fresh;
  try {
    fresh = await evmSwapService.getEvmSwapQuote({
      networkKey,
      tokenIn: displayed.inputRef === 'native' ? evmSwapService.NATIVE_EVM_SENTINEL : displayed.inputRef,
      tokenOut: displayed.outputRef === 'native' ? evmSwapService.NATIVE_EVM_SENTINEL : displayed.outputRef,
      amountInRaw: displayed.inAmountRaw
    });
  } catch {
    return { requoteFailed: true };
  }
  // Acceptance rule by direction (0223 Revisi 3, owner K8): native-in
  // keeps the 0,1% band; token-in accepts any fresh quote whose output
  // still covers the MINIMUM the user saw on Review (displayedMinOutRaw)
  // — the 0,1% band was empirically too tight for this pair (requote
  // drift measured at 0,139% in 1,5 seconds; evidence requote-compare
  // .json), so near-identical quotes kept bouncing back as
  // SWAP_QUOTE_CHANGED with identical numbers (gejala B). The build then
  // re-derives its slippage so the ON CHAIN minimum never drops below the
  // displayed one (see buildSlippageBps below).
  const freshUnacceptable = isTokenIn
    ? fresh.amountOutRaw < displayed.minReceivedRaw
    : fresh.amountOutRaw * 1000n < displayed.outAmountRaw * 999n;
  if (freshUnacceptable) {
    takeSwapQuote(quoteId, address); // old id dies here — it can never be replayed
    const { response } = cacheAndShapeEvmQuote({
      networkKey,
      quote: fresh,
      inputRef: displayed.inputRef,
      outputRef: displayed.outputRef,
      inputDecimals: displayed.inputDecimals,
      outputDecimals: displayed.outputDecimals,
      inputSymbol: displayed.inputSymbol,
      outputSymbol: displayed.outputSymbol,
      slippageBps: displayed.slippageBps,
      address
    });
    return { quoteChanged: true, code: 'SWAP_QUOTE_CHANGED', quote: response };
  }

  // Pagar (b2), prompt 0221 (owner keputusan 4): the FRESH quote's own
  // routeSummary.extraFee must echo OUR fee parameters exactly before
  // anything downstream may run — a quote without the confirmed fee
  // would either skip the treasury fee silently or charge a fee row the
  // route never carries. Pure check, unit-tested; nothing is signed on
  // failure and the displayed id stays alive (peek only so far).
  try {
    evmSwapService.verifyEvmFeeEcho(fresh.routeSummary?.extraFee);
  } catch (err) {
    rethrowEvmCoded(err);
  }

  // Sanity guard (owner keputusan 0220 butir 5 — a guard the Solana path
  // does not have yet, parity candidate): the FRESH quote's implied USD
  // legs are checked against the portfolio price cache, but ONLY when the
  // cache is younger than 30s and both prices exist — missing/stale data
  // skips the check without failing. Beyond 5% nothing is signed.
  try {
    const cached = await getCachedPrices();
    if (cached && Date.now() - (cached.fetchedAt || 0) <= evmSwapService.EVM_SWAP_SANITY_PRICE_MAX_AGE_MS) {
      // 0227 (0225 K4): per-network native coin id AND both sides resolve
      // 'native' — before this, the input price was hardcoded to
      // 'binancecoin' and a 'native' OUTPUT resolved to no id at all, so
      // the token-in direction silently skipped the check (bnb included;
      // a recorded behavior change, not just a new-network branch).
      const nativeCoinId = evmSwapService.EVM_SWAP_NATIVE_COIN_IDS[networkKey];
      const inCoinId = displayed.inputRef === 'native' ? nativeCoinId : resolveTokenCoinId({ networkKey, address: displayed.inputRef });
      const outCoinId = displayed.outputRef === 'native' ? nativeCoinId : resolveTokenCoinId({ networkKey, address: displayed.outputRef });
      const inputUsdPrice = inCoinId ? cached.pricesByCoinId?.[inCoinId]?.usd : undefined;
      const outputUsdPrice = outCoinId ? cached.pricesByCoinId?.[outCoinId]?.usd : undefined;
      const deviation = evmSwapService.computeQuoteUsdDeviation({
        amountInRaw: fresh.amountInRaw,
        inputDecimals: displayed.inputDecimals,
        inputUsdPrice,
        amountOutRaw: fresh.amountOutRaw,
        outputDecimals: displayed.outputDecimals,
        outputUsdPrice
      });
      if (deviation != null && deviation > evmSwapService.EVM_SWAP_SANITY_MAX_DEVIATION) {
        throw new Error('EVM_SWAP_QUOTE_SUSPICIOUS: This quote looks far from the market price. Try again in a moment. No funds moved.');
      }
    }
  } catch (err) {
    if (String(err?.message || '').includes('EVM_SWAP_QUOTE_SUSPICIOUS')) throw err;
    // A cache read hiccup must never block a legitimate swap — skip.
  }

  // Fresh quote is good — NOW consume the id (single use, same as Solana).
  const entry = takeSwapQuote(quoteId, address);
  if (!entry) {
    throw new Error('SWAP_QUOTE_EXPIRED: The quote has expired. Refresh the quote and try again.');
  }

  // ---- Tahap C (prompt 0223, owner K1/K3): token-in reads the live
  // allowance and the pay token's own balance BEFORE anything signs.
  // Allowance >= amountIn skips the approve leg entirely (one swap
  // transaction, falling through to the common tail below with value 0);
  // anything less starts the staged approve flow and returns.
  if (isTokenIn) {
    let allowance, tokenBalance;
    try {
      [allowance, tokenBalance] = await Promise.all([
        evmSwapService.getErc20Allowance({ networkKey, tokenAddress: entry.inputRef, owner: address, spender: fresh.routerAddress }),
        evmSwapService.getErc20Balance({ networkKey, tokenAddress: entry.inputRef, owner: address })
      ]);
    } catch (err) {
      rethrowEvmCoded(err);
    }
    if (tokenBalance < fresh.amountInRaw) {
      throw new Error(`EVM_SWAP_INSUFFICIENT_BALANCE: You do not have enough ${entry.inputSymbol} for this swap. No funds moved.`);
    }
    if (allowance < fresh.amountInRaw) {
      // 0227 (0225 K8, every token): a LIVE partial allowance means the
      // reset leg (approve 0) goes first — USDT-class tokens revert a
      // non-zero approve over a non-zero allowance.
      return startEvmTokenInApprove({ networkKey, network, address, entry, fresh, quoteId, resetFirst: allowance > 0n });
    }
  }

  // Pagar (d) — build from the FRESH routeSummary and verify the response
  // against what the user is about to sign for (pure checks, unit-tested).
  // Token-in (K8): the build's slippage is re-derived from the DISPLAYED
  // minimum so the on-chain floor never drops below what Review promised:
  // min(user bps, floor((fresh − displayedMin) × 10000 / fresh)).
  const buildSlippageBps = isTokenIn
    ? Number(
        BigInt(entry.slippageBps || 0) < ((fresh.amountOutRaw - entry.minReceivedRaw) * 10000n) / fresh.amountOutRaw
          ? BigInt(entry.slippageBps || 0)
          : ((fresh.amountOutRaw - entry.minReceivedRaw) * 10000n) / fresh.amountOutRaw
      )
    : entry.slippageBps;
  let build;
  try {
    build = await evmSwapService.buildEvmSwapTransaction({
      networkKey,
      routeSummary: fresh.routeSummary,
      sender: address,
      recipient: address,
      slippageBps: buildSlippageBps
    });
    evmSwapService.verifyEvmSwapBuild({
      build,
      expectedRouterAddress: fresh.routerAddress,
      expectedAmountInRaw: fresh.amountInRaw,
      // native-in: the tx value IS the swap amount, exactly; token-in
      // (tahap C): the router pulls the token via the allowance, so the
      // value must be EXACTLY 0 (live-proven, the 0223 build fixture).
      expectedValueRaw: isTokenIn ? 0n : fresh.amountInRaw,
      freshAmountOutRaw: fresh.amountOutRaw,
      chainId: network.chainId,
      // 0227 (0225 K5): the expected id is the NETWORK's own, never a
      // literal — chainId 1 / 8453 / 56 all flow from networks.js.
      expectedChainId: network.chainId
    });
  } catch (err) {
    rethrowEvmCoded(err);
  }

  // Per-network hard caps (0225 K2) — an unknown key throws before any
  // further RPC, same fail-closed rule as requireChainSlug.
  const caps = evmSwapService.getEvmSwapCaps(networkKey);

  // Fee + balance + nonce (read-only RPC), then the ordered checks.
  let maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas, balanceWei, nonce;
  try {
    [{ maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas }, balanceWei, nonce] = await Promise.all([
      evmSwapService.getEvmFeePerGas({ networkKey }),
      evmTransactionService.getEvmBalance({ network: networkKey, address }),
      evmSwapService.getEvmTransactionCount({ networkKey, address }) // pagar (h)
    ]);
  } catch (err) {
    rethrowEvmCoded(err);
  }

  // Pagar (e) — the balance gate 0219 Revisi 1 found missing, FIRST and
  // with its own honest message (the raw node errors for the same
  // condition are endpoint-specific jargon — proven in 0220 fase 1 butir
  // 3). Provisional gas = the build's own figure buffered x1,2.
  const provisionalGasLimit = (build.gasRaw * 12n) / 10n;
  // Token-in pays the swap amount in the TOKEN (checked above), so the
  // native balance only has to cover gas; native-in covers amount + gas.
  const nativeNeededProvisional = (isTokenIn ? 0n : fresh.amountInRaw) + provisionalGasLimit * maxFeePerGas;
  if (balanceWei < nativeNeededProvisional) {
    throw new Error(`EVM_SWAP_INSUFFICIENT_BALANCE: You do not have enough ${nativeSymbol} to cover this swap and its network fee. No funds moved.`);
  }

  // Pagar (f) — pre-sign simulation with the EXACT from/to/value/data the
  // signed transaction would carry; a revert stops everything.
  let estimatedGas;
  try {
    estimatedGas = await evmSwapService.estimateEvmGas({
      networkKey,
      from: address,
      to: build.routerAddress,
      valueRaw: build.transactionValueRaw,
      data: build.calldata
    });
  } catch (err) {
    rethrowEvmCoded(err);
  }
  const gasLimit = ((estimatedGas > build.gasRaw ? estimatedGas : build.gasRaw) * 12n) / 10n;
  if (gasLimit > caps.gasLimitCap) {
    throw new Error('EVM_SWAP_GAS_LIMIT_ABOVE_CAP: This swap needs more gas than this wallet allows. No funds moved.');
  }

  // Pagar (g) — the hard fee ceiling (per-network worst-case table in
  // evmSwapService — 0225 K2), judged on the FRESH market fee.
  if (maxFeePerGas > caps.maxFeePerGasCap) {
    throw new Error('EVM_SWAP_GAS_PRICE_ABOVE_CAP: The network fee is unusually high right now. Try again later. No funds moved.');
  }

  // Pagar (g2), prompt 0220 Revisi 3 — CONSTRUCTIVE since 0227 Revisi 1
  // (owner opsi 1): instead of bouncing whenever fresh gasLimit × fresh
  // maxFeePerGas exceeds the displayed ceiling, the SIGNED maxFeePerGas is
  // cut to min(fresh, floor(ceiling / gasLimit)) — the user never pays
  // above the number they saw (swap lesson 10), and the two real bounce
  // mechanisms fase 1 measured (Kyber's quote gas undershooting the real
  // eth_estimateGas by 22% on Base, and Ethereum's baseFee moving 12% in
  // 20 seconds) no longer bounce every Confirm. Only when the cut value
  // could no longer land in a block (below fresh baseFee + tip — gas that
  // TRULY rose) does the old refusal fire, re-caching the fresh quote
  // under EVM_SWAP_FEE_ABOVE_DISPLAYED so the popup names the FEE.
  // No stored ceiling on NATIVE-in (PREVIEW never answered) keeps the
  // fresh fee. Token-in FAILS CLOSED instead (0231 Revisi 2, owner P1):
  // the popup always previews a token-in Review, so a missing ceiling
  // here means the display chain broke — the 22 Oktober incident signed
  // 5,64x the number the owner saw through exactly this hole. Never sign
  // unbounded; bounce back to Review (the re-render re-previews).
  // Token-in's displayed swap ceiling lives on displayedSwapMaxFeeWei
  // (two-legged PREVIEW, tahap C); native-in keeps displayedMaxFeeWei.
  const displayedSwapCeilWei = isTokenIn ? entry.displayedSwapMaxFeeWei : entry.displayedMaxFeeWei;
  // 0231 Revisi 3 — jejak EXECUTE jalur satu transaksi (native masuk dan
  // token masuk yang melewati approve): satu baris sebelum tanda tangan,
  // tanpa alamat, tanpa jumlah pengguna. Saat insiden, baris ini yang
  // dibaca — bukan storage.
  try {
    console.info('[fluxio swap] execute ' + networkKey + ' quote ' + quoteId +
      ' ceilings reset/approve/swap none/none/' + (displayedSwapCeilWei ?? 'none') +
      ' total ' + (displayedSwapCeilWei ?? 'none'));
  } catch {
    // Logging must never block the flow.
  }
  const signedMaxFeePerGas = isTokenIn && displayedSwapCeilWei == null ? null : evmSwapService.pickSignedMaxFeePerGas({
    freshMaxFeePerGas: maxFeePerGas,
    baseFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    displayedMaxFeeWei: displayedSwapCeilWei
  });
  if (signedMaxFeePerGas == null) {
    const { response } = cacheAndShapeEvmQuote({
      networkKey,
      quote: fresh,
      inputRef: entry.inputRef,
      outputRef: entry.outputRef,
      inputDecimals: entry.inputDecimals,
      outputDecimals: entry.outputDecimals,
      inputSymbol: entry.inputSymbol,
      outputSymbol: entry.outputSymbol,
      slippageBps: entry.slippageBps,
      address
    });
    return { quoteChanged: true, code: 'EVM_SWAP_FEE_ABOVE_DISPLAYED', quote: response };
  }

  // Re-check the balance against the FINAL gas limit and the fee that
  // will actually be signed (no extra RPC).
  if (balanceWei < (isTokenIn ? 0n : fresh.amountInRaw) + gasLimit * signedMaxFeePerGas) {
    throw new Error(`EVM_SWAP_INSUFFICIENT_BALANCE: You do not have enough ${nativeSymbol} to cover this swap and its network fee. No funds moved.`);
  }

  // Pagar (i) — sign through the exact same walletService signer
  // sendEthTransfer has always used, then broadcast. The tip never
  // exceeds the signed max fee (the picker's floor is baseFee + tip).
  const transactionRequest = {
    type: 2,
    chainId: network.chainId,
    nonce,
    to: build.routerAddress,
    value: build.transactionValueRaw,
    data: build.calldata,
    gasLimit,
    maxFeePerGas: signedMaxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas < signedMaxFeePerGas ? maxPriorityFeePerGas : signedMaxFeePerGas
  };
  let signedRawTx;
  try {
    signedRawTx = await walletService.signTransaction(networkKey, transactionRequest);
  } catch (err) {
    throw new Error(`SWAP_SEND_FAILED: ${err?.message || 'Signing the swap failed.'}`);
  }
  let hash;
  try {
    hash = await evmSwapService.sendEvmRawTransaction({ networkKey, signedRawTx });
  } catch (err) {
    throw new Error(`SWAP_SEND_FAILED: ${err?.message || 'Broadcasting the swap failed.'}`);
  }
  const explorerUrl = evmTransactionService.evmExplorerUrl(network, hash);

  // Local Activity record — best-effort, same rule as the Solana path.
  // The recorded floor mirrors what the build actually enforced (token-in
  // uses the K8 re-derived bps; native-in the user's own).
  const minReceivedRaw = (fresh.amountOutRaw * (10000n - BigInt(buildSlippageBps || 0))) / 10000n;
  try {
    await recordLocalTransaction({
      networkKey,
      type: 'swap',
      signatureOrHash: hash,
      inputMint: isTokenIn ? entry.inputRef : 'native',
      inputSymbol: entry.inputSymbol,
      inputAmountRaw: fresh.amountInRaw.toString(),
      inputDecimals: entry.inputDecimals,
      outputMint: entry.outputRef,
      outputSymbol: entry.outputSymbol,
      outputAmountRaw: fresh.amountOutRaw.toString(),
      outputDecimals: entry.outputDecimals,
      otherAmountThresholdRaw: minReceivedRaw.toString(),
      ownerAddress: address, // the real-received parser needs the recipient
      timestamp: Date.now(),
      status: 'pending'
    });
  } catch {
    // Non-fatal — a storage failure must never make a successful broadcast look failed.
  }

  // Re-broadcast loop, EVM form (swap lessons 1 to 3): identical signed
  // bytes every 15s until a receipt exists or the honest-pending window
  // closes — state in chrome.storage.session with the same three wake
  // paths the Solana loop has.
  try {
    await writeActiveSwap({
      kind: 'evm',
      stage: 'swap',
      networkKey,
      signature: hash,
      rawSignedTx: signedRawTx,
      nonce,
      startedAt: Date.now(),
      attempts: 0,
      summary: {
        inputSymbol: entry.inputSymbol,
        outputSymbol: entry.outputSymbol,
        inputAmountRaw: fresh.amountInRaw.toString(),
        inputDecimals: entry.inputDecimals,
        outputAmountRaw: fresh.amountOutRaw.toString(),
        outputDecimals: entry.outputDecimals
      }
    });
    chrome.alarms.create(SWAP_REBROADCAST_ALARM_NAME, { periodInMinutes: 0.5 });
    ensureSwapRebroadcastLoop();
  } catch {
    // Non-fatal — GET_HISTORY's pending resolver still owns the verdict.
  }

  return { signature: hash, hash, explorerUrl };
}

/**
 * Tahap C (prompt 0223) — the APPROVE leg of a token-in swap (owner K1:
 * approve EXACTLY amountIn, no unlimited approve, no reset to zero; the
 * pattern is proven for USDT BEP20 only). Runs its own guards, signs and
 * broadcasts ONLY the approve, writes the staged state (K2) and returns —
 * the swap leg is signed later by continueEvmTokenInSwapAfterApprove once
 * the approve receipt is 0x1, driven by the re-broadcast loop's three
 * existing wake paths (worker init, alarm, popup message).
 */
async function startEvmTokenInApprove({ networkKey, network, address, entry, fresh, quoteId = null, resetFirst = false }) {
  const nativeSymbol = network.nativeCurrency.symbol;
  const caps = evmSwapService.getEvmSwapCaps(networkKey);
  // 0227 (0225 K8): when a PARTIAL allowance is live (0 < allowance <
  // amountIn), the FIRST signed leg is approve(0) — USDT-class tokens
  // revert a non-zero approve over a non-zero allowance (the contract's
  // own reduce-to-zero rule, chain-checked in 0225 fase 2) — and the real
  // approve follows as the continuation with the next LOCAL nonce.
  let approveCalldata;
  try {
    approveCalldata = evmSwapService.buildErc20ApproveCalldata({
      spender: fresh.routerAddress,
      amountRaw: resetFirst ? 0n : fresh.amountInRaw
    });
  } catch (err) {
    rethrowEvmCoded(err);
  }
  let maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas, balanceWei, nonce, approveGas;
  try {
    [{ maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas }, balanceWei, nonce] = await Promise.all([
      evmSwapService.getEvmFeePerGas({ networkKey }),
      evmTransactionService.getEvmBalance({ network: networkKey, address }),
      evmSwapService.getEvmTransactionCount({ networkKey, address })
    ]);
    // Live simulation of the leg itself — an approve (or its reset) has
    // no stale route to fear, but a revert here still stops everything
    // unsigned. The reset case CAN always be simulated (approve(0) never
    // trips the reduce-to-zero rule); approve(amountIn) is only simulated
    // here when no reset is needed.
    approveGas = await evmSwapService.estimateEvmGas({ networkKey, from: address, to: entry.inputRef, valueRaw: 0n, data: approveCalldata });
  } catch (err) {
    rethrowEvmCoded(err);
  }
  const approveGasLimit = (approveGas * 12n) / 10n;
  if (approveGasLimit > caps.gasLimitCap) {
    throw new Error('EVM_SWAP_GAS_LIMIT_ABOVE_CAP: This swap needs more gas than this wallet allows. No funds moved.');
  }
  if (maxFeePerGas > caps.maxFeePerGasCap) {
    throw new Error('EVM_SWAP_GAS_PRICE_ABOVE_CAP: The network fee is unusually high right now. Try again later. No funds moved.');
  }
  // g2 for THIS leg — CONSTRUCTIVE since 0227 Revisi 1 (owner opsi 1, per
  // kaki): the signed maxFeePerGas is cut to the previewed ceiling so the
  // leg never costs above its displayed figure (swap lesson 10); only a
  // cut below the fresh inclusion floor refuses, re-caching under g2's
  // OWN fee code. The reset leg cuts against ITS OWN ceiling (0225 K8).
  const thisLegDisplayedCeilWei = resetFirst ? entry.displayedResetMaxFeeWei : entry.displayedApproveMaxFeeWei;
  // 0231 Revisi 2 (owner P1, fail closed): EVERY leg's displayed ceiling
  // must exist BEFORE the first signature — this leg's own AND the swap
  // leg's (approving first and halting later would burn the approve gas
  // for nothing). A missing ceiling bounces back to Review unsigned; the
  // re-rendered Review re-previews and shows fresh numbers.
  const anyCeilingMissing = thisLegDisplayedCeilWei == null || entry.displayedSwapMaxFeeWei == null || (resetFirst && entry.displayedApproveMaxFeeWei == null);
  // 0231 Revisi 3 — jejak EXECUTE (aturan diagnosis baru): SATU baris per
  // EXECUTE, plafon yang dibawa ke penandatanganan, TANPA alamat dan tanpa
  // jumlah pengguna. Saat insiden, baris ini yang dibaca — bukan storage.
  if (!anyCeilingMissing) {
    try {
      console.info('[fluxio swap] execute ' + networkKey + ' quote ' + (quoteId || 'unknown') +
        ' ceilings reset/approve/swap ' + (entry.displayedResetMaxFeeWei ?? 'none') + '/' + (entry.displayedApproveMaxFeeWei ?? 'none') + '/' + entry.displayedSwapMaxFeeWei +
        ' total ' + (BigInt(entry.displayedResetMaxFeeWei ?? 0) + BigInt(entry.displayedApproveMaxFeeWei ?? 0) + BigInt(entry.displayedSwapMaxFeeWei)).toString());
    } catch {
      // Logging must never block the flow.
    }
  }
  const signedApproveMaxFeePerGas = anyCeilingMissing ? null : evmSwapService.pickSignedMaxFeePerGas({
    freshMaxFeePerGas: maxFeePerGas,
    baseFeePerGas,
    maxPriorityFeePerGas,
    gasLimit: approveGasLimit,
    displayedMaxFeeWei: thisLegDisplayedCeilWei
  });
  if (signedApproveMaxFeePerGas == null) {
    const { response } = cacheAndShapeEvmQuote({
      networkKey,
      quote: fresh,
      inputRef: entry.inputRef,
      outputRef: entry.outputRef,
      inputDecimals: entry.inputDecimals,
      outputDecimals: entry.outputDecimals,
      inputSymbol: entry.inputSymbol,
      outputSymbol: entry.outputSymbol,
      slippageBps: entry.slippageBps,
      address
    });
    return { quoteChanged: true, code: 'EVM_SWAP_FEE_ABOVE_DISPLAYED', quote: response };
  }
  // K3 — the native coin must cover EVERY remaining leg's ceiling before
  // the first signature: this leg's own SIGNED figure, plus (reset case)
  // the real approve's displayed stand-in ceiling, plus the swap's
  // displayed ceiling (or its provisional quote-gas x2 stand-in when
  // PREVIEW never answered).
  // 0231 Revisi 2: the fail-closed gate above guarantees these exist —
  // the old quote-gas stand-ins could silently diverge from what the
  // user saw and are gone.
  const swapCeilWei = BigInt(entry.displayedSwapMaxFeeWei);
  const pendingApproveCeilWei = resetFirst ? BigInt(entry.displayedApproveMaxFeeWei) : 0n;
  if (balanceWei < approveGasLimit * signedApproveMaxFeePerGas + pendingApproveCeilWei + swapCeilWei) {
    throw new Error(`EVM_SWAP_INSUFFICIENT_BALANCE: You do not have enough ${nativeSymbol} to cover the network fees for this swap. No funds moved.`);
  }

  const approveRequest = {
    type: 2,
    chainId: network.chainId,
    nonce,
    to: entry.inputRef,
    value: 0n,
    data: approveCalldata,
    gasLimit: approveGasLimit,
    maxFeePerGas: signedApproveMaxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas < signedApproveMaxFeePerGas ? maxPriorityFeePerGas : signedApproveMaxFeePerGas
  };
  let approveSignedRaw;
  try {
    approveSignedRaw = await walletService.signTransaction(networkKey, approveRequest);
  } catch (err) {
    throw new Error(`SWAP_SEND_FAILED: ${err?.message || 'Signing the approval failed.'}`);
  }
  let approveHash;
  try {
    approveHash = await evmSwapService.sendEvmRawTransaction({ networkKey, signedRawTx: approveSignedRaw });
  } catch (err) {
    throw new Error(`SWAP_SEND_FAILED: ${err?.message || 'Broadcasting the approval failed.'}`);
  }

  // Activity record for THIS leg (0223 Revisi 3, owner K8/C): gas spent
  // on an approve (or its reset) must leave a trace even when the swap
  // leg never happens — a confirmed entry stays CONFIRMED in Activity
  // whatever the later legs' fate. The reset leg records amount 0 with
  // its own approvalKind so the row reads "Reset approval for swap"
  // (0225 K8). Best-effort, like every record write.
  try {
    await recordLocalTransaction({
      networkKey,
      type: 'approval',
      signatureOrHash: approveHash,
      tokenAddress: entry.inputRef,
      tokenSymbol: entry.inputSymbol,
      amountRaw: resetFirst ? '0' : fresh.amountInRaw.toString(),
      tokenDecimals: entry.inputDecimals,
      spender: fresh.routerAddress,
      ownerAddress: address,
      timestamp: Date.now(),
      status: 'pending',
      ...(resetFirst ? { approvalKind: 'reset' } : {})
    });
  } catch {
    // Non-fatal.
  }

  // Staged state (K2) — carries EVERYTHING the continuation needs, since
  // the quoteId is consumed and an MV3 worker can die between the legs.
  // The reset case starts at stage 'approveReset' with the REAL approve's
  // own displayed ceiling riding along; the continuation signs the real
  // approve at nonceReset + 1, then the swap at + 2 (local, never re-read
  // from an endpoint that may lag — K2's own rule).
  try {
    await writeActiveSwap({
      kind: 'evm',
      stage: resetFirst ? 'approveReset' : 'approve',
      networkKey,
      signature: approveHash,
      rawSignedTx: approveSignedRaw,
      ...(resetFirst
        ? { resetHash: approveHash, resetRawSignedTx: approveSignedRaw, nonceReset: nonce, displayedResetMaxFeeWei: entry.displayedResetMaxFeeWei ?? null }
        : { approveHash, approveRawSignedTx: approveSignedRaw, nonceApprove: nonce }),
      startedAt: Date.now(),
      attempts: 0,
      displayedApproveMaxFeeWei: entry.displayedApproveMaxFeeWei ?? null,
      displayedSwapMaxFeeWei: entry.displayedSwapMaxFeeWei ?? null,
      // 0231 Revisi 2 K3 — forensik: halt berikutnya terbaca dari haltDetail
      // tanpa menebak (kapan preview, fee dasar apa, gas limit kaki apa).
      previewForensics: entry.previewForensics ?? null,
      tokenIn: {
        ownerAddress: address,
        inputRef: entry.inputRef,
        outputRef: entry.outputRef,
        inputDecimals: entry.inputDecimals,
        outputDecimals: entry.outputDecimals,
        inputSymbol: entry.inputSymbol,
        outputSymbol: entry.outputSymbol,
        amountInRaw: fresh.amountInRaw.toString(),
        displayedOutAmountRaw: entry.outAmountRaw.toString(),
        // K8 (0223 Revisi 3): the continuation's acceptance floor is the
        // MINIMUM the user saw on Review, not a 0,1% band.
        displayedMinOutRaw: entry.minReceivedRaw.toString(),
        slippageBps: entry.slippageBps,
        // 0227: the reset continuation re-approves THIS router — the same
        // spender the displayed quote's build targets.
        routerAddress: fresh.routerAddress
      },
      summary: {
        inputSymbol: entry.inputSymbol,
        outputSymbol: entry.outputSymbol,
        inputAmountRaw: fresh.amountInRaw.toString(),
        inputDecimals: entry.inputDecimals,
        outputAmountRaw: fresh.amountOutRaw.toString(),
        outputDecimals: entry.outputDecimals
      }
    });
    chrome.alarms.create(SWAP_REBROADCAST_ALARM_NAME, { periodInMinutes: 0.5 });
    ensureSwapRebroadcastLoop();
  } catch {
    // Best-effort — the popup's GET_ACTIVE_SWAP nudge still wakes the loop.
  }

  return {
    stage: resetFirst ? 'approveReset' : 'approve',
    twoStep: !resetFirst,
    threeStep: resetFirst,
    ...(resetFirst ? { resetHash: approveHash } : { approveHash }),
    signature: approveHash,
    hash: approveHash,
    explorerUrl: evmTransactionService.evmExplorerUrl(network, approveHash)
  };
}

/**
 * 0227 continuation for the RESET leg (0225 K8): once approve(0)'s receipt
 * is 0x1 the allowance is zero again, so the REAL approve(amountIn) can
 * finally be simulated and signed — at nonceReset + 1, LOCAL (K2's rule).
 * Runs under the same three owner conditions as the swap continuation
 * (window, open session + identity fence, every guard re-run with g2
 * against the approve's own displayed ceiling). Returns true on a
 * terminal outcome (approve broadcast → stage 'approve', or halted);
 * false retries next tick.
 */
async function continueEvmTokenInApproveAfterReset(state) {
  const t = state.tokenIn || {};
  const networkKey = state.networkKey;
  const network = NETWORKS[networkKey];
  if (Date.now() - state.startedAt > evmSwapService.EVM_SWAP_PENDING_TIMEOUT_MS) {
    return haltEvmStagedSwap(state, 'APPROVE_NOT_SENT', { step: 'window', detail: '10 minute window closed before the approve leg' });
  }
  try {
    await walletService.hydrateSessionIfNeeded();
  } catch {
    // Hydration trouble reads as locked below — honest stop, not a crash.
  }
  if (!walletService.isUnlocked()) {
    return haltEvmStagedSwap(state, 'APPROVE_NOT_SENT', { step: 'locked', detail: 'session locked' });
  }
  let address;
  try {
    const wallet = walletService.getPublicWallet();
    address = walletService.getAccountForNetwork(wallet, networkKey).address;
  } catch {
    return haltEvmStagedSwap(state, 'APPROVE_NOT_SENT', { step: 'identity', detail: 'could not derive the session address' });
  }
  if (!t.ownerAddress || address.toLowerCase() !== t.ownerAddress.toLowerCase()) {
    return haltEvmStagedSwap(state, 'APPROVE_NOT_SENT', { step: 'identity', detail: 'session address differs from the approve owner' });
  }
  let approveCalldata;
  try {
    approveCalldata = evmSwapService.buildErc20ApproveCalldata({ spender: state.routerAddress || t.routerAddress, amountRaw: t.amountInRaw });
  } catch {
    return haltEvmStagedSwap(state, 'APPROVE_NOT_SENT', { step: 'build', detail: 'approve calldata build failed' });
  }
  let maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas, balanceWei, approveGas;
  try {
    [{ maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas }, balanceWei] = await Promise.all([
      evmSwapService.getEvmFeePerGas({ networkKey }),
      evmTransactionService.getEvmBalance({ network: networkKey, address })
    ]);
  } catch {
    return false; // transient RPC trouble — retry next tick
  }
  try {
    // The allowance is zero again, so this simulation finally CAN pass —
    // a node-reported revert is a real verdict and stops honestly.
    approveGas = await evmSwapService.estimateEvmGas({ networkKey, from: address, to: t.inputRef, valueRaw: 0n, data: approveCalldata });
  } catch (err) {
    if (/revert/i.test(String(err?.message || ''))) {
      return haltEvmStagedSwap(state, 'APPROVE_NOT_SENT', { step: 'estimateGas', detail: err?.message || 'revert' });
    }
    return false;
  }
  const caps = evmSwapService.getEvmSwapCaps(networkKey);
  const approveGasLimit = (approveGas * 12n) / 10n;
  if (approveGasLimit > caps.gasLimitCap || maxFeePerGas > caps.maxFeePerGasCap) {
    return haltEvmStagedSwap(state, 'APPROVE_NOT_SENT', { step: 'cap', detail: 'gas or fee above the network cap' });
  }
  // g2 against the approve leg's OWN displayed ceiling — CONSTRUCTIVE
  // since 0227 Revisi 1 (owner opsi 1): the signed fee is cut to the
  // stand-in PREVIEW showed; only a cut below the fresh inclusion floor
  // halts, under the FEE reason (never a misleading quote-changed one).
  // 0231 Revisi 2 (owner P1, fail closed): same rule as the swap leg — a
  // missing ceiling never signs.
  if (state.displayedApproveMaxFeeWei == null) {
    return haltEvmStagedSwap(state, 'EVM_SWAP_FEE_ABOVE_DISPLAYED', { step: 'ceiling', detail: 'ceiling missing' });
  }
  const signedApproveMaxFeePerGas = evmSwapService.pickSignedMaxFeePerGas({
    freshMaxFeePerGas: maxFeePerGas,
    baseFeePerGas,
    maxPriorityFeePerGas,
    gasLimit: approveGasLimit,
    displayedMaxFeeWei: state.displayedApproveMaxFeeWei
  });
  if (signedApproveMaxFeePerGas == null) {
    return haltEvmStagedSwap(state, 'EVM_SWAP_FEE_ABOVE_DISPLAYED', { step: 'ceiling', detail: 'cut fee below the inclusion floor' });
  }
  const swapCeilWei = state.displayedSwapMaxFeeWei != null ? BigInt(state.displayedSwapMaxFeeWei) : 0n;
  if (balanceWei < approveGasLimit * signedApproveMaxFeePerGas + swapCeilWei) {
    return haltEvmStagedSwap(state, 'APPROVE_NOT_SENT', { step: 'balance', detail: 'native balance below the remaining ceilings' });
  }
  const nonce = Number(state.nonceReset) + 1;
  const approveRequest = {
    type: 2,
    chainId: network.chainId,
    nonce,
    to: t.inputRef,
    value: 0n,
    data: approveCalldata,
    gasLimit: approveGasLimit,
    maxFeePerGas: signedApproveMaxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas < signedApproveMaxFeePerGas ? maxPriorityFeePerGas : signedApproveMaxFeePerGas
  };
  let approveSignedRaw;
  try {
    approveSignedRaw = await walletService.signTransaction(networkKey, approveRequest);
  } catch {
    return haltEvmStagedSwap(state, 'APPROVE_NOT_SENT', { step: 'sign', detail: 'signing the approve failed' });
  }
  let approveHash;
  try {
    approveHash = await evmSwapService.sendEvmRawTransaction({ networkKey, signedRawTx: approveSignedRaw });
  } catch {
    return haltEvmStagedSwap(state, 'APPROVE_NOT_SENT', { step: 'broadcast', detail: 'every endpoint rejected the approve' });
  }
  try {
    await recordLocalTransaction({
      networkKey,
      type: 'approval',
      signatureOrHash: approveHash,
      tokenAddress: t.inputRef,
      tokenSymbol: t.inputSymbol,
      amountRaw: t.amountInRaw.toString(),
      tokenDecimals: t.inputDecimals,
      spender: state.routerAddress || t.routerAddress || null,
      ownerAddress: address,
      timestamp: Date.now(),
      status: 'pending'
    });
  } catch {
    // Non-fatal.
  }
  try {
    await writeActiveSwap({
      ...state,
      stage: 'approve',
      signature: approveHash,
      rawSignedTx: approveSignedRaw,
      approveHash,
      approveRawSignedTx: approveSignedRaw,
      nonceApprove: nonce,
      attempts: 0
    });
  } catch {
    // Best-effort — the broadcast already happened; the loop's next read
    // of the state drives the rest.
  }
  return true;
}

/**
 * Terminal staged-swap stop (tahap C): the state flips to 'halted' with a
 * reason the popup maps to its own honest sentence, the alarm is cleared,
 * and nothing is ever signed past this point. The record itself stays
 * readable (GET_ACTIVE_SWAP) until its own window expires or a new swap
 * overwrites it.
 */
async function haltEvmStagedSwap(state, haltReason, haltDetail = null) {
  // 0228 Revisi 1 K2 — forensic trace: every halt records WHICH step
  // stopped it and a SANITIZED message (trimmed to 200 chars, any long
  // hex blob collapsed so calldata/signed bytes can never leak), plus one
  // fixed-format console line. The popup never displays this — user text
  // stays the existing honest sentences; this exists so a halt is never
  // invisible again (the 0228 incident: SWAP_NOT_SENT with no trace).
  let detail = null;
  if (haltDetail) {
    const raw = String(haltDetail.detail ?? '');
    detail = {
      step: String(haltDetail.step || 'unknown'),
      detail: raw.replace(/0x[0-9a-fA-F]{67,}/g, '0x…').slice(0, 200),
      // 0231 (catatan 20): how many stale allowance rereads preceded this
      // halt, when any did — forensics only, the popup never shows it.
      ...(state && state.staleAllowanceRetries > 0 ? { staleAllowanceRetries: state.staleAllowanceRetries } : {}),
      // 0231 Revisi 2 K3: when the state carries the preview forensics
      // (token-in), every halt names them — no more guessing what the
      // Review number was built from.
      ...(state && state.previewForensics ? { preview: state.previewForensics } : {})
    };
  }
  try {
    console.warn(`[fluxio swap] halt ${haltReason} at ${detail ? detail.step : 'unknown'}: ${detail ? detail.detail : ''}`);
  } catch {
    // Logging must never block the halt.
  }
  try {
    await writeActiveSwap({ ...state, stage: 'halted', haltReason, haltDetail: detail, haltedAt: Date.now() });
  } catch {
    // Best-effort.
  }
  try {
    await chrome.alarms.clear(SWAP_REBROADCAST_ALARM_NAME);
  } catch {
    // Best-effort.
  }
  return true;
}

/**
 * Tahap C continuation (owner K2): signs the SWAP leg once the approve
 * receipt is 0x1 — the one signature this wallet ever produces without a
 * click of its own, allowed ONLY under the owner's three conditions:
 * (i) still inside the 10 minute window from Confirm (startedAt),
 * (ii) the session is still open — locked stops honestly, nothing signed,
 * (iii) every guard re-runs, g2 included, against the STORED swap ceiling.
 * Returns true when the continuation reached a terminal outcome (swap
 * broadcast, or halted); false means transient trouble — the loop retries
 * on its next tick until the window closes.
 */
async function continueEvmTokenInSwapAfterApprove(state, approveReceipt = null) {
  const t = state.tokenIn || {};
  const networkKey = state.networkKey;
  const network = NETWORKS[networkKey];
  // (i) the 10 minute window.
  if (Date.now() - state.startedAt > evmSwapService.EVM_SWAP_PENDING_TIMEOUT_MS) {
    return haltEvmStagedSwap(state, 'SWAP_NOT_SENT', { step: 'window', detail: '10 minute window closed before the swap leg' });
  }
  // (ii) session open + identity fence: the session's own derivation must
  // still be the address that signed the approve. A restarted worker's
  // MEMORY is empty even while chrome.storage.session still holds the
  // unlocked seed (the MV3 split walletService.js's header documents) —
  // so hydrate FIRST, then judge; otherwise every continuation after a
  // worker restart would wrongly halt as locked.
  try {
    await walletService.hydrateSessionIfNeeded();
  } catch {
    // Hydration trouble reads as locked below — honest stop, not a crash.
  }
  if (!walletService.isUnlocked()) {
    return haltEvmStagedSwap(state, 'SWAP_NOT_SENT', { step: 'locked', detail: 'session locked' });
  }
  let address;
  try {
    const wallet = walletService.getPublicWallet();
    address = walletService.getAccountForNetwork(wallet, networkKey).address;
  } catch {
    return haltEvmStagedSwap(state, 'SWAP_NOT_SENT', { step: 'identity', detail: 'could not derive the session address' });
  }
  if (!t.ownerAddress || address.toLowerCase() !== t.ownerAddress.toLowerCase()) {
    return haltEvmStagedSwap(state, 'SWAP_NOT_SENT', { step: 'identity', detail: 'session address differs from the approve owner' });
  }
  // (iii) K2's own post-approve re-quote, 0,1% against what Review showed.
  // A transient quote failure retries next tick; a real drop halts.
  let fresh;
  try {
    fresh = await evmSwapService.getEvmSwapQuote({
      networkKey,
      tokenIn: t.inputRef,
      tokenOut: evmSwapService.NATIVE_EVM_SENTINEL,
      amountInRaw: t.amountInRaw
    });
  } catch {
    return false;
  }
  // K8 (0223 Revisi 3, owner keputusan): the post-approve wait makes the
  // old 0,1% band structurally too tight (requote drift measured at
  // 0,139% in 1,5s — gejala A's real cause, with the g2 ceiling). The
  // fresh quote is accepted when its output still covers the MINIMUM the
  // user saw on Review; the build below then re-derives its slippage so
  // the on-chain floor never drops under that displayed minimum.
  const displayedMinOutRaw = t.displayedMinOutRaw != null
    ? BigInt(t.displayedMinOutRaw)
    : (BigInt(t.displayedOutAmountRaw) * (10000n - BigInt(t.slippageBps || 0))) / 10000n;
  if (fresh.amountOutRaw < displayedMinOutRaw) {
    return haltEvmStagedSwap(state, 'SWAP_QUOTE_CHANGED_AFTER_APPROVE', { step: 'minOut', detail: 'fresh output below the displayed minimum' });
  }
  try {
    evmSwapService.verifyEvmFeeEcho(fresh.routeSummary?.extraFee);
  } catch {
    return haltEvmStagedSwap(state, 'SWAP_QUOTE_CHANGED_AFTER_APPROVE', { step: 'feeEcho', detail: 'fee echo mismatch on the fresh quote' });
  }
  // Sanity guard, same skip-on-missing shape as EXECUTE's own.
  try {
    const cached = await getCachedPrices();
    if (cached && Date.now() - (cached.fetchedAt || 0) <= evmSwapService.EVM_SWAP_SANITY_PRICE_MAX_AGE_MS) {
      // 0227 (0225 K4): the native output side resolves through the
      // per-network map, no longer a 'binancecoin' literal.
      const inCoinId = resolveTokenCoinId({ networkKey, address: t.inputRef });
      const inputUsdPrice = inCoinId ? cached.pricesByCoinId?.[inCoinId]?.usd : undefined;
      const outputUsdPrice = cached.pricesByCoinId?.[evmSwapService.EVM_SWAP_NATIVE_COIN_IDS[networkKey]]?.usd;
      const deviation = evmSwapService.computeQuoteUsdDeviation({
        amountInRaw: fresh.amountInRaw,
        inputDecimals: t.inputDecimals,
        inputUsdPrice,
        amountOutRaw: fresh.amountOutRaw,
        outputDecimals: t.outputDecimals,
        outputUsdPrice
      });
      if (deviation != null && deviation > evmSwapService.EVM_SWAP_SANITY_MAX_DEVIATION) {
        return haltEvmStagedSwap(state, 'SWAP_QUOTE_CHANGED_AFTER_APPROVE', { step: 'sanity', detail: 'quote USD legs deviate beyond the guard' });
      }
    }
  } catch {
    // Cache hiccup — skip, never block.
  }
  // Build from the fresh routeSummary; token-in means value EXACTLY 0.
  // K8: slippage re-derived from the displayed minimum —
  // min(user bps, floor((fresh − displayedMin) × 10000 / fresh)).
  const continuationSlippageBps = Number(
    BigInt(t.slippageBps || 0) < ((fresh.amountOutRaw - displayedMinOutRaw) * 10000n) / fresh.amountOutRaw
      ? BigInt(t.slippageBps || 0)
      : ((fresh.amountOutRaw - displayedMinOutRaw) * 10000n) / fresh.amountOutRaw
  );
  let build;
  try {
    build = await evmSwapService.buildEvmSwapTransaction({
      networkKey,
      routeSummary: fresh.routeSummary,
      sender: address,
      recipient: address,
      slippageBps: continuationSlippageBps
    });
    evmSwapService.verifyEvmSwapBuild({
      build,
      expectedRouterAddress: fresh.routerAddress,
      expectedAmountInRaw: fresh.amountInRaw,
      expectedValueRaw: 0n,
      freshAmountOutRaw: fresh.amountOutRaw,
      chainId: network.chainId,
      // 0227 (0225 K5): the network's own id, never a literal.
      expectedChainId: network.chainId
    });
  } catch (err) {
    if (err && err.name === 'EvmSwapValidationError' && err.code === 'EVM_SWAP_BUILD_MISMATCH') {
      return haltEvmStagedSwap(state, 'SWAP_QUOTE_CHANGED_AFTER_APPROVE', { step: 'build', detail: err?.message || 'build mismatch' });
    }
    // 0223 Revisi 1 (owner keputusan 2): Kyber ANSWERING with a non-zero
    // code is a real refusal, not transport trouble — the build error
    // message carries "(code N)" exactly then (an HTTP failure carries
    // "(HTTP N)" instead, and timeouts/unreachable their own words).
    // A refusal halts NOW; only genuine transport trouble retries.
    if (String(err?.message || '').includes('(code ')) {
      return haltEvmStagedSwap(state, 'SWAP_NOT_SENT', { step: 'build', detail: err?.message || 'build refused' });
    }
    return false; // transport-class build trouble — retry next tick
  }
  let maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas, balanceWei, estimatedGas;
  try {
    [{ maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas }, balanceWei] = await Promise.all([
      evmSwapService.getEvmFeePerGas({ networkKey }),
      evmTransactionService.getEvmBalance({ network: networkKey, address })
    ]);
  } catch {
    return false; // transient RPC trouble — retry next tick until the window closes
  }
  try {
    // The allowance is live now, so the swap simulation finally CAN run —
    // exactly why K2 puts it after the approve receipt.
    estimatedGas = await evmSwapService.estimateEvmGas({
      networkKey,
      from: address,
      to: build.routerAddress,
      valueRaw: 0n,
      data: build.calldata
    });
  } catch (err) {
    // 0223 Revisi 1 (owner keputusan 2): a node-reported REVERT is a real
    // verdict — EXCEPT right after an approve (0228 Revisi 1, the real
    // Base incident): a load-balanced RPC replica that has not applied
    // the approve yet simulates transferFrom with allowance 0 and reverts
    // SPURIOUSLY, even though the approve receipt 0x1 is already in hand.
    // So a revert here first re-reads the LIVE allowance: still below
    // amountIn means the state simply has not propagated — retry next
    // tick (bounded by the shared 10 minute window); at or above amountIn
    // means the state arrived and the revert is REAL — halt as before.
    // Everything else (fetch failure, timeout, empty response) retries.
    if (/revert/i.test(String(err?.message || ''))) {
      let freshAllowance = null;
      try {
        freshAllowance = await evmSwapService.getErc20Allowance({
          networkKey,
          tokenAddress: t.inputRef,
          owner: address,
          spender: build.routerAddress
        });
      } catch {
        return false; // allowance read itself failed — transient, retry
      }
      if (freshAllowance < BigInt(t.amountInRaw)) {
        // 0231 (catatan 20): leave a durable trace of every stale reread —
        // persisted so it survives a worker restart, carried into
        // haltDetail on a halt, and summarized by ONE console.info when
        // the continuation finally succeeds. No UI text, nothing sensitive.
        state.staleAllowanceRetries = (state.staleAllowanceRetries || 0) + 1;
        try {
          // Merge ONLY the counter into the freshest stored record — never
          // write the whole in memory copy back, which would clobber any
          // field persisted since this tick began (startedAt among them).
          const stored = await readActiveSwap();
          if (stored) {
            await writeActiveSwap({ ...stored, staleAllowanceRetries: state.staleAllowanceRetries });
          }
        } catch {
          // Best-effort; the retry itself must never be blocked by storage.
        }
        return false; // approve not propagated yet — retry next tick
      }
      return haltEvmStagedSwap(state, 'SWAP_NOT_SENT', { step: 'estimateGas', detail: err?.message || 'revert' });
    }
    return false;
  }
  const gasLimit = ((estimatedGas > build.gasRaw ? estimatedGas : build.gasRaw) * 12n) / 10n;
  // Per-network caps (0225 K2).
  const caps = evmSwapService.getEvmSwapCaps(networkKey);
  if (gasLimit > caps.gasLimitCap) {
    return haltEvmStagedSwap(state, 'SWAP_NOT_SENT', { step: 'cap', detail: 'gas limit above the network cap' });
  }
  if (maxFeePerGas > caps.maxFeePerGasCap) {
    return haltEvmStagedSwap(state, 'SWAP_NOT_SENT', { step: 'cap', detail: 'network fee above the network cap' });
  }
  // g2 against the STORED swap ceiling (condition iii, swap lesson 10) —
  // CONSTRUCTIVE since 0227 Revisi 1 (owner opsi 1): the signed fee is
  // cut to the ceiling; only a cut below the fresh inclusion floor halts,
  // under the FEE reason (never a misleading quote-changed one).
  // 0231 Revisi 2 (owner P1, fail closed): a missing ceiling here means
  // the display chain broke mid flight — never sign unbounded.
  if (state.displayedSwapMaxFeeWei == null) {
    return haltEvmStagedSwap(state, 'EVM_SWAP_FEE_ABOVE_DISPLAYED', { step: 'ceiling', detail: 'ceiling missing' });
  }
  const signedMaxFeePerGas = evmSwapService.pickSignedMaxFeePerGas({
    freshMaxFeePerGas: maxFeePerGas,
    baseFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    displayedMaxFeeWei: state.displayedSwapMaxFeeWei
  });
  if (signedMaxFeePerGas == null) {
    return haltEvmStagedSwap(state, 'EVM_SWAP_FEE_ABOVE_DISPLAYED', { step: 'ceiling', detail: 'cut fee below the inclusion floor' });
  }
  if (balanceWei < gasLimit * signedMaxFeePerGas) {
    return haltEvmStagedSwap(state, 'SWAP_NOT_SENT', { step: 'balance', detail: 'native balance below the swap fee' });
  }
  // K2: the swap's nonce is the approve's own + 1, computed LOCALLY —
  // never re-read from an endpoint that may not have seen the approve yet.
  const nonce = Number(state.nonceApprove) + 1;
  const transactionRequest = {
    type: 2,
    chainId: network.chainId,
    nonce,
    to: build.routerAddress,
    value: 0n,
    data: build.calldata,
    gasLimit,
    maxFeePerGas: signedMaxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas < signedMaxFeePerGas ? maxPriorityFeePerGas : signedMaxFeePerGas
  };
  let signedRawTx;
  try {
    signedRawTx = await walletService.signTransaction(networkKey, transactionRequest);
  } catch {
    return haltEvmStagedSwap(state, 'SWAP_NOT_SENT', { step: 'sign', detail: 'signing the swap failed' });
  }
  let hash;
  try {
    hash = await evmSwapService.sendEvmRawTransaction({ networkKey, signedRawTx });
  } catch {
    // Every endpoint rejected the signed bytes — nothing is on chain.
    // Honest stop; the allowance stays, so a retry skips the approve.
    return haltEvmStagedSwap(state, 'SWAP_NOT_SENT', { step: 'broadcast', detail: 'every endpoint rejected the swap' });
  }
  // Mirrors the floor the build actually enforced (K8 re-derived bps).
  const minReceivedRaw = (fresh.amountOutRaw * (10000n - BigInt(continuationSlippageBps || 0))) / 10000n;
  try {
    await recordLocalTransaction({
      networkKey,
      type: 'swap',
      signatureOrHash: hash,
      inputMint: t.inputRef,
      inputSymbol: t.inputSymbol,
      inputAmountRaw: fresh.amountInRaw.toString(),
      inputDecimals: t.inputDecimals,
      outputMint: 'native',
      outputSymbol: t.outputSymbol,
      outputAmountRaw: fresh.amountOutRaw.toString(),
      outputDecimals: t.outputDecimals,
      otherAmountThresholdRaw: minReceivedRaw.toString(),
      ownerAddress: address,
      timestamp: Date.now(),
      status: 'pending',
      // 0223 Revisi 1: the approve receipt's own block/gas figures ride on
      // the entry so K4 can add the approve gas back when both legs land
      // in the SAME block (otherwise the delta would undercount into est.).
      ...(approveReceipt && approveReceipt.blockNumber != null
        ? {
            approveBlockNumber: approveReceipt.blockNumber,
            approveGasUsed: approveReceipt.gasUsed,
            approveEffectiveGasPrice: approveReceipt.effectiveGasPrice
          }
        : {})
    });
  } catch {
    // Non-fatal, same rule as every broadcast path.
  }
  try {
    await writeActiveSwap({
      ...state,
      stage: 'swap',
      signature: hash,
      rawSignedTx: signedRawTx,
      swapHash: hash,
      swapRawSignedTx: signedRawTx,
      attempts: 0,
      explorerUrl: evmTransactionService.evmExplorerUrl(network, hash),
      summary: { ...state.summary, outputAmountRaw: fresh.amountOutRaw.toString() }
    });
  } catch {
    // Best-effort — the broadcast already happened; GET_HISTORY's
    // resolver still owns the verdict.
  }
  // 0231 (catatan 20): the success path used to leave no trace at all —
  // one info line, only when stale rereads actually happened.
  if (state.staleAllowanceRetries > 0) {
    try {
      console.info(`[fluxio swap] continuation succeeded after ${state.staleAllowanceRetries} allowance rereads`);
    } catch {
      // Logging must never block the success path.
    }
  }
  return true;
}

/**
 * Test-only injection seam for SWAP_FEE_ACCOUNTS (read ONCE at module
 * init): the e2e bundle tests already own this worker's entire globalThis
 * (they install the chrome.* mock the same way), and swapService's real
 * map is a frozen source constant that a bundle test cannot reach into.
 * A real service worker's globalThis is extension-private — nothing on a
 * webpage can set this — and in production it is simply undefined.
 */
const SWAP_FEE_ACCOUNTS_OVERRIDE = globalThis.__FLUXIO_TEST_SWAP_FEE_ACCOUNTS__ || null;

/**
 * Swap fee-account guard (prompt 0209; owner decisions 1, 2 and 4, born
 * from the 0208 incident where the embedded treasury USDC ATA was closed
 * while a build carrying its address sat in review — swap lesson #8).
 * Before a fee-carrying pair quotes (first open) and executes, the
 * embedded fee account is verified on chain to be a REAL token account
 * with the exact expected mint and owner (transactionService.
 * verifyTokenAccount — existence alone is not enough; a plain lamport
 * transfer to the closed ATA's address would leave a System account
 * there that can never receive a token fee).
 *
 * Cache: per worker lifetime, VALID results only, 60s TTL — so the
 * popup's 15s quote refresh costs zero extra RPC while the account is
 * healthy, and a dead worker simply re-checks once on wake. An INVALID
 * or UNVERIFIED result is NEVER cached: recovery of the ATA (a
 * deterministic re-create at the same address) must be felt on the very
 * next refresh, and a blocked pair re-checking 4x/minute is the rare
 * emergency case, worth watching fresh.
 *
 * RPC failure = 'unverified' (owner decision 2, opsi ii): the swap
 * PROCEEDS and the feeAccount is still sent to Jupiter, which rejects a
 * fee build against a missing account (live-proven 400, 0199) — the fee
 * is never silently skipped either way; only who rejects first changes.
 * Non-fee pairs never reach this function at all (zero extra RPC).
 */
const SWAP_FEE_ACCOUNT_VALID_TTL_MS = 60_000;
const swapFeeAccountValidCache = new Map(); // feeAccount address -> verifiedAt (epoch ms)

async function checkSwapFeeAccount(feeInfo, { bypassCache = false } = {}) {
  const cachedAt = swapFeeAccountValidCache.get(feeInfo.feeAccount);
  if (!bypassCache && cachedAt != null && Date.now() - cachedAt < SWAP_FEE_ACCOUNT_VALID_TTL_MS) {
    return 'valid';
  }
  let verdict;
  try {
    verdict = await transactionService.verifyTokenAccount({
      network: 'solana',
      address: feeInfo.feeAccount,
      expectedMint: feeInfo.feeMint,
      expectedOwner: swapService.SWAP_FEE_ACCOUNT_OWNER
    });
  } catch {
    return 'unverified';
  }
  if (verdict.status === 'valid') {
    swapFeeAccountValidCache.set(feeInfo.feeAccount, Date.now());
    return 'valid';
  }
  return verdict.status; // 'invalid' | 'unverified' — deliberately uncached
}

/**
 * Auto-lock timer (prompt 0117, revised in a follow-up prompt after real
 * Chrome verification) — locks the wallet (walletService.lock())
 * automatically after a configurable period of inactivity.
 *
 * TIMER MECHANISM: chrome.alarms, never setTimeout/setInterval. An MV3
 * service worker can be torn down and go idle at any time (independent of
 * whether any *our* JS timer thinks it should still be running) — a plain
 * setTimeout scheduled for "15 minutes from now" is simply gone if the
 * worker is torn down before it fires, silently defeating the whole
 * feature. chrome.alarms are tracked by Chrome itself, outside the
 * worker's own lifecycle, and Chrome wakes the worker specifically to
 * deliver a due alarm — this is the ONLY reliable way to run something on
 * a schedule from an MV3 service worker, which is exactly why the
 * `"alarms"` permission was added to manifest.json for this feature (and
 * nothing else was — no new host permission, no broader access).
 *
 * ACTIVITY TRACKING — REVISED: `lastActivityAt` used to be a plain
 * in-memory module variable here, reasoned (in prompt 0117's own original
 * comment, now corrected) to be safe because "the worker restarting
 * already wipes walletService's in-memory session, so the wallet is
 * already effectively locked by then anyway." Real manual verification in
 * Chrome (two live experiments, see prompt/0117-auto-lock-timer.md's own
 * Revision note) proved that reasoning WRONG in practice: this extension
 * does not control, and cannot reliably predict, when the service worker
 * is actually torn down. Concretely: (1) the "Never" setting's own
 * intentional lack of a periodic alarm meant nothing was keeping the
 * worker alive, so ordinary MV3 idle-teardown killed it well before any
 * real "Never" semantics should have applied — the wallet locked anyway,
 * just via worker death, not because auto-lock ever decided to; (2) the
 * 5/15/30/60-minute settings' own per-minute alarm was, by accident,
 * keeping the worker continuously alive, so those durations' correctness
 * was never actually exercised against a real worker restart at all.
 * Net conclusion: "in-memory dies with the worker, and that's fine" was
 * never a safe foundation — this extension's actual unlocked-duration
 * guarantee needs to hold regardless of worker lifetime.
 *
 * Both `lastActivityAt` and walletService's own unlocked session now live
 * in `chrome.storage.session` (Chrome's memory-only, worker-restart-
 * survivING, browser-close-cleared storage area — see
 * packages/services/walletService.js's own header comment for the full
 * architecture and security reasoning). This file no longer holds
 * `lastActivityAt` itself at all — every read goes through
 * `walletService.getLastActivityAt()`, every write through
 * `walletService.recordActivity()`, so there is exactly one place
 * (walletService.js) that owns how/where it's persisted.
 *
 * The auto-lock DURATION SETTING itself (the user's 5/15/30/60/Never
 * choice) is unaffected by this revision — a genuine user preference that
 * must survive a full browser restart (not just a worker restart), so it
 * stays in chrome.storage.local (AUTO_LOCK_STORAGE_KEY), same tier as
 * every other durable user preference in this file (custom tokens, tx
 * history, developer-networks toggle). shared/autoLockDecision.js's own
 * shouldAutoLock() ALSO needs no change: its pure `{now, lastActivityAt,
 * durationMinutes}` signature was already agnostic to where
 * `lastActivityAt` physically comes from — only the caller's plumbing
 * changed, not the decision logic itself.
 */
const AUTO_LOCK_STORAGE_KEY = 'fluxio_auto_lock_minutes';
const AUTO_LOCK_ALARM_NAME = 'fluxio-auto-lock-check';
// chrome.alarms' own documented minimum granularity for periodInMinutes
// is 1 minute — this is the finest-grained periodic check available, so
// the auto-lock duration is honored to within +0-1 minute of the
// configured value (e.g. a 5-minute setting locks somewhere between 5:00
// and 5:59 after the last activity), never earlier. That slack is
// accepted as normal/expected precision for this kind of feature, not a
// bug — every wallet's auto-lock has SOME polling granularity.
const AUTO_LOCK_CHECK_PERIOD_MINUTES = 1;

/** Reads the persisted auto-lock duration, sanitized against AUTO_LOCK_OPTIONS_MINUTES (falls back to AUTO_LOCK_DEFAULT_MINUTES for anything unrecognized/corrupt — an unset value on first-ever run reads the same way, landing on this feature's own specified default). */
function getAutoLockMinutes() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AUTO_LOCK_STORAGE_KEY], (result) => {
      const stored = result?.[AUTO_LOCK_STORAGE_KEY];
      resolve(AUTO_LOCK_OPTIONS_MINUTES.includes(stored) ? stored : AUTO_LOCK_DEFAULT_MINUTES);
    });
  });
}

function setAutoLockMinutes(minutes) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [AUTO_LOCK_STORAGE_KEY]: minutes }, () => resolve());
  });
}

/**
 * (Re)programs the periodic check alarm from the CURRENTLY persisted
 * setting — called once at module load (covers every service-worker
 * (re)start, including after a browser restart, with no separate
 * onInstalled/onStartup listener needed: this file's own top-level code
 * already re-runs every time the worker initializes) and again whenever
 * FLUXIO_INTERNAL_SET_AUTO_LOCK changes the setting, so a change takes
 * effect immediately rather than waiting for the next natural restart.
 *
 * "Never" clears any existing alarm outright rather than leaving a
 * periodic alarm running that would just no-op every time it fires — the
 * cleaner of the two designs raised in this feature's own spec: no
 * alarm means no unnecessary once-a-minute service-worker wake-ups at
 * all while the feature is disabled, instead of waking up every minute
 * just to immediately decide there's nothing to do.
 */
async function reprogramAutoLockAlarm() {
  const minutes = await getAutoLockMinutes();
  if (minutes === AUTO_LOCK_NEVER) {
    await chrome.alarms.clear(AUTO_LOCK_ALARM_NAME);
    return;
  }
  await chrome.alarms.create(AUTO_LOCK_ALARM_NAME, { periodInMinutes: AUTO_LOCK_CHECK_PERIOD_MINUTES });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM_NAME) return;
  // Hydrate FIRST — this alarm firing may be the very first event this
  // worker instance has seen since a restart, and both isUnlocked() and
  // getLastActivityAt() below need the storage-backed session/timestamp
  // pulled into the fast in-memory cache (or read fresh, for
  // lastActivityAt) before they can answer correctly. See
  // walletService.js's own hydrateSessionIfNeeded() comment.
  await walletService.hydrateSessionIfNeeded();
  if (!walletService.isUnlocked()) return; // nothing to lock
  const [minutes, lastActivityAt] = await Promise.all([
    getAutoLockMinutes(),
    walletService.getLastActivityAt()
  ]);
  if (shouldAutoLock({ now: Date.now(), lastActivityAt, durationMinutes: minutes })) {
    await walletService.lock();
  }
});

// Runs once per service-worker initialization — including the very first
// install, every subsequent restart, and a browser relaunch — so the
// alarm always reflects the persisted setting without a separate
// chrome.runtime.onInstalled/onStartup listener.
reprogramAutoLockAlarm();

/**
 * Notifications inbox (prompt 0170) — a small, read-only feed of admin-
 * published announcements (`GET /api/announcements`, see backend/src/
 * controllers/publicAnnouncementsController.js), surfaced as a header
 * bell icon with an unread dot/badge and a "Notifications" screen.
 *
 * INVESTIGATION NOTE, corrected from this prompt's own KONTEKS: the
 * prompt's premise was "the extension already calls the backend for a
 * WALLET_CREATED analytics beacon, reuse that same base-URL mechanism."
 * Checked directly rather than assumed — apps/web/src/features/legal/
 * Privacy.jsx says so explicitly, itself already the product of an
 * earlier prompt's own direct code check: "We checked the extension's
 * own code directly to confirm this rather than assume it — there is
 * currently no analytics or usage-tracking call anywhere in the
 * extension." No such beacon, and no such base-URL mechanism, exists
 * anywhere in apps/extension. This feature is therefore the first thing
 * in this extension that ever calls this backend at all, and the
 * base-URL mechanism below (build.mjs's own FLUXIO_BACKEND_BASE_URL
 * define, mirroring the existing HELIUS_API_KEY pattern one section
 * above) is new, not reused.
 *
 * TIMER MECHANISM: chrome.alarms, same reasoning as the auto-lock timer
 * above (an MV3 service worker's own setTimeout/setInterval doesn't
 * survive a worker teardown; chrome.alarms does) — no new permission
 * needed, "alarms" is already granted (added for auto-lock, prompt 0117).
 *
 * FETCH TRIGGERS (both described in this feature's own spec): (1) the
 * periodic alarm below, unconditionally, every
 * NOTIFICATIONS_POLL_PERIOD_MINUTES; (2) every popup open, but THROTTLED
 * to at most once per NOTIFICATIONS_OPEN_THROTTLE_MS since the last fetch
 * ATTEMPT (success or failure — see fetchAndMergeNotifications()'s own
 * comment on why an attempt, not just a success, resets the throttle
 * clock). Popup-open's own trigger is fire-and-forget from popup.js's
 * perspective (FLUXIO_INTERNAL_GET_NOTIFICATIONS below both triggers a
 * throttle-gated fetch AND returns the current — possibly just-updated —
 * cached state in one round trip, so the popup never needs a second
 * message just to learn whether the first one changed anything).
 *
 * NETWORK FAILURE IS ALWAYS SILENT to the user — this feature's own
 * explicit requirement ("Gagal jaringan = diam, cache tetap dipakai"):
 * fetchAndMergeNotifications() never throws past its own try/catch, and
 * every internal message handler that calls it returns the (possibly
 * stale, possibly just-updated) cached state either way. A dead/
 * unreachable backend is expected, ordinary, and explicitly designed
 * for — not just tolerated — since this is a wallet, not a service that
 * requires connectivity to keep functioning.
 */
const NOTIFICATIONS_ALARM_NAME = 'fluxio-notifications-poll';
// Prompt 0170 Revision 1 (user decision): 30 -> 10 minutes.
const NOTIFICATIONS_POLL_PERIOD_MINUTES = 10;
// Prompt 0170 Revision 1 (user decision): 5 -> 1 minute.
const NOTIFICATIONS_OPEN_THROTTLE_MS = 1 * 60 * 1000;
const NOTIFICATIONS_PLATFORM = 'extension';

/** @returns {Promise<{announcements: Array, readIds: Array<string>, lastFetchedAt: number|null}>} */
function getNotificationsState() {
  return new Promise((resolve) => {
    chrome.storage.local.get([NOTIFICATIONS_STATE_STORAGE_KEY], (result) => {
      const stored = result?.[NOTIFICATIONS_STATE_STORAGE_KEY];
      resolve({
        announcements: Array.isArray(stored?.announcements) ? stored.announcements : [],
        readIds: Array.isArray(stored?.readIds) ? stored.readIds : [],
        lastFetchedAt: typeof stored?.lastFetchedAt === 'number' ? stored.lastFetchedAt : null
      });
    });
  });
}

function setNotificationsState(state) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [NOTIFICATIONS_STATE_STORAGE_KEY]: state }, () => resolve());
  });
}

/**
 * Recomputes and applies the toolbar badge from a given state — called
 * after every fetch attempt AND after marking notifications read, so the
 * badge never drifts from what the inbox itself would show. Badge color
 * follows the theme accent (this feature's own explicit requirement) —
 * `shared/theme.css`'s `--flx-accent`/`--flx-accent-ink` values, copied
 * here as plain hex literals since this file can't import a .css custom
 * property (chrome.action.setBadgeBackgroundColor/setBadgeTextColor take
 * a literal color, not a CSS variable reference).
 */
async function updateNotificationsBadge(state) {
  const unread = countUnread(state.announcements, state.readIds);
  const text = formatBadgeText(unread);
  await chrome.action.setBadgeText({ text });
  if (text) {
    await chrome.action.setBadgeBackgroundColor({ color: '#00D9C0' }); // --flx-accent
    // setBadgeTextColor is a newer action API (Chrome 110+, this build's
    // own `target` in build.mjs) — guarded because an older/unexpected
    // runtime without it must never throw and break the whole poll.
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: '#14100A' }); // --flx-accent-ink
    }
  }
}

/**
 * The one function that actually talks to the backend. `fromAlarm: true`
 * (the periodic alarm) always fetches; `fromAlarm: false` (a popup open)
 * is throttled — skipped outright if the last ATTEMPT was less than
 * NOTIFICATIONS_OPEN_THROTTLE_MS ago, so rapidly reopening the popup
 * during a slow/dead backend can never fire a fetch on every single open.
 * `lastFetchedAt` advances on every real attempt regardless of outcome
 * (not just on success) — deliberately: if only successes advanced it, a
 * backend outage would make every popup open retry a doomed fetch
 * immediately forever, each one adding real latency to that popup open
 * for no benefit; advancing on attempt means a dead backend is retried at
 * a bounded rate (this same throttle) until it recovers, exactly like
 * the portfolio price cache's own `fetchedAt`-on-success-only choice
 * solves the analogous problem for ITS failure mode (see that section's
 * own comment) — two different features, two different correct answers,
 * because a portfolio price fetch failing should retry immediately next
 * open (no cost to the user beyond one more try), while a fully dead
 * backend retried on every open here would be pure wasted latency.
 *
 * Always resolves (never rejects) with the current state — the caller
 * never needs its own try/catch.
 * @returns {Promise<{announcements: Array, readIds: Array<string>, lastFetchedAt: number|null}>}
 */
async function fetchAndMergeNotifications({ fromAlarm }) {
  const current = await getNotificationsState();

  if (!fromAlarm && current.lastFetchedAt && Date.now() - current.lastFetchedAt < NOTIFICATIONS_OPEN_THROTTLE_MS) {
    return current;
  }

  let rows;
  try {
    const res = await fetch(`${__FLUXIO_BACKEND_BASE_URL__}/api/announcements?platform=${NOTIFICATIONS_PLATFORM}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    rows = Array.isArray(body?.announcements) ? body.announcements : [];
  } catch {
    // Network failure, non-2xx, or malformed JSON — all silent per this
    // feature's own explicit requirement. Still advance lastFetchedAt (see
    // this function's own header comment on why) and still recompute the
    // badge from the UNCHANGED cache, so a stale badge can never linger
    // past a mark-as-read that happened before this failed attempt.
    const stamped = { ...current, lastFetchedAt: Date.now() };
    await setNotificationsState(stamped);
    await updateNotificationsBadge(stamped);
    return stamped;
  }

  // Defensive client-side filter even though the server already filters
  // by platform (when `?platform=` is passed, as above) and by the active
  // schedule window (unconditionally) — see announcementsFilter.js's own
  // header comment for why this second layer exists anyway.
  const filtered = filterAnnouncementsForPlatform(rows, { platform: NOTIFICATIONS_PLATFORM, now: Date.now() });
  const merged = mergeAnnouncementsCache({
    cached: current.announcements,
    fresh: filtered,
    readIds: current.readIds,
    now: Date.now()
  });
  const next = { announcements: merged.announcements, readIds: merged.readIds, lastFetchedAt: Date.now() };
  await setNotificationsState(next);
  await updateNotificationsBadge(next);
  return next;
}

chrome.alarms.create(NOTIFICATIONS_ALARM_NAME, { periodInMinutes: NOTIFICATIONS_POLL_PERIOD_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== NOTIFICATIONS_ALARM_NAME) return;
  fetchAndMergeNotifications({ fromAlarm: true });
});
// Deliberately NO unconditional fetchAndMergeNotifications() call here at
// module top level (unlike reprogramAutoLockAlarm() above, which only
// ever touches chrome.alarms.create/clear — already covered by every
// existing e2e test's fake-chrome mock). A real fetch touches
// chrome.action/chrome.storage.local AND performs a real network call;
// firing it unconditionally at module-evaluation time broke every OTHER
// e2e test in this repo that dynamically imports background.bundle.js
// (none of their chrome mocks include chrome.action, since none had any
// reason to before this feature existed) — caught by this prompt's own
// `pnpm test` run, not assumed. `chrome.alarms.create` with only
// `periodInMinutes` (no `delayInMinutes`) schedules its FIRST firing
// `periodInMinutes` from now, not immediately, so this alarm alone won't
// poll until up to NOTIFICATIONS_POLL_PERIOD_MINUTES after a fresh
// install/restart — but the
// popup-open-triggered throttled fetch (FLUXIO_INTERNAL_GET_NOTIFICATIONS,
// called from popup.js's loadNotificationsBadge() on every wallet-ready
// render) already provides a real, near-immediate first fetch the moment
// a user actually opens the popup, which in practice happens well before
// a fresh install would otherwise wait out a full alarm period — an
// acceptable trade-off for keeping this feature's own module-load-time
// footprint at zero chrome.action/network usage, matching every other
// service-worker-safe module-load-time call in this file.

/**
 * Portfolio fiat total (prompt 0118) — one big number on the popup's
 * account card: every mainnet asset's balance × its CoinGecko price,
 * summed in the user's chosen fiat currency. See
 * apps/extension/shared/portfolioValue.js's own header comment for the
 * filtering/pricing/formatting rules this section only ORCHESTRATES
 * (fetching balances + prices, respecting the cache/rate-limit, calling
 * the pure module to actually compute the number) — no decision logic
 * lives here, matching every other feature in this file.
 *
 * REFRESH POLICY (the spec's own explicit requirement): prices refresh
 * ONLY when the popup opens or Refresh is pressed — NEVER on a timer —
 * and even then, no more than once per PRICE_CACHE_MAX_AGE_MS (imported
 * from portfolioValue.js, currently 30s): if a real fetch happened more
 * recently than that, the cached price snapshot is reused as-is rather
 * than calling CoinGecko again, satisfying "max one price call per popup
 * open" even under Refresh-button-mashing. `fetchedAt` in the persisted
 * price cache only ever advances on a SUCCESSFUL fetch (never on a
 * failed attempt) — deliberately: if it advanced on failure too, a
 * temporary CoinGecko outage would incorrectly gate retries for 30s
 * *and* under-report how old the currently-shown price data actually is.
 * A failed fetch simply means the next trigger (next popup open or
 * Refresh) tries again immediately, since the last SUCCESS is still
 * exactly as old as it was before — no separate "last attempt" timestamp
 * is tracked; see this section's own reasoning for why that extra
 * bookkeeping wasn't worth adding.
 *
 * BALANCES are always resolved fresh from THIS session's own address per
 * mainnet network (never trusting a client-supplied balance) — same
 * "never trust the popup" rule every other handler in this file follows,
 * and the same reasoning the Swap screen already established for its own
 * independent balance fetch (see shared/swapAssetSources.js's own header
 * comment): this feature does not attempt to reuse whatever the assets
 * list happens to already have loaded client-side.
 */
const PORTFOLIO_CURRENCY_STORAGE_KEY = 'fluxio_portfolio_currency';
const PORTFOLIO_PRICE_CACHE_STORAGE_KEY = 'fluxio_portfolio_price_cache';

/** Reads the persisted currency preference, sanitized against SUPPORTED_CURRENCIES (falls back to DEFAULT_CURRENCY for anything unset/unrecognized — mirrors getAutoLockMinutes()'s own sanitize-on-read pattern exactly). */
function getPortfolioCurrency() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PORTFOLIO_CURRENCY_STORAGE_KEY], (result) => {
      const stored = result?.[PORTFOLIO_CURRENCY_STORAGE_KEY];
      resolve(isSupportedCurrency(stored) ? stored.toLowerCase() : DEFAULT_CURRENCY);
    });
  });
}

function setPortfolioCurrency(currency) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [PORTFOLIO_CURRENCY_STORAGE_KEY]: currency }, () => resolve());
  });
}

/** @returns {Promise<{ pricesByCoinId: object, fetchedAt: number } | null>} */
function getCachedPrices() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PORTFOLIO_PRICE_CACHE_STORAGE_KEY], (result) => {
      resolve(result?.[PORTFOLIO_PRICE_CACHE_STORAGE_KEY] || null);
    });
  });
}

function setCachedPrices(pricesByCoinId, fetchedAt) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [PORTFOLIO_PRICE_CACHE_STORAGE_KEY]: { pricesByCoinId, fetchedAt } }, () => resolve());
  });
}

/** Persists the ready-to-render total (see PORTFOLIO_TOTAL_CACHE_STORAGE_KEY's own comment in shared/messaging.js — popup.js reads this key directly, not via a message, for the "instant" display requirement). */
function setCachedTotal(payload) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [PORTFOLIO_TOTAL_CACHE_STORAGE_KEY]: payload }, () => resolve());
  });
}

/**
 * Fetches this session's own native + token balances for EVERY mainnet
 * network, all in parallel, never letting one network's failure affect
 * another's (Promise.allSettled, same resilience pattern
 * shared/swapAssetSources.js already established for the Swap screen).
 * @returns {Promise<Record<string, {
 *   nativeSettled: PromiseSettledResult<{ formatted: string, symbol: string }>,
 *   tokenSettled: PromiseSettledResult<{ tokens: Array<{ symbol, name, amountRaw: string, decimals, amountFormatted: string, address }> }>
 * }>>} keyed by network key — EXACTLY the contract portfolioValue.js's
 *   computePortfolioTotal()/accumulateTokens() document. The `{ tokens }`
 *   wrap happens HERE, at the one boundary where tokenService's own
 *   plain-array return meets this pipeline (prompt 0212's real bug:
 *   the bare array used to be stored as tokenSettled.value while the
 *   reader expected `.tokens`, so every held token silently counted for
 *   nothing AND never reached excludedAssets — the owner's dashboard
 *   showed SOL-only totals with no ⓘ badge for months of screenshots).
 *   One wrap point = one shape in this whole file (the
 *   GET_TOKEN_BALANCES handler responds `{ networkKey, tokens }` the
 *   same way); accumulateTokens additionally REJECTS a bare array
 *   loudly instead of reading it as empty, so a third shape can never
 *   slip through silently again.
 */
async function fetchMainnetBalancesForPortfolio(wallet) {
  const entries = await Promise.all(
    MAINNET_NETWORK_KEYS.map(async (networkKey) => {
      const [nativeSettled, tokenSettled] = await Promise.allSettled([
        balanceService.getNativeBalance(networkKey, wallet),
        (async () => {
          const customTokens = await getCustomTokens(networkKey);
          return { tokens: await tokenService.getTokenBalances(networkKey, wallet, { customTokens }) };
        })()
      ]);
      return [networkKey, { nativeSettled, tokenSettled }];
    })
  );
  return Object.fromEntries(entries);
}

/**
 * Resolves the batched CoinGecko price map to use for this computation:
 * reuses the cached snapshot if it's still within PRICE_CACHE_MAX_AGE_MS,
 * otherwise attempts one real fetch (the "max one price call" budget for
 * this invocation) and falls back to whatever cache exists (even if
 * stale) on failure — never throws just because CoinGecko is unreachable,
 * since a stale number is still more useful than none at all (same
 * "cache stays useful even to a stranger/renderer that missed the fresh
 * fetch" spirit as verifiedSwapTokensCache above, applied to a durable
 * cache instead of an in-memory one).
 * @returns {Promise<{ pricesByCoinId: object, fetchedAt: number, stale: boolean }>}
 */
async function resolvePortfolioPrices() {
  const cached = await getCachedPrices();
  const now = Date.now();

  if (cached && !isPriceStale({ fetchedAt: cached.fetchedAt, now, maxAgeMs: PRICE_CACHE_MAX_AGE_MS })) {
    return { pricesByCoinId: cached.pricesByCoinId, fetchedAt: cached.fetchedAt, stale: false };
  }

  try {
    const pricesByCoinId = await priceService.getPrices({
      coinIds: ALL_PRICED_COIN_IDS,
      vsCurrencies: ALL_SUPPORTED_CURRENCY_CODES
    });
    const fetchedAt = Date.now();
    await setCachedPrices(pricesByCoinId, fetchedAt);
    return { pricesByCoinId, fetchedAt, stale: false };
  } catch {
    // CoinGecko unreachable/erroring — fall back to whatever cache
    // exists, however old, rather than showing nothing. `fetchedAt` is
    // deliberately NOT updated here (see this section's own header
    // comment) so the next trigger retries immediately instead of being
    // gated by a failed attempt.
    if (cached) {
      return { pricesByCoinId: cached.pricesByCoinId, fetchedAt: cached.fetchedAt, stale: true };
    }
    return { pricesByCoinId: {}, fetchedAt: NaN, stale: true };
  }
}

const internalMessageHandlers = {
  FLUXIO_INTERNAL_GET_APPROVAL: async ({ id }) => {
    const request = getPendingRequest(id);
    if (!request) throw new Error('Unknown or already-resolved approval request.');
    return {
      request,
      hasWallet: await walletService.hasWallet(),
      isUnlocked: walletService.isUnlocked()
    };
  },
  /** General wallet-state check — used by popup.js and onboarding.js to pick which screen to show, not tied to any pending approval request. */
  FLUXIO_INTERNAL_GET_STATUS: async () => {
    const hasWallet = await walletService.hasWallet();
    const isUnlocked = walletService.isUnlocked();
    return { hasWallet, isUnlocked, wallet: isUnlocked ? walletService.getPublicWallet() : null };
  },
  /** Pure — generates a mnemonic to show the user for backup. Nothing is persisted until FLUXIO_INTERNAL_IMPORT_WALLET runs later. */
  FLUXIO_INTERNAL_GENERATE_MNEMONIC: async ({ wordCount }) => {
    return { mnemonic: generateMnemonic(wordCount) };
  },
  /** Pure — lets onboarding.js reject an invalid pasted seed phrase before ever asking for a password. */
  FLUXIO_INTERNAL_VALIDATE_MNEMONIC: async ({ mnemonic }) => {
    return { valid: validateMnemonic(mnemonic) };
  },
  /**
   * Persists a mnemonic under a password. Used for BOTH finishing a "create
   * new wallet" flow (the mnemonic was already generated, shown, and
   * verified to the user by this point — persisting it is mechanically
   * identical to importing a known one) and a true "import existing wallet"
   * flow. Guards against clobbering an existing vault — saveVault has no
   * existence check of its own, so this is the one place that stops a
   * stray create/import call from silently destroying an existing wallet.
   */
  FLUXIO_INTERNAL_IMPORT_WALLET: async ({ mnemonic, password }) => {
    if (await walletService.hasWallet()) {
      throw new Error('A wallet already exists on this device. Unlock it instead of creating or importing a new one.');
    }
    const { wallet } = await walletService.importWallet(mnemonic, password);
    return { wallet };
  },
  /**
   * Multi-account: unlock() always derives account index 0 first (see
   * walletService.js's openSession) — after that, restore whichever
   * account was last active, per accountsService's persisted metadata
   * (defaults to 0 for a wallet that's never used this feature, so this
   * is a no-op re-derive in the common single-account case, not a
   * behavior change for every unlock).
   */
  FLUXIO_INTERNAL_UNLOCK: async ({ password }) => {
    const wallet = await walletService.unlock(password);
    const { activeIndex } = await accountsService.getAccountsState();
    const activeWallet = activeIndex === wallet.accountIndex ? wallet : await walletService.setActiveAccount(activeIndex);
    return { isUnlocked: true, wallet: activeWallet };
  },
  /** Locks the session (walletService.lock() — scrubs the in-memory seed AND removes the persisted chrome.storage.session copy, see that function's own comment). Reachable from the popup's account card and from Settings; no confirmation round trip needed since it never destroys anything persisted to the encrypted vault, only the unlocked session state. */
  FLUXIO_INTERNAL_LOCK: async () => {
    await walletService.lock();
    return { isUnlocked: false };
  },
  /**
   * "Forgot password?" (prompt 0124) — this wallet is non-custodial, so
   * there is no password *reset*; the only recovery path is erasing the
   * local vault and re-importing from the seed phrase. Deliberately
   * reachable while LOCKED — a user who forgot their password is locked
   * by definition, so this must never require an unlocked session first
   * (unlike almost every other internal message, it does not read
   * walletService.isUnlocked()/getPublicWallet() at all).
   *
   * Clears everything tied to the current seed, per this feature's own
   * storage-key inventory (prompt/0124-forgot-password-reset-wallet.md):
   *   - the encrypted vault + unlocked session, in-memory AND the
   *     chrome.storage.session-persisted copy (walletService.resetWallet())
   *   - multi-account metadata (accountsService.resetAccountsState())
   *   - custom tokens for every network, local transaction history, and
   *     the user's preferences (auto-lock, currency, card background,
   *     developer-networks toggle, swap slippage) — all deliberately
   *     erased too, not just the secrets: a stale custom-token list or
   *     cached portfolio total from the OLD seed would misrepresent a
   *     wallet that, after this call, no longer exists on this device.
   *   - the periodic auto-lock alarm itself (prompt 0124 Revision 1 — a
   *     real bug caught before manual testing, not just reasoned about:
   *     removing AUTO_LOCK_STORAGE_KEY above only erases the persisted
   *     DURATION setting, never the separate chrome.alarms registration
   *     reprogramAutoLockAlarm() created — Chrome tracks alarms entirely
   *     outside chrome.storage, so clearing the setting key does nothing
   *     to it. Left alone, that alarm keeps firing once a minute forever
   *     (each firing a harmless no-op — the onAlarm handler's own
   *     `if (!walletService.isUnlocked()) return;` bails immediately with
   *     no wallet to check), exactly the "unnecessary once-a-minute
   *     service-worker wake-ups" `reprogramAutoLockAlarm()`'s own "Never"
   *     branch was written to avoid. Fixed with the EXACT SAME call that
   *     branch uses — `chrome.alarms.clear(AUTO_LOCK_ALARM_NAME)` —
   *     rather than calling reprogramAutoLockAlarm() itself: that function
   *     re-reads AUTO_LOCK_STORAGE_KEY to decide, and the key is now
   *     MISSING (not set to 'never'), which getAutoLockMinutes() would
   *     resolve to AUTO_LOCK_DEFAULT_MINUTES and RE-CREATE the alarm —
   *     the opposite of what a reset should do.
   *
   * Deliberately does NOT touch FLUXIO_INTERNAL_IMPORT_WALLET's own
   * hasWallet()-guard — that guard stays completely unmodified. This
   * handler's entire job is to make hasWallet() legitimately return
   * false afterward (by actually deleting the vault), so the very next
   * import call passes the SAME guard everyone else has to, not to add a
   * bypass path around it.
   */
  FLUXIO_INTERNAL_RESET_WALLET: async () => {
    await walletService.resetWallet();
    await accountsService.resetAccountsState();
    await chrome.storage.local.remove([
      CUSTOM_TOKENS_STORAGE_KEY,
      TX_HISTORY_STORAGE_KEY,
      AUTO_LOCK_STORAGE_KEY,
      PORTFOLIO_CURRENCY_STORAGE_KEY,
      PORTFOLIO_TOTAL_CACHE_STORAGE_KEY,
      DEV_NETWORKS_STORAGE_KEY,
      SWAP_SLIPPAGE_STORAGE_KEY,
      CARD_BACKGROUND_STORAGE_KEY
    ]);
    await chrome.alarms.clear(AUTO_LOCK_ALARM_NAME);
    return { ok: true };
  },
  /**
   * Settings' "Reveal Secret Phrase" — re-verifies the password against the
   * persisted vault and returns the mnemonic. Deliberately does NOT go
   * through walletService.unlock(): that returns the derived public wallet
   * (not the mnemonic text this needs to display) and would pointlessly
   * re-open/reset the session that's already unlocked. isUnlocked() is
   * checked first as defense in depth — the Settings page itself is only
   * reachable while unlocked, but this never trusts that alone.
   */
  FLUXIO_INTERNAL_REVEAL_SEED: async ({ password }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    const vault = await loadVault();
    if (!vault) {
      throw new Error('WALLET_NOT_INITIALIZED');
    }
    const mnemonic = await unlockVault(vault, password); // throws on wrong password
    return { mnemonic };
  },
  /**
   * Read-only — no key material involved. Resolves the current session's
   * own address for the requested network (never a client-supplied
   * address) and fetches its native-coin balance over public RPC.
   */
  FLUXIO_INTERNAL_GET_BALANCE: async ({ networkKey }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    const wallet = walletService.getPublicWallet();
    const { formatted, symbol } = await balanceService.getNativeBalance(networkKey, wallet);
    return { networkKey, formatted, symbol };
  },
  /**
   * Read-only, same trust rules as FLUXIO_INTERNAL_GET_BALANCE above (the
   * session's own address, never a client-supplied one). Merges
   * @fluxio/constants/tokens.js's static registry with any locally-
   * registered custom tokens for this network (see getCustomTokens()
   * below) before resolving balances via @fluxio/services/tokenService —
   * Solana auto-discovers every held SPL token regardless of the
   * registry (only used there for symbol/name lookup); EVM has no
   * discovery, so the merged registry+custom list is what actually gets
   * checked, one eth_call per token.
   */
  FLUXIO_INTERNAL_GET_TOKEN_BALANCES: async ({ networkKey }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    const wallet = walletService.getPublicWallet();
    const customTokens = await getCustomTokens(networkKey);
    const tokens = await tokenService.getTokenBalances(networkKey, wallet, { customTokens });
    // Prompt 0206: only entries the service left "Unknown" (i.e. neither
    // a user-created custom token nor the built-in registry named them —
    // the priority order is preserved by construction) get a LAST-RESORT
    // name from the verified-list snapshot; mints absent from the
    // snapshot stay "Unknown" on purpose.
    if (networkKey === 'solana' && tokens.some((t) => t.symbol === 'Unknown')) {
      try {
        const byMint = await readTokenMetadataSnapshot();
        if (byMint) {
          for (const t of tokens) {
            const meta = t.symbol === 'Unknown' ? byMint[t.address] : null;
            if (meta) {
              t.symbol = meta.symbol;
              t.name = meta.name;
            }
          }
        }
      } catch {
        // Best-effort naming — balances themselves are already correct.
      }
    }
    return { networkKey, tokens };
  },
  /**
   * Lists locally-registered custom tokens — the raw chrome.storage.local
   * entries only, never merged with the static registry (see
   * CUSTOM_TOKENS_STORAGE_KEY's own comment for why this file is the one
   * place that reads/writes this key). Without `networkKey`, returns
   * every network's list at once (`tokensByNetwork`) — backs the Manage
   * Tokens network-picker screen's per-network count hint in a single
   * round trip instead of one per network; with `networkKey`, returns
   * just that one network's list (`tokens`) — backs the per-network
   * management screen once a network is picked.
   */
  FLUXIO_INTERNAL_LIST_CUSTOM_TOKENS: async ({ networkKey } = {}) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    if (networkKey) {
      if (!NETWORKS[networkKey]) {
        throw new Error(`Unknown network: ${networkKey}`);
      }
      return { networkKey, tokens: await getCustomTokens(networkKey) };
    }
    return { tokensByNetwork: await readCustomTokensStorage() };
  },
  /**
   * Registers a new custom token for `networkKey` — the human-facing
   * replacement for the service-worker-console snippet mechanism (see
   * CUSTOM_TOKENS_STORAGE_KEY's own comment). Validates, in order:
   *   1. `address` is structurally valid for the network's chain
   *      (isValidEvmAddress/isValidSolanaAddress — real decode-based
   *      checks, not popup.js's own live-typing heuristic).
   *   2. Not a duplicate of an existing registry OR custom entry, using
   *      the exact same case-sensitivity rule mergeTokens() itself uses
   *      (@fluxio/constants/tokens.js's normalizeTokenAddress) to decide
   *      "is this the same token" — so this can never disagree with what
   *      getTokenBalances() would itself treat as a collision.
   *   3. A manually-supplied `decimals` (EVM only — rejected outright for
   *      a Solana network, see below) is a whole number 0..18.
   * ...then fetches the token's REAL on-chain metadata before persisting
   * anything — the direct lesson from the dead-custom-token bug this UI
   * exists partly to prevent (a stale console-pasted entry silently broke
   * balance fetching for its whole network until that was fixed): better
   * to refuse to add a token that doesn't actually exist on this network
   * than to persist a dead entry and find out later.
   *
   * Metadata resolution, per chain (see tokenService.js's
   * fetchErc20Metadata()/fetchSolanaMintInfo() for the full contract):
   *   - EVM: symbol()/name()/decimals() are fetched; a manually-supplied
   *     symbol/name/decimals always wins over whatever was fetched (a
   *     user correcting a token that reports something unhelpful is a
   *     legitimate override, not a mistake to block). If decimals is
   *     resolvable from neither the manual input nor the chain, the add
   *     is refused outright — an ERRONEOUS decimals value directly
   *     corrupts every displayed balance for that token, so this is not
   *     a value to silently default.
   *   - Solana: decimals is ALWAYS read from the mint account itself,
   *     never overridable — manually supplying one is rejected before
   *     any RPC call is even made. symbol/name have no reliable on-chain
   *     source without taking on a Metaplex Token Metadata dependency
   *     this repo deliberately does not add for this slice (see this
   *     feature's own scope-cut notes) — manual input, or "Unknown",
   *     the exact same fallback getTokenBalances() already shows for an
   *     unrecognized held mint.
   */
  FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN: async ({ networkKey, address, symbol, name, decimals }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    const { isEvm } = await validateNewCustomTokenAddress(networkKey, address);

    if (decimals != null && !isEvm) {
      throw new Error('Decimals cannot be set manually for a Solana token. It is always read from the mint.');
    }
    if (decimals != null && !isValidTokenDecimals(decimals)) {
      throw new Error('Decimals must be a whole number between 0 and 18.');
    }

    let resolvedSymbol;
    let resolvedName;
    let resolvedDecimals;
    try {
      if (isEvm) {
        const fetched = await tokenService.fetchErc20Metadata(networkKey, address);
        resolvedDecimals = decimals ?? fetched.decimals;
        if (resolvedDecimals == null) {
          throw new Error(`Found a contract at ${address}, but could not read its decimals. Enter it manually.`);
        }
        resolvedSymbol = symbol || fetched.symbol || 'Unknown';
        resolvedName = name || fetched.name || 'Unknown';
      } else {
        const fetched = await tokenService.fetchSolanaMintInfo(networkKey, address);
        resolvedDecimals = fetched.decimals;
        resolvedSymbol = symbol || 'Unknown';
        resolvedName = name || 'Unknown';
      }
    } catch (error) {
      throw withLocalRpcHint(networkKey, error);
    }

    const entry = { symbol: resolvedSymbol, name: resolvedName, decimals: resolvedDecimals, address };
    const allNetworks = await readCustomTokensStorage();
    allNetworks[networkKey] = [...(allNetworks[networkKey] || []), entry];
    await writeCustomTokensStorage(allNetworks);

    return { networkKey, token: entry };
  },
  /**
   * "Add custom token" step 1 -> step 2 preview (prompt 0119, replacing
   * the old one-shot flat form manual verification of prompts 0108/0109
   * found confusing — see prompt/0119-add-token-ux-two-step.md). Given
   * just an address, resolves on-chain metadata via the EXACT SAME
   * fetchErc20Metadata()/fetchSolanaMintInfo() functions
   * FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN itself calls below — no new fetch
   * logic, only a new entry point that returns a preview instead of
   * persisting anything. Purely read-only: never writes to
   * CUSTOM_TOKENS_STORAGE_KEY. Shares validateNewCustomTokenAddress()
   * with ADD_CUSTOM_TOKEN (see that function's own comment) so the two
   * steps can never disagree about "is this even addable."
   *
   * Returns a DISCRIMINATED RESULT rather than throwing for the two
   * outcomes the popup's own UI needs to tell apart — an unreachable RPC
   * and "no contract/mint here" are both legitimate, ANTICIPATED answers
   * to "what's at this address," not caller mistakes, so they're data
   * here, not exceptions (the same "expected outcome, not an error"
   * distinction FLUXIO_INTERNAL_VALIDATE_MNEMONIC already draws for an
   * invalid mnemonic):
   *   - `{ status: 'found', symbol, name, decimals }` — on-chain
   *     resolution succeeded, at least partially (EVM's own
   *     fetchErc20Metadata already tolerates one or two of the three
   *     fields coming back null — see that function's own comment — so
   *     `decimals` CAN still be null here even on a 'found' result; the
   *     popup decides field-editability from that, not from `status`
   *     alone, via shared/addTokenFlow.js's isDecimalsEditable()).
   *   - `{ status: 'rpc-unreachable', message }` — every RPC endpoint
   *     failed, OR an unrecognized/unexpected error occurred that isn't
   *     confidently a "definitely no token here" verdict (see below) —
   *     deliberately the SAFE DEFAULT bucket: the popup should offer
   *     Retry (and, EVM only, shared/addTokenFlow.js's
   *     canOfferManualFallback() gates a manual-entry fallback), never
   *     silently mis-telling the user "there's nothing here" for a
   *     problem that might just be transient.
   *   - `{ status: 'not-found', message }` — the RPC answered, and it's
   *     one of tokenService.js's own CONFIDENT "nothing valid here"
   *     verdicts (an EVM address with no contract at all, or a Solana
   *     address that isn't an SPL mint) — the popup should reject
   *     outright, never offer to save an empty/guessed entry.
   *
   * REVISION 1 (prompt 0119's own bug fix, see
   * prompt/0119-add-token-ux-two-step.md): classification is now
   * STRUCTURAL — `error instanceof RpcUnreachableError` (a real type, see
   * @fluxio/crypto/rpc.js's own comment) — not the message-string
   * whitelist this handler originally shipped with. That whitelist was
   * found, via real manual verification, to misclassify a genuine
   * connectivity problem as "not-found": tokenService.js's
   * fetchErc20Metadata() fires 3 concurrent eth_calls, and a single one
   * of them coming back with a real (if empty) response — while the
   * other two genuinely failed to connect — used to produce a plain "No
   * contract found" Error, which the whitelist then (correctly, given
   * its own rules, but WRONGLY overall) classified as a confident
   * rejection. The fix lives in tokenService.js itself (see that
   * function's own REVISION 1 note) — it now throws a real
   * RpcUnreachableError whenever even one of the three concurrent calls
   * hit a genuine transport failure and none of the others returned real
   * data, so THIS handler's own `instanceof` check needs no whitelist at
   * all anymore: everything that isn't confidently "the chain answered,
   * and the honest answer is nothing here" is, by construction, already
   * an RpcUnreachableError by the time it reaches this catch block.
   */
  FLUXIO_INTERNAL_PREVIEW_CUSTOM_TOKEN: async ({ networkKey, address }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    const { isEvm } = await validateNewCustomTokenAddress(networkKey, address);

    try {
      if (isEvm) {
        const fetched = await tokenService.fetchErc20Metadata(networkKey, address);
        return { status: 'found', symbol: fetched.symbol, name: fetched.name, decimals: fetched.decimals };
      }
      const fetched = await tokenService.fetchSolanaMintInfo(networkKey, address);
      return { status: 'found', symbol: null, name: null, decimals: fetched.decimals };
    } catch (error) {
      const hinted = withLocalRpcHint(networkKey, error);
      if (hinted instanceof RpcUnreachableError) {
        return { status: 'rpc-unreachable', message: hinted.message };
      }
      return { status: 'not-found', message: hinted.message };
    }
  },
  /**
   * Removes a custom token by address — idempotent (removing an
   * already-absent/never-registered address is not an error, just a
   * no-op; `removed` tells the caller whether anything actually
   * changed). Only ever touches the custom-token storage layer, never
   * the static registry — a registry entry (e.g. the built-in Sepolia/
   * Devnet USDC) was never addable via ADD_CUSTOM_TOKEN in the first
   * place (rejected as a duplicate above) and isn't removable here
   * either.
   */
  FLUXIO_INTERNAL_REMOVE_CUSTOM_TOKEN: async ({ networkKey, address }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    if (!NETWORKS[networkKey]) {
      throw new Error(`Unknown network: ${networkKey}`);
    }

    const allNetworks = await readCustomTokensStorage();
    const before = allNetworks[networkKey] || [];
    const normalizedTarget = normalizeTokenAddress(networkKey, address);
    const after = before.filter((t) => normalizeTokenAddress(networkKey, t.address) !== normalizedTarget);
    allNetworks[networkKey] = after;
    await writeCustomTokensStorage(allNetworks);

    return { networkKey, removed: after.length !== before.length };
  },
  /**
   * Fee estimate for a transfer from the current session's own address on
   * the given network (never a client-supplied `from` — same principle as
   * FLUXIO_INTERNAL_GET_BALANCE above). Read-only, no signing/approval
   * involved. Routes to transactionService (Solana) or
   * evmTransactionService (EVM) based on the network's accountType — the
   * one place Tahap D's Solana/EVM split gets bridged back into a single
   * network-agnostic response shape, so popup.js's Send flow doesn't need
   * a parallel code path per chain. Takes `amount` (a human-typed decimal
   * string, e.g. "0.05") rather than a raw lamports/wei/token-unit integer
   * — popup.js never does its own amount math (it's unbundled and can't
   * import @fluxio/utils), so every amount in the response is *also* a
   * decimal string, pre-computed here.
   *
   * TOKEN SENDS (prompt 0113) — `tokenAddress`, optional: null/omitted
   * means native (the original, unchanged behavior below); a value routes
   * through this SAME message type rather than a new one. This is a
   * deliberate generalization, not a new message: the shape of "estimate
   * a transfer for the session's own address on a network, given a
   * recipient and amount" doesn't change for a token — only which
   * currency the amount is denominated in and which service function
   * gets called. Adding a second near-identical message type
   * (ESTIMATE_TOKEN_TRANSFER) would have duplicated the network/wallet-
   * resolution boilerplate above for no real benefit. The response shape
   * DOES differ from the native case (`isToken: true`, separate
   * token-currency and native-currency fields — a token amount and its
   * network fee are never the same currency and must never be added
   * together the way native's own `totalAmount` does) — popup.js
   * branches on `isToken` to decide which fields to read, the one thing
   * this generalization couldn't fully hide.
   *
   * Server-side validation for a token send: `tokenAddress` must resolve
   * against this network's registry+custom-token list
   * (resolveRegisteredToken — same mergeTokens/normalizeTokenAddress
   * machinery FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN already uses) before
   * anything else happens — an arbitrary/unregistered address is refused
   * here, never reaching transactionService/evmTransactionService (which
   * have no notion of a token registry at all).
   */
  FLUXIO_INTERNAL_ESTIMATE_TRANSFER: async ({ networkKey, to, amount, tokenAddress = null }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    const network = NETWORKS[networkKey];
    if (!network) {
      throw new Error(`Unknown network: ${networkKey}`);
    }
    const wallet = walletService.getPublicWallet();
    const { address: from } = walletService.getAccountForNetwork(wallet, networkKey);

    if (!tokenAddress) {
      if (network.accountType === ACCOUNT_TYPES.SOLANA) {
        const lamports = solToLamports(amount);
        const [{ fee, blockhash, lastValidBlockHeight }, balanceLamports] = await Promise.all([
          transactionService.estimateSolTransfer({ network: networkKey, from, to, lamports }),
          transactionService.getSolBalance({ network: networkKey, address: from })
        ]);
        const totalLamports = lamports + fee;
        return {
          symbol: network.nativeCurrency.symbol,
          isMaxFee: false,
          feeAmount: lamportsToSol(fee),
          totalAmount: lamportsToSol(totalLamports),
          balanceAmount: lamportsToSol(balanceLamports),
          maxSendableAmount: balanceLamports > fee ? lamportsToSol(balanceLamports - fee) : lamportsToSol(0n),
          sufficient: balanceLamports >= totalLamports,
          blockhash,
          lastValidBlockHeight
        };
      }

      if (network.accountType === ACCOUNT_TYPES.EVM) {
        const amountWei = ethToWei(amount);
        const [{ maxFeeWei }, balanceWei] = await Promise.all([
          evmTransactionService.estimateEthTransfer({ network: networkKey, from, to, amountEth: amount }),
          evmTransactionService.getEvmBalance({ network: networkKey, address: from })
        ]);
        const totalWei = amountWei + maxFeeWei;
        return {
          symbol: network.nativeCurrency.symbol,
          isMaxFee: true, // EIP-1559: maxFeeWei is an upper bound, the actual charge is usually lower
          feeAmount: weiToEth(maxFeeWei),
          totalAmount: weiToEth(totalWei),
          balanceAmount: weiToEth(balanceWei),
          maxSendableAmount: balanceWei > maxFeeWei ? weiToEth(balanceWei - maxFeeWei) : weiToEth(0n),
          sufficient: balanceWei >= totalWei
        };
      }

      throw new Error(`Sending is not supported for network: ${networkKey}`);
    }

    const known = await resolveRegisteredToken(networkKey, tokenAddress);

    if (network.accountType === ACCOUNT_TYPES.SOLANA) {
      const result = await transactionService.estimateSplTransfer({ network: networkKey, from, to, mint: tokenAddress, amount });
      const nativeRequired = result.fee + result.ataRent;
      return {
        isToken: true,
        symbol: known.symbol,
        tokenAmount: formatUnits(result.amountRaw, result.decimals),
        tokenBalanceAmount: formatUnits(result.tokenBalanceRaw, result.decimals),
        maxSendableAmount: formatUnits(result.tokenBalanceRaw, result.decimals),
        sufficientToken: result.tokenBalanceRaw >= result.amountRaw,
        nativeSymbol: network.nativeCurrency.symbol,
        isMaxFee: false,
        feeAmount: lamportsToSol(result.fee),
        needsAta: result.needsAta,
        ataRentAmount: lamportsToSol(result.ataRent),
        nativeBalanceAmount: lamportsToSol(result.nativeBalance),
        nativeRequiredAmount: lamportsToSol(nativeRequired),
        sufficientNative: result.nativeBalance >= nativeRequired,
        sufficient: result.tokenBalanceRaw >= result.amountRaw && result.nativeBalance >= nativeRequired,
        blockhash: result.blockhash,
        lastValidBlockHeight: result.lastValidBlockHeight
      };
    }

    if (network.accountType === ACCOUNT_TYPES.EVM) {
      const amountRaw = parseUnits(amount, known.decimals);
      const result = await evmTransactionService.estimateErc20Transfer({ network: networkKey, from, to, tokenAddress, amountRaw });
      return {
        isToken: true,
        symbol: known.symbol,
        tokenAmount: formatUnits(result.amountRaw, known.decimals),
        tokenBalanceAmount: formatUnits(result.tokenBalanceRaw, known.decimals),
        maxSendableAmount: formatUnits(result.tokenBalanceRaw, known.decimals),
        sufficientToken: result.tokenBalanceRaw >= result.amountRaw,
        nativeSymbol: network.nativeCurrency.symbol,
        isMaxFee: true, // EIP-1559: maxFeeWei is an upper bound, same reasoning as the native EVM case above
        feeAmount: weiToEth(result.maxFeeWei),
        needsAta: false,
        ataRentAmount: lamportsToSol(0n),
        nativeBalanceAmount: weiToEth(result.nativeBalanceWei),
        nativeRequiredAmount: weiToEth(result.maxFeeWei),
        sufficientNative: result.nativeBalanceWei >= result.maxFeeWei,
        sufficient: result.tokenBalanceRaw >= result.amountRaw && result.nativeBalanceWei >= result.maxFeeWei
      };
    }

    throw new Error(`Sending is not supported for network: ${networkKey}`);
  },
  /**
   * Build, sign and broadcast a transfer from the current session's own
   * address, routed the same way FLUXIO_INTERNAL_ESTIMATE_TRANSFER is —
   * same `tokenAddress`-optional generalization, same reasoning for why
   * this stays one message type (see that handler's own comment). Neither
   * transactionService.js nor evmTransactionService.js imports
   * walletService itself (see their own header comments) — this is where
   * they meet, passing walletService.signTransaction() in as the `sign`
   * callback, exactly like every other signing path in this file.
   * walletService.signTransaction() already branches on the network's
   * accountType internally (see walletService.js's signerForNetwork), so
   * the same call shape works for both a Solana message-bytes payload and
   * an EVM transaction-request object — true for a token send too, since
   * transactionService.sendSplTransfer/evmTransactionService.sendErc20Transfer
   * both still hand this the exact same payload shape (message bytes /
   * transaction request) their native siblings do.
   *
   * Prompt 0173 — the mainnet gate: this handler used to hard-refuse any
   * network that wasn't flagged `isTestnet: true` in
   * @fluxio/constants/networks.js, independent of which chain family or
   * asset (native or token) the send was for — the actual backstop
   * against a mainnet send this feature wasn't ready for yet. That guard
   * is lifted here by the owner's own recorded decision (option A, see
   * CLAUDE.md's release-queue note): mainnet is now treated exactly like
   * every other configured network for Send/Estimate — same address
   * validation, same real balance/fee checks, same explicit user
   * confirmation on the Confirm Send screen, nothing new. A mainnet send
   * still needs sufficient real balance to get past
   * FLUXIO_INTERNAL_ESTIMATE_TRANSFER's own `sufficient` check (which
   * never had a testnet-only restriction of its own — see that handler's
   * comment) before a user ever reaches this handler at all. Swap
   * execution remains gated completely separately and is untouched by
   * this change — see FLUXIO_INTERNAL_EXECUTE_SWAP's own unconditional
   * `SWAP_EXECUTION_DISABLED` below, which was never keyed on `isTestnet`
   * in the first place. Lifting this guard does not itself constitute a
   * real-money test — see prompt 0173's own archive for the owner's
   * gate: a genuine transfer with the owner's own mainnet funds still has
   * to happen and pass before Chrome Web Store submission.
   */
  FLUXIO_INTERNAL_SEND_TRANSFER: async ({ networkKey, to, amount, tokenAddress = null }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    const network = NETWORKS[networkKey];
    if (!network) {
      throw new Error(`Unknown network: ${networkKey}`);
    }
    const wallet = walletService.getPublicWallet();
    const { address: from } = walletService.getAccountForNetwork(wallet, networkKey);

    if (!tokenAddress) {
      if (network.accountType === ACCOUNT_TYPES.SOLANA) {
        const lamports = solToLamports(amount);
        const { signature, explorerUrl } = await transactionService.sendSolTransfer({
          network: networkKey,
          from,
          to,
          lamports,
          sign: (messageBytes) => walletService.signTransaction(networkKey, messageBytes)
        });
        // Local Activity record — see TX_HISTORY_STORAGE_KEY's own comment.
        // Best-effort: a storage-write failure here must never make an
        // otherwise-successful send look like it failed to the caller.
        try {
          await recordLocalTransaction({
            networkKey,
            direction: 'out',
            signatureOrHash: signature,
            from,
            to,
            amountRaw: lamports.toString(),
            unit: network.nativeCurrency.symbol,
            timestamp: Date.now(),
            status: 'pending'
          });
        } catch {
          // Non-fatal — see comment above.
        }
        return { hash: signature, explorerUrl };
      }

      if (network.accountType === ACCOUNT_TYPES.EVM) {
        const amountWei = ethToWei(amount);
        const { hash, explorerUrl } = await evmTransactionService.sendEthTransfer({
          network: networkKey,
          from,
          to,
          amountEth: amount,
          sign: (transactionRequest) => walletService.signTransaction(networkKey, transactionRequest)
        });
        try {
          await recordLocalTransaction({
            networkKey,
            direction: 'out',
            signatureOrHash: hash,
            from,
            to,
            amountRaw: amountWei.toString(),
            unit: network.nativeCurrency.symbol,
            timestamp: Date.now(),
            status: 'pending'
          });
        } catch {
          // Non-fatal — see comment above.
        }
        return { hash, explorerUrl };
      }

      throw new Error(`Sending is not supported for network: ${networkKey}`);
    }

    const known = await resolveRegisteredToken(networkKey, tokenAddress);

    if (network.accountType === ACCOUNT_TYPES.SOLANA) {
      const { signature, explorerUrl, decimals, amountRaw, ataCreated } = await transactionService.sendSplTransfer({
        network: networkKey,
        from,
        to,
        mint: tokenAddress,
        amount,
        sign: (messageBytes) => walletService.signTransaction(networkKey, messageBytes)
      });
      try {
        // isToken/tokenAddress/tokenDecimals: the extra fields
        // formatHistoryEntry() reads to format/badge this entry as a
        // token send instead of (wrongly) treating amountRaw as native
        // lamports — see that function's own comment.
        await recordLocalTransaction({
          networkKey,
          direction: 'out',
          signatureOrHash: signature,
          from,
          to,
          amountRaw: amountRaw.toString(),
          unit: known.symbol,
          timestamp: Date.now(),
          status: 'pending',
          isToken: true,
          tokenAddress,
          tokenDecimals: decimals
        });
      } catch {
        // Non-fatal — see comment above.
      }
      return { hash: signature, explorerUrl, ataCreated };
    }

    if (network.accountType === ACCOUNT_TYPES.EVM) {
      const amountRaw = parseUnits(amount, known.decimals);
      const { hash, explorerUrl } = await evmTransactionService.sendErc20Transfer({
        network: networkKey,
        from,
        to,
        tokenAddress,
        amountRaw,
        sign: (transactionRequest) => walletService.signTransaction(networkKey, transactionRequest)
      });
      try {
        await recordLocalTransaction({
          networkKey,
          direction: 'out',
          signatureOrHash: hash,
          from,
          to,
          amountRaw: amountRaw.toString(),
          unit: known.symbol,
          timestamp: Date.now(),
          status: 'pending',
          isToken: true,
          tokenAddress,
          tokenDecimals: known.decimals
        });
      } catch {
        // Non-fatal — see comment above.
      }
      return { hash, explorerUrl };
    }

    throw new Error(`Sending is not supported for network: ${networkKey}`);
  },
  /**
   * Read-only confirmation-status poll for a hash this session just
   * broadcast (or any hash — it takes no key material and trusts nothing
   * about who's asking beyond the usual internal-sender gate). Routed by
   * accountType the same way as the two handlers above.
   *
   * Also piggybacks the local Activity record: whenever this poll
   * observes a final status (finalLocalStatusFor() returns non-null),
   * that status is persisted for the matching local-record entry, if one
   * exists — a no-op if there isn't one, or if it's already at that
   * status. This is the ONE place a local record's 'pending' status ever
   * advances, reusing the polling popup.js's Send-result screen already
   * does (pollConfirmation) rather than starting a second poll loop —
   * see TX_HISTORY_STORAGE_KEY's own comment.
   */
  FLUXIO_INTERNAL_TRANSFER_STATUS: async ({ networkKey, hash }) => {
    const network = NETWORKS[networkKey];
    if (!network) {
      throw new Error(`Unknown network: ${networkKey}`);
    }
    let result;
    if (network.accountType === ACCOUNT_TYPES.SOLANA) {
      result = await transactionService.getTransactionStatus({ network: networkKey, signature: hash });
    } else if (network.accountType === ACCOUNT_TYPES.EVM) {
      result = await evmTransactionService.getEvmTransactionStatus({ network: networkKey, hash });
    } else {
      throw new Error(`Status lookup not supported for network: ${networkKey}`);
    }

    const finalStatus = finalLocalStatusFor(network, result);
    if (finalStatus) {
      try {
        await updateLocalTransactionStatus(networkKey, hash, finalStatus);
      } catch {
        // Best-effort — the poll's own result is still returned below regardless.
      }
    }
    return result;
  },
  /**
   * Activity screen data for one network: this wallet's local send
   * record merged with real chain history (Solana only this slice — see
   * @fluxio/services/historyService.js's own header comment for why EVM
   * chain history isn't built). Address is always resolved server-side
   * from the active session, never client-supplied — same rule as every
   * other read handler here.
   *
   * Failure isolation: a chain-history fetch failure (e.g. the local
   * validator/anvil isn't running) is caught and returned as
   * `chainHistoryError` alongside whatever local-record entries still
   * exist — the whole point being that a dead RPC never blanks the
   * screen to a bare error the way an unhandled rejection would; popup.js
   * shows the local entries plus a small retry banner instead (the exact
   * "isolasi kegagalan" lesson prompt 0108 already established for token
   * balances, applied here to Activity).
   */
  FLUXIO_INTERNAL_GET_HISTORY: async ({ networkKey }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    const network = NETWORKS[networkKey];
    if (!network) {
      throw new Error(`Unknown network: ${networkKey}`);
    }
    const wallet = walletService.getPublicWallet();
    const { address } = walletService.getAccountForNetwork(wallet, networkKey);

    const localEntries = await getLocalTransactions(networkKey);

    let chainEntries = [];
    let chainHistoryError = null;
    if (network.accountType === ACCOUNT_TYPES.SOLANA) {
      try {
        chainEntries = await historyService.getSolanaChainHistory({ networkKey, address });
      } catch (error) {
        chainHistoryError = withLocalRpcHint(networkKey, error).message;
      }
    }

    const merged = historyService.mergeHistory(localEntries, chainEntries);

    // Opportunistic one-shot resolution of any still-pending EVM entry —
    // see resolvePendingEvmEntry()'s own comment. A pending Solana
    // TRANSFER still doesn't need this (the chain-history fetch above
    // supersedes it once it lands), but a pending Solana SWAP does
    // (prompt 0203 Revisi 1): a dropped swap never lands, so nothing ever
    // supersedes it — resolvePendingSwapEntry gives it the definitive
    // confirmed/failed/blockhash-expired verdict instead.
    if (network.accountType === ACCOUNT_TYPES.EVM) {
      await Promise.all(merged.filter((entry) => entry.status === 'pending').map((entry) => resolvePendingEvmEntry(networkKey, network, entry)));
    }
    if (network.accountType === ACCOUNT_TYPES.SOLANA) {
      await Promise.all(
        merged
          .filter((entry) => entry.type === 'swap' && entry.status === 'pending')
          .map((entry) => resolvePendingSwapEntry(networkKey, network, entry))
      );
      // Prompt 0205 (Revisi 1 pacing): opening Activity may ALWAYS retry
      // confirmed swaps still missing the REAL received amount — no
      // attempt ceiling on this on-demand surface — but at most a few
      // entries per open (and gap-spaced inside tryResolveRealReceived),
      // so an endpoint chain that doesn't retain an old transaction is
      // never flooded. The entry mutates in place, so THIS render already
      // shows the real number on success.
      await Promise.all(
        merged
          .filter((entry) => missingRealReceived(entry))
          .slice(0, MAX_REAL_AMOUNT_ENTRIES_PER_SURFACE)
          .map((entry) => tryResolveRealReceived(networkKey, entry))
      );

      // Prompt 0206: OLD swap entries stored with symbol "Unknown"
      // (pre-USDT-registry, pre-snapshot) get renamed AT RENDER TIME by
      // a mint lookup — custom token > built-in registry > snapshot —
      // on SHALLOW COPIES that replace the render-list slots, never on
      // the stored entries themselves (no destructive migration, and no
      // reliance on chrome.storage.get having cloned). Mints nothing
      // recognizes stay "Unknown", deliberately.
      if (merged.some((e) => e.type === 'swap' && (e.inputSymbol === 'Unknown' || e.outputSymbol === 'Unknown'))) {
        try {
          const customTokens = await getCustomTokens(networkKey);
          const registry = mergeTokens(networkKey, customTokens); // custom already wins inside mergeTokens
          const byMint = (await readTokenMetadataSnapshot()) || {};
          const resolveSymbol = (mint, current) => {
            if (current !== 'Unknown' || !mint) return current;
            const known = registry.find((t) => t.address === mint);
            return known?.symbol ?? byMint[mint]?.symbol ?? current;
          };
          for (let i = 0; i < merged.length; i++) {
            const e = merged[i];
            if (e.type !== 'swap') continue;
            const inputSymbol = resolveSymbol(e.inputMint, e.inputSymbol);
            const outputSymbol = resolveSymbol(e.outputMint, e.outputSymbol);
            if (inputSymbol !== e.inputSymbol || outputSymbol !== e.outputSymbol) {
              merged[i] = { ...e, inputSymbol, outputSymbol };
            }
          }
        } catch {
          // Naming is best-effort — the amounts are already correct.
        }
      }
    }

    const entries = merged.map((entry) => formatHistoryEntry(network, entry));
    return { networkKey, entries, chainHistoryError };
  },
  /**
   * Multi-account: lists every known account — accountsService's
   * {index, name} metadata joined with addresses re-derived fresh from
   * the in-memory seed via walletService.deriveAccountAddresses() (never
   * cached, so it can never drift from what the seed actually derives) —
   * plus which one is active. Backs the popup's account drawer.
   */
  FLUXIO_INTERNAL_GET_ACCOUNTS: async () => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    const { accounts, activeIndex } = await accountsService.getAccountsState();
    const withAddresses = accounts.map((account) => {
      const wallet = walletService.deriveAccountAddresses(account.index);
      return {
        index: account.index,
        name: account.name,
        solanaAddress: wallet.accounts.solana.address,
        evmAddress: wallet.accounts.evm.address
      };
    });
    return { accounts: withAddresses, activeIndex };
  },
  /**
   * Derives the next account index of the same seed, persists its
   * {index, name} metadata (name auto-assigned "Account N+1"), and
   * immediately makes it the active session account — "add" always means
   * "add and switch to it", matching the drawer's own "+" affordance
   * (Phantom-style: a new account is created already selected, not added
   * to a list you then have to separately pick).
   */
  FLUXIO_INTERNAL_ADD_ACCOUNT: async () => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    const entry = await accountsService.addAccountEntry();
    const wallet = await walletService.setActiveAccount(entry.index);
    await accountsService.setActiveAccountEntry(entry.index);
    return { index: entry.index, name: entry.name, wallet };
  },
  /** Pure metadata — no derivation/signing involved, still gated on unlocked for consistency with every other account-touching message here. */
  FLUXIO_INTERNAL_RENAME_ACCOUNT: async ({ index, name }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    return accountsService.renameAccountEntry(index, name);
  },
  /**
   * Switches which derived account the current session treats as active.
   * This is the one place that needed to change for balances, Send,
   * Receive, and dApp approval to all follow the newly active account —
   * every one of those already reads walletService.getPublicWallet()/
   * session.wallet fresh on each call (see walletService.setActiveAccount's
   * own comment), so none of them needed their own changes.
   */
  FLUXIO_INTERNAL_SET_ACTIVE_ACCOUNT: async ({ index }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    const wallet = await walletService.setActiveAccount(index);
    await accountsService.setActiveAccountEntry(index);
    return { wallet };
  },
  /**
   * Jupiter's verified-tag token list (prompt 0115) — read-only, cached
   * in-memory (see verifiedSwapTokensCache above) for this service
   * worker's lifetime rather than refetched on every Swap-screen open;
   * ~3900 entries as of this writing, no reason to re-fetch that
   * repeatedly within one session. Gated on unlocked for consistency
   * with every other FLUXIO_INTERNAL_* handler, even though this
   * specific data (a public token list, no address/balance involved) has
   * no real sensitivity of its own — same "runs through background.js
   * for a bundling reason, not a security one" note GET_BALANCE's own
   * comment already makes for its own non-sensitive data.
   */
  FLUXIO_INTERNAL_GET_SWAP_TOKENS: async ({ networkKey } = {}) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    // EVM branch (prompt 0219 tahap A; every EVM_SWAP_NETWORK_KEYS member
    // since 0227 — 0225 K1): no Jupiter verified list exists for EVM, and
    // per owner keputusan 0218 the receive side is native + registry +
    // custom, nothing else (no snapshot naming). The native entry uses
    // the popup-side 'native' marker; GET_SWAP_QUOTE maps it to Kyber's
    // sentinel.
    if (evmSwapService.isEvmSwapNetwork(networkKey)) {
      const custom = await getCustomTokens(networkKey);
      const merged = mergeTokens(networkKey, custom);
      return {
        tokens: [
          { address: 'native', symbol: NETWORKS[networkKey].nativeCurrency.symbol, name: NETWORKS[networkKey].nativeCurrency.name || NETWORKS[networkKey].nativeCurrency.symbol, decimals: 18 },
          ...merged.map((t) => ({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals }))
        ]
      };
    }
    if (!verifiedSwapTokensCache) {
      verifiedSwapTokensCache = await swapService.getVerifiedTokens();
    }
    // Prompt 0206 (owner decision 2-A + rem): snapshot the verified
    // list's NAMING metadata locally so the dashboard/Activity can name
    // tokens WITHOUT ever calling Jupiter themselves — written at most
    // once per 24h, best-effort, never blocking the response.
    try {
      await maybeStoreTokenMetadataSnapshot(verifiedSwapTokensCache);
    } catch {
      // Snapshot is a nicety — the swap screen must never fail over it.
    }
    return { tokens: verifiedSwapTokensCache };
  },
  /**
   * Real Jupiter quote for a Solana-mainnet-only swap (prompt 0115) —
   * Jupiter has no devnet/local-validator equivalent, so this message is
   * inherently mainnet-only and doesn't branch on networkKey the way
   * ESTIMATE_TRANSFER does; the popup only ever reaches this after its
   * own Swap-network picker has already confirmed 'solana' was chosen
   * (see popup.js's renderSwapNetworkPicker) — this handler doesn't
   * re-derive that choice, it just always resolves the session's own
   * Solana address, the same "never trust a client-supplied address"
   * rule every other handler here follows.
   *
   * `amount` is a human decimal string (popup.js can't do its own amount
   * math — same rule as every other handler); `inputDecimals`/
   * `outputDecimals` are passed BY the popup rather than re-resolved
   * here, unlike an address: decimals is a display/math value, not
   * something that decides whose funds an operation touches, and both
   * already originated from THIS session's own prior GET_BALANCE/
   * GET_TOKEN_BALANCES/GET_SWAP_TOKENS responses (popup.js is trusted
   * extension UI, not attacker-controlled input — the address-resolution
   * rule exists for a different reason: it's what a MALICIOUS website
   * could otherwise try to influence via SIGN_TRANSACTION, a concern
   * that doesn't apply to this file's own popup asking for a quote on
   * numbers it already has from us). `outputDecimals` specifically is
   * needed here (and ONLY here, not in the request itself — Jupiter's
   * own quote endpoint doesn't need it) so this handler can format
   * outAmount/minReceived into decimal strings before responding, same
   * "background pre-formats every amount, popup.js never does its own
   * decimal math" rule every other handler in this file already follows.
   *
   * Fee inclusion (prompt 0200, owner decision K2b): resolves a fee
   * account via swapService.resolveFeeAccount() — INPUT or OUTPUT side,
   * output wins (ExactIn semantics, live-proven in 0199) — and only ever
   * passes feeBps/feeAccount into getSwapQuote() when that resolves.
   * With SWAP_FEE_ACCOUNTS still empty this prompt, no quote requests a
   * fee, by construction (the owner fills the map in prompt 0201).
   *
   * Returns a quoteId (prompt 0200): the raw Jupiter quote object is
   * cached HERE, keyed by that id and bound to this session's own Solana
   * address — the popup never receives or returns a raw quote; see
   * swapQuoteCache's own comment. inputSymbol/outputSymbol ride along
   * (display strings from the popup's own prior token lists, same trust
   * note as inputDecimals above) so the eventual Activity entry can name
   * both assets without a second lookup.
   */
  FLUXIO_INTERNAL_GET_SWAP_QUOTE: async ({ networkKey, inputMint, outputMint, amount, inputDecimals, outputDecimals, slippageBps, inputSymbol, outputSymbol }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    // EVM branch (prompt 0219 tahap A; ethereum/base since 0227 — 0225
    // K1): quotes via KyberSwap. The popup's 'native' marker maps to
    // Kyber's sentinel HERE — the popup stays sentinel-ignorant. Any
    // other EVM network is refused with the same structured code the
    // picker already explains.
    if (evmSwapService.isEvmSwapNetwork(networkKey)) {
      const evmAmountRaw = parseUnits(amount, inputDecimals);
      const wallet = walletService.getPublicWallet();
      const { address } = walletService.getAccountForNetwork(wallet, networkKey);
      const quote = await evmSwapService.getEvmSwapQuote({
        networkKey,
        tokenIn: inputMint === 'native' ? evmSwapService.NATIVE_EVM_SENTINEL : inputMint,
        tokenOut: outputMint === 'native' ? evmSwapService.NATIVE_EVM_SENTINEL : outputMint,
        amountInRaw: evmAmountRaw
      });
      const { response } = cacheAndShapeEvmQuote({
        networkKey,
        quote,
        inputRef: inputMint,
        outputRef: outputMint,
        inputDecimals,
        outputDecimals,
        inputSymbol,
        outputSymbol,
        slippageBps,
        address
      });
      return response;
    }
    if (networkKey && networkKey !== 'solana') {
      throw new Error('SWAP_NETWORK_UNSUPPORTED: Swap is available on Solana, Ethereum, BNB Chain and Base.');
    }
    const amountRaw = parseUnits(amount, inputDecimals);
    const feeInfo = swapService.resolveFeeAccount(inputMint, outputMint, SWAP_FEE_ACCOUNTS_OVERRIDE || undefined);
    // Fee-account guard (prompt 0209, owner decision 1 — placement B):
    // a fee-carrying pair is verified BEFORE the quote is even requested,
    // so an invalid fee account is refused on the Swap screen itself,
    // without a Jupiter call. Only 'invalid' refuses; 'unverified' (RPC
    // trouble) proceeds per owner decision 2 — the feeAccount still goes
    // to Jupiter, so the fee can never be silently skipped. The VALID
    // cache makes the popup's 15s refresh free while the account is
    // healthy. Non-fee pairs skip this entirely (zero extra RPC).
    if (feeInfo) {
      const feeAccountStatus = await checkSwapFeeAccount(feeInfo);
      if (feeAccountStatus === 'invalid') {
        return { code: 'SWAP_FEE_ACCOUNT_UNAVAILABLE' };
      }
    }
    const quote = await swapService.getSwapQuote({
      inputMint,
      outputMint,
      amountRaw,
      slippageBps,
      feeBps: feeInfo ? swapService.SWAP_FEE_BPS : undefined,
      feeAccount: feeInfo ? feeInfo.feeAccount : undefined
    });

    // Caching + response shaping live in cacheAndShapeQuote() (prompt
    // 0205 Revisi 4 refactor — the fee-display correction of 0203
    // Revisi 3 moved there with it, one source of truth shared with
    // EXECUTE_SWAP's quote-changed path).
    const wallet = walletService.getPublicWallet();
    const { address } = walletService.getAccountForNetwork(wallet, 'solana');
    const { response } = cacheAndShapeQuote({
      quote,
      feeInfo,
      inputMint,
      outputMint,
      inputDecimals,
      outputDecimals,
      inputSymbol,
      outputSymbol,
      address
    });
    return response;
  },
  /**
   * Swap EXECUTION — real as of prompt 0200 (owner decisions K1a/K2b/K4a/
   * K5a; the 0115-era unconditional SWAP_EXECUTION_DISABLED guard is
   * replaced by the real conditions below, and the test that locked the
   * old guard — backgroundSendMainnetGate.e2e.test.js — was consciously
   * revised in the same prompt, not deleted). Machine-readable codes stay
   * EMBEDDED IN THE MESSAGE TEXT (SWAP_LOCKED / SWAP_NETWORK_UNSUPPORTED /
   * SWAP_QUOTE_EXPIRED / SWAP_SIMULATION_FAILED / SWAP_SEND_FAILED /
   * SWAP_BLOCKHASH_EXPIRED, plus the emergency SWAP_EXECUTION_DISABLED) —
   * same dispatcher-only-forwards-error.message reasoning as before.
   *
   * Flow (the mandated fence order): consume the quoteId (single-use,
   * bound to this session's own address — the popup NEVER sends a quote
   * object back) → build via Jupiter → identity fence (fee payer must be
   * the session address, exactly 1 required signature) BEFORE spending an
   * RPC call → simulateTransaction (sigVerify false, replaceRecentBlockhash
   * true; a non-null err aborts BEFORE signing, with the log tail in the
   * message and slippage-exceeded — custom error 0x1771 — called out) →
   * sign via walletService.signTransaction over message.serialize() (the
   * byte path proven against a real Jupiter v0+ALT transaction in 0199) →
   * broadcast (skipPreflight false, preflightCommitment confirmed,
   * maxRetries 3) → best-effort local Activity record (type 'swap', the
   * exact field names formatSwapHistoryEntry() has read since 0115) —
   * the record's 'pending' then advances via the existing TRANSFER_STATUS
   * piggyback or FLUXIO_INTERNAL_SWAP_STATUS below.
   */
  FLUXIO_INTERNAL_EXECUTE_SWAP: async ({ quoteId, networkKey }) => {
    if (!swapService.SWAP_EXECUTION_ENABLED) {
      throw new Error('SWAP_EXECUTION_DISABLED: Swap execution is not enabled in this build.');
    }
    if (!walletService.isUnlocked()) {
      throw new Error('SWAP_LOCKED: Wallet is locked.');
    }
    // Tahap B (prompt 0220; ethereum/base since 0227 — 0225 K1): the EVM
    // directions execute through their own guarded path — every pagar (a)
    // to (i) runs before the signer is reachable; token to token stays
    // refused inside.
    if (evmSwapService.isEvmSwapNetwork(networkKey)) {
      return executeEvmSwap({ quoteId, networkKey });
    }
    // Jupiter routes MAINNET liquidity only (swapService.js's own header)
    // — every other network, devnet/local included, is refused here with
    // a distinct code, mirroring the popup's own network picker.
    if (networkKey !== 'solana') {
      throw new Error('SWAP_NETWORK_UNSUPPORTED: Swap is available on Solana mainnet only.');
    }
    const wallet = walletService.getPublicWallet();
    const { address } = walletService.getAccountForNetwork(wallet, 'solana');

    // ---- Fresh quote at Confirm (prompt 0205 Revisi 4, owner opsi ii) ----
    // The displayed quote's ROUTE is frozen at quote time and can be up
    // to ~60s old when Confirm lands (the real incident: signature
    // 4bTgMW5… failed on chain inside a stale route's AMM; the retry's
    // fresh route succeeded). So EXECUTE re-quotes with the IDENTICAL
    // parameters first. PEEK (not take): a failed re-quote must leave the
    // displayed quote alive so the popup can return to Review and let the
    // user try again — the old quote itself can never execute without
    // passing this freshness gate, so it is never "reused" into a stale
    // execution.
    const displayed = peekSwapQuote(quoteId, address);
    if (!displayed) {
      throw new Error('SWAP_QUOTE_EXPIRED: The quote has expired. Refresh the quote and try again.');
    }
    // Second belt behind the networkKey fence above: an EVM-kind quote
    // can never flow into the Jupiter execute path, whatever the caller
    // claimed (prompt 0219 tahap A).
    if (displayed.kind === 'evm') {
      throw new Error('EVM_SWAP_NOT_AVAILABLE: Swaps on this network are not enabled yet. No funds moved.');
    }
    // Fee-account guard, second gate (prompt 0209, owner decision 1):
    // re-checked here because Confirm can land up to a minute after the
    // Swap screen's own check (the VALID cache usually answers from
    // memory). Same policy as GET_SWAP_QUOTE: only 'invalid' refuses,
    // 'unverified' proceeds to Jupiter. Nothing is signed either way.
    if (displayed.feeInfo) {
      const feeAccountStatus = await checkSwapFeeAccount(displayed.feeInfo);
      if (feeAccountStatus === 'invalid') {
        throw new Error('SWAP_FEE_ACCOUNT_UNAVAILABLE: The swap was not started because this pair is temporarily unavailable. Please try again later.');
      }
    }
    let freshQuote;
    try {
      freshQuote = await swapService.getSwapQuote({
        inputMint: displayed.inputMint,
        outputMint: displayed.outputMint,
        amountRaw: displayed.inAmountRaw,
        slippageBps: Number(displayed.raw.slippageBps ?? 50),
        feeBps: displayed.feeInfo ? swapService.SWAP_FEE_BPS : undefined,
        feeAccount: displayed.feeInfo ? displayed.feeInfo.feeAccount : undefined
      });
    } catch (err) {
      // Safest behavior (owner butir 2d): NEVER silently execute the old
      // quote — its route is exactly what the freshness gate exists to
      // distrust — and never guess. Structured, non-error return: the
      // popup goes back to Review (the displayed quoteId is still alive)
      // with a neutral try-again note; the user decides.
      return { requoteFailed: true };
    }

    // Silent-continue rule (owner butir 2b): the fresh outAmount must be
    // at least the DISPLAYED outAmount minus 0.1%. BigInt, no floats.
    const freshOk = freshQuote.outAmountRaw * 1000n >= displayed.outAmountRaw * 999n;
    if (!freshOk) {
      // Owner butir 2c: do NOT sign. Kill the old id, cache the fresh
      // quote under a NEW id, and hand the popup the same response shape
      // GET_SWAP_QUOTE returns so Review re-renders with live numbers.
      takeSwapQuote(quoteId, address); // old id dies here — it can never be replayed
      const { response } = cacheAndShapeQuote({
        quote: freshQuote,
        feeInfo: displayed.feeInfo,
        inputMint: displayed.inputMint,
        outputMint: displayed.outputMint,
        inputDecimals: displayed.inputDecimals,
        outputDecimals: displayed.outputDecimals,
        inputSymbol: displayed.inputSymbol,
        outputSymbol: displayed.outputSymbol,
        address
      });
      return { quoteChanged: true, code: 'SWAP_QUOTE_CHANGED', quote: response };
    }

    // Fresh quote is good — NOW consume the id (single-use gate: a double
    // Confirm's second call finds nothing and gets SWAP_QUOTE_EXPIRED;
    // the 0203 in-flight state fence stays as-is downstream).
    const entry = takeSwapQuote(quoteId, address);
    if (!entry) {
      throw new Error('SWAP_QUOTE_EXPIRED: The quote has expired. Refresh the quote and try again.');
    }
    // Everything executed/recorded from here uses the FRESH quote's
    // numbers (owner butir 2f); mints/decimals/symbols are the same pair.
    const execFeeAmountRaw = entry.feeInfo
      ? swapService.computePlatformFeeDisplayRaw({
          feeSide: entry.feeInfo.feeSide,
          feeBps: swapService.SWAP_FEE_BPS,
          inAmountRaw: freshQuote.inAmountRaw,
          quoteFeeAmountRaw: freshQuote.feeAmountRaw
        })
      : null;

    let build;
    try {
      build = await swapService.buildSwapTransaction({
        quoteResponse: freshQuote.raw,
        userPublicKey: address,
        feeAccount: entry.feeInfo ? entry.feeInfo.feeAccount : undefined
      });
    } catch (err) {
      // Owner decision 2 (TAMBAHAN WAJIB): a failed Jupiter build on a
      // fee pair re-checks the fee account ONCE, cache bypassed. If the
      // account is invalid — or can't be verified — the failure the user
      // sees is the honest fee-account message, not the technical
      // SWAP_SEND_FAILED text (this closes the reviewer-flagged gap of
      // opsi ii: without it, an RPC-blind check followed by a Jupiter
      // rejection surfaced as raw build-error jargon). A VALID re-check
      // means the build failed for some other reason, and the original
      // classification stands. Nothing was signed on any of these paths.
      if (entry.feeInfo) {
        const recheck = await checkSwapFeeAccount(entry.feeInfo, { bypassCache: true });
        if (recheck !== 'valid') {
          throw new Error('SWAP_FEE_ACCOUNT_UNAVAILABLE: The swap was not started because this pair is temporarily unavailable. Please try again later.');
        }
      }
      throw new Error(`SWAP_SEND_FAILED: Could not build the swap transaction: ${err?.message || 'unknown error'}`);
    }

    // Fence (a): identity, before any RPC is spent on this transaction.
    let inspected;
    try {
      inspected = transactionService.inspectSerializedTransaction({ transactionBase64: build.swapTransactionBase64 });
    } catch (err) {
      throw new Error(`SWAP_SEND_FAILED: ${err?.message || 'Could not read the swap transaction.'}`);
    }
    if (inspected.feePayer !== address || inspected.numRequiredSignatures !== 1) {
      throw new Error(
        `SWAP_SEND_FAILED: The built transaction failed the identity fence (fee payer ${inspected.feePayer}, ${inspected.numRequiredSignatures} required signatures). Refusing to sign.`
      );
    }

    // Fence (b): pre-sign simulation. A non-null err is a hard stop.
    const sim = await transactionService.simulateSerializedTransaction({
      network: 'solana',
      transactionBase64: build.swapTransactionBase64
    });
    if (sim.err != null) {
      const errText = typeof sim.err === 'string' ? sim.err : JSON.stringify(sim.err);
      const logTail = sim.logs.slice(-6).join(' | ');
      const slippageNote = /0x1771|6001/.test(`${errText} ${logTail}`) ? 'Price moved beyond your slippage. ' : '';
      // Prompt 0205 koreksi d: `InsufficientFundsForRent` is a DISTINCT
      // top-level TransactionError name (deterministic to match, unlike
      // a program's ambiguous Custom:1) — the exact failure a MAX swap
      // into a token without its ATA used to hit with no explanation.
      const rentNote = /InsufficientFundsForRent/.test(errText) ? 'Not enough SOL to cover the network fee and account rent. ' : '';
      throw new Error(`SWAP_SIMULATION_FAILED: ${rentNote}${slippageNote}Simulation error: ${errText}${logTail ? ` (logs: ${logTail})` : ''}`);
    }

    let signature;
    let explorerUrl;
    let rawTransactionBase64;
    try {
      ({ signature, explorerUrl, rawTransactionBase64 } = await transactionService.signAndSendSerializedTransaction({
        network: 'solana',
        transactionBase64: build.swapTransactionBase64,
        expectedFeePayer: address,
        sign: (messageBytes) => walletService.signTransaction('solana', messageBytes),
        maxRetries: 3
      }));
    } catch (err) {
      throw new Error(`SWAP_SEND_FAILED: ${err?.message || 'Broadcasting the swap failed.'}`);
    }

    // Local Activity record — best-effort, same rule as every send: a
    // storage failure must never make a successful broadcast look failed.
    try {
      await recordLocalTransaction({
        networkKey: 'solana',
        type: 'swap',
        signatureOrHash: signature,
        inputMint: entry.inputMint,
        inputSymbol: entry.inputSymbol,
        inputAmountRaw: freshQuote.inAmountRaw.toString(),
        inputDecimals: entry.inputDecimals,
        outputMint: entry.outputMint,
        outputSymbol: entry.outputSymbol,
        // The FRESH quote's numbers (prompt 0205 Revisi 4): what was
        // actually executed, not the possibly older displayed estimate.
        outputAmountRaw: freshQuote.outAmountRaw.toString(),
        outputDecimals: entry.outputDecimals,
        otherAmountThresholdRaw: freshQuote.minReceivedRaw.toString(),
        platformFee: entry.feeInfo
          ? { feeBps: freshQuote.feeBps ?? entry.feeBps, amountRaw: execFeeAmountRaw != null ? execFeeAmountRaw.toString() : null, side: entry.feeInfo.feeSide }
          : null,
        timestamp: Date.now(),
        status: 'pending',
        lastValidBlockHeight: build.lastValidBlockHeight
      });
    } catch {
      // Non-fatal — see comment above.
    }

    // Re-broadcast loop (prompt 0203 Revisi 1): persist the active-swap
    // state to chrome.storage.session, arm the safety-net alarm, and kick
    // the loop — all best-effort AFTER the broadcast already succeeded (a
    // storage/alarm failure must never make a successful send look
    // failed, same rule as the Activity record above). The signed bytes
    // stay server-side only — never returned to the popup.
    try {
      await writeActiveSwap({
        networkKey: 'solana',
        signature,
        rawTransactionBase64,
        lastValidBlockHeight: build.lastValidBlockHeight,
        startedAt: Date.now(),
        attempts: 0,
        summary: {
          inputSymbol: entry.inputSymbol,
          outputSymbol: entry.outputSymbol,
          inputAmountRaw: freshQuote.inAmountRaw.toString(),
          inputDecimals: entry.inputDecimals,
          outputAmountRaw: freshQuote.outAmountRaw.toString(),
          outputDecimals: entry.outputDecimals
        }
      });
      chrome.alarms.create(SWAP_REBROADCAST_ALARM_NAME, { periodInMinutes: 0.5 });
      ensureSwapRebroadcastLoop();
    } catch {
      // Non-fatal — the sweep/piggyback still owns the final verdict.
    }

    return {
      signature,
      explorerUrl,
      prioritizationFeeLamports: build.prioritizationFeeLamports,
      computeUnitLimit: build.computeUnitLimit,
      lastValidBlockHeight: build.lastValidBlockHeight
    };
  },
  /**
   * Review-screen fee preview (prompt 0200 fase 2): a REAL Jupiter /swap
   * build for the cached quote so Review shows the actual network fee
   * (base 5000 + the build's own prioritizationFeeLamports — 0199 proved
   * the old fixed 5000-lamport label was a 10-20x underestimate). The
   * quoteId is PEEKED, never consumed — the later EXECUTE_SWAP re-builds
   * with a fresh blockhash and still owns the id. Costs one extra Jupiter
   * call per Review visit (2 per executed swap, well inside the keyless
   * 30/min tier).
   */
  FLUXIO_INTERNAL_PREVIEW_SWAP_FEES: async ({ quoteId }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('SWAP_LOCKED: Wallet is locked.');
    }
    const wallet = walletService.getPublicWallet();
    const { address } = walletService.getAccountForNetwork(wallet, 'solana');
    let entry = peekSwapQuote(quoteId, address);
    if (!entry) {
      // An EVM quote is bound to the session's EVM address (prompt 0219)
      // — same "never trust a client-supplied address" rule, further
      // lookups still this session's own derivations. 0227 (0225 K1): the
      // lookup walks EVERY EVM swap network instead of a 'bnb' literal —
      // one shared EVM account means the addresses coincide today, but
      // the cached entry's own networkKey is what the preview then reads.
      for (const evmKey of evmSwapService.EVM_SWAP_NETWORK_KEYS) {
        const evmAddress = walletService.getAccountForNetwork(wallet, evmKey).address;
        entry = peekSwapQuote(quoteId, evmAddress);
        if (entry) break;
      }
    }
    if (!entry) {
      throw new Error('SWAP_QUOTE_EXPIRED: The quote has expired. Refresh the quote and try again.');
    }
    // EVM preview (prompt 0219, tahap A): display-only fee ceiling from
    // the product RPC path — floor(gasEstimate × 1,2) × (baseFee × 2 +
    // tip), the exact Send-screen math 0213 proved on chain. No build,
    // no rent concept, no priority-fee feedback.
    if (entry.kind === 'evm') {
      // Tahap C (prompt 0223, owner K3): a token-in quote previews TWO
      // ceilings — the approve's from a LIVE estimateGas on the real
      // approve calldata (x1,2), the swap's from the quote's own gas
      // figure x2 (a swap simulation cannot run before the approve
      // lands, so the stand-in must be a genuine upper bound). The x2 was
      // x1,5 until 0223 Revisi 3's real incident: Kyber's quote gas said
      // 268.831 while the REAL eth_estimateGas with a live allowance
      // measured 337.372, so the execute-side gasLimit (x1,2 buffer =
      // 404.846) landed 0,4% ABOVE the displayed x1,5 ceiling (403.246)
      // and g2 bounced every Confirm back as SWAP_QUOTE_CHANGED with
      // identical numbers (gejala B). Both ceilings are stored on the
      // quote and enforced PER TRANSACTION by g2. When the live allowance
      // already covers the amount, only the swap ceiling exists (the
      // approve leg will be skipped, K1).
      if (entry.inputRef !== 'native') {
        const evmAddr = walletService.getAccountForNetwork(wallet, entry.networkKey).address;
        const [{ maxFeePerGas, baseFeePerGas }, allowance] = await Promise.all([
          evmSwapService.getEvmFeePerGas({ networkKey: entry.networkKey }),
          evmSwapService.getErc20Allowance({ networkKey: entry.networkKey, tokenAddress: entry.inputRef, owner: evmAddr, spender: entry.routerAddress })
        ]);
        const approveNeeded = allowance < entry.inAmountRaw;
        // 0227 (0225 K8): a PARTIAL live allowance adds the reset leg
        // (approve 0) in front — see startEvmTokenInApprove. Three
        // ceilings then sum into the one displayed total, each enforced
        // per transaction by g2.
        const resetNeeded = approveNeeded && allowance > 0n;
        let approveMaxFeeWei = 0n;
        let resetMaxFeeWei = 0n;
        if (resetNeeded) {
          // approve(0) can ALWAYS be simulated (it never trips the
          // reduce-to-zero rule); approve(amountIn) CANNOT while the live
          // allowance is non-zero (USDT-class reverts), so the real
          // approve's ceiling is a stand-in: the measured reset estimate
          // x2 — the same measured-upper-bound family as the swap's own
          // x2 stand-in (0223 Revisi 3 / lesson 12), since an ERC-20
          // approve's gas is flat per contract and setting a non-zero
          // value never costs twice a zeroing write.
          const resetCalldata = evmSwapService.buildErc20ApproveCalldata({ spender: entry.routerAddress, amountRaw: 0n });
          const resetGas = await evmSwapService.estimateEvmGas({ networkKey: entry.networkKey, from: evmAddr, to: entry.inputRef, valueRaw: 0n, data: resetCalldata });
          resetMaxFeeWei = ((resetGas * 12n) / 10n) * maxFeePerGas;
          approveMaxFeeWei = (resetGas * 2n) * maxFeePerGas;
        } else if (approveNeeded) {
          const approveCalldata = evmSwapService.buildErc20ApproveCalldata({ spender: entry.routerAddress, amountRaw: entry.inAmountRaw });
          const approveGas = await evmSwapService.estimateEvmGas({ networkKey: entry.networkKey, from: evmAddr, to: entry.inputRef, valueRaw: 0n, data: approveCalldata });
          approveMaxFeeWei = ((approveGas * 12n) / 10n) * maxFeePerGas;
        }
        const swapMaxFeeWei = (entry.gasEstimate * 2n) * maxFeePerGas;
        entry.displayedResetMaxFeeWei = resetNeeded ? resetMaxFeeWei.toString() : null;
        entry.displayedApproveMaxFeeWei = approveNeeded ? approveMaxFeeWei.toString() : null;
        entry.displayedSwapMaxFeeWei = swapMaxFeeWei.toString();
        // 0231 Revisi 2 K3 — forensik ikut entry lalu state: setiap halt
        // kelak menyebut dari mana angka Review dihitung (tanpa menebak).
        entry.previewForensics = {
          previewedAt: Date.now(),
          baseFeePerGas: String(baseFeePerGas ?? ''),
          maxFeePerGas: String(maxFeePerGas),
          swapGasLimit: String(entry.gasEstimate * 2n),
          approveMaxFeeWei: approveNeeded ? approveMaxFeeWei.toString() : null,
          resetMaxFeeWei: resetNeeded ? resetMaxFeeWei.toString() : null
        };
        // 0227 Revisi 1 K2: on an op-stack network (base) the DISPLAYED
        // total also carries the estimated L1 data fee for the swap leg
        // (the approve legs' tiny calldata makes their L1 share
        // negligible — deliberately skipped). The per-leg gas ceilings
        // stored above stay gas-only: that is what pickSignedMaxFeePerGas
        // enforces per transaction; the L1 fee is charged OUTSIDE
        // gasLimit × maxFeePerGas (0226-proven) and rides here so the
        // user-facing number stops understating the real total.
        const l1FeeWei = await previewEvmSwapL1FeeWei(entry, evmAddr, { gasLimit: entry.gasEstimate * 2n, maxFeePerGas, valueRaw: 0n });
        const totalMaxFeeWei = resetMaxFeeWei + approveMaxFeeWei + swapMaxFeeWei + l1FeeWei;
        return {
          kind: 'evm',
          tokenIn: true,
          approveNeeded,
          approveResetNeeded: resetNeeded,
          nativeSymbol: NETWORKS[entry.networkKey].nativeCurrency.symbol,
          resetMaxFeeWei: String(resetMaxFeeWei),
          approveMaxFeeWei: String(approveMaxFeeWei),
          swapMaxFeeWei: String(swapMaxFeeWei),
          l1FeeWei: String(l1FeeWei),
          maxFeeWei: String(totalMaxFeeWei),
          maxFeeFormatted: formatUnits(totalMaxFeeWei, 18)
        };
      }
      const fees = await evmSwapService.estimateEvmSwapFeeWei({ networkKey: entry.networkKey, gasEstimate: entry.gasEstimate });
      // Pagar (g2), prompt 0220 Revisi 3 (owner keputusan 1; CONSTRUCTIVE
      // since 0227 Revisi 1): the number this preview puts on the Review
      // screen is remembered on the cached quote, and EXECUTE enforces it
      // by CUTTING the signed maxFeePerGas to it (pickSignedMaxFeePerGas)
      // — the user never pays above what Review showed; only gas that
      // truly rose past the inclusion floor still refuses. Same principle
      // as Solana's 0206 "Network fee (max)" hard cap.
      entry.displayedMaxFeeWei = fees.maxFeeWei.toString();
      // 0227 Revisi 1 K2: the displayed figure on an op-stack network
      // (base) adds the estimated L1 data fee over the REAL build
      // calldata; the stored gas ceiling above stays gas-only (see the
      // token-in comment). Oracle networks are detected by CONSTANT —
      // ethereum/bnb never make this call.
      const evmAddrNative = walletService.getAccountForNetwork(wallet, entry.networkKey).address;
      const l1FeeWeiNative = await previewEvmSwapL1FeeWei(entry, evmAddrNative, { gasLimit: fees.gasLimit, maxFeePerGas: fees.maxFeePerGas, valueRaw: entry.inAmountRaw });
      const displayTotalWei = fees.maxFeeWei + l1FeeWeiNative;
      return {
        kind: 'evm',
        nativeSymbol: NETWORKS[entry.networkKey].nativeCurrency.symbol,
        gasLimit: String(fees.gasLimit),
        maxFeePerGas: String(fees.maxFeePerGas),
        l1FeeWei: String(l1FeeWeiNative),
        maxFeeWei: String(displayTotalWei),
        maxFeeFormatted: formatUnits(displayTotalWei, 18)
      };
    }
    const build = await swapService.buildSwapTransaction({
      quoteResponse: entry.raw,
      userPublicKey: address,
      feeAccount: entry.feeInfo ? entry.feeInfo.feeAccount : undefined
    });
    const priority = build.prioritizationFeeLamports ?? 0;

    // Prompt 0205 bagian A — the "New token account rent" row. Detection
    // is LOCAL (zero RPC): the build Jupiter just returned includes the
    // output ATA's CreateIdempotent instruction ONLY when that account
    // doesn't exist (live-proven, see detectNewAtaCreation). Fail SAFE
    // per owner decision: a parse failure means status 'unknown' and the
    // row shows "may apply"; a missing rent AMOUNT likewise — a
    // hardcoded rent figure must never be displayed (the old 2,039,280
    // constant was proven stale against the chain's real 1,488,440).
    let newTokenAccountRent = { status: 'unknown', approx: false, rentLamports: null, rentSolFormatted: null };
    try {
      const detection = transactionService.detectNewAtaCreation({
        transactionBase64: build.swapTransactionBase64,
        ownerAddress: address,
        outputMint: entry.outputMint
      });
      if (!detection.createsOutputAta) {
        newTokenAccountRent = { status: 'none', approx: false, rentLamports: null, rentSolFormatted: null };
      } else {
        newTokenAccountRent = { status: 'required', approx: detection.tokenProgram === 'token-2022', rentLamports: null, rentSolFormatted: null };
      }
    } catch {
      // deserialization/parsing failed — 'unknown' -> "may apply".
    }
    // Live rent (cached per worker life) — fetched even when no new ATA
    // is needed, so the popup's MAX reserve always has a LIVE figure
    // instead of its conservative fallback. A Token-2022 mint with
    // extensions can cost slightly more than the 165-byte figure — the
    // popup prefixes "~" for those (approx flag above).
    let tokenAccountRentLamports = null;
    try {
      const rent = await getCachedTokenAccountRentLamports();
      tokenAccountRentLamports = rent.toString();
      if (newTokenAccountRent.status === 'required') {
        newTokenAccountRent.rentLamports = rent.toString();
        newTokenAccountRent.rentSolFormatted = formatUnits(rent, 9);
      }
    } catch {
      // rent amount unavailable — a 'required' row shows "may apply".
    }

    return {
      prioritizationFeeLamports: build.prioritizationFeeLamports,
      computeUnitLimit: build.computeUnitLimit,
      lastValidBlockHeight: build.lastValidBlockHeight,
      networkFeeLamports: 5000 + priority,
      networkFeeSolFormatted: formatUnits(BigInt(5000 + priority), 9),
      newTokenAccountRent,
      tokenAccountRentLamports
    };
  },
  /**
   * Swap-specific confirmation poll (prompt 0200): the existing
   * TRANSFER_STATUS path plus the one thing a swap needs that a plain
   * send's poll loop doesn't have — a DEFINITIVE expiry verdict. A v0
   * transaction can never land once the chain's block height passes the
   * build response's own lastValidBlockHeight, so "still not found past
   * that height" is a final failure (SWAP_BLOCKHASH_EXPIRED, local record
   * advanced to 'failed'), not an endless 'pending'. Read-only otherwise;
   * reuses getTransactionStatus + the same finalLocalStatusFor piggyback.
   */
  FLUXIO_INTERNAL_SWAP_STATUS: async ({ signature, lastValidBlockHeight, networkKey }) => {
    // EVM branch (tahap B, prompt 0220): receipt-based, no expiry class —
    // a missing receipt is honestly 'pending', never a verdict.
    if (networkKey && networkKey !== 'solana') {
      // Tahap C: the staged state's stage rides on the response when the
      // polled hash belongs to the active staged swap (approve or swap leg).
      let stage = null;
      let haltDetail = null;
      try {
        const active = await readActiveSwap();
        if (active && (active.signature === signature || active.approveHash === signature || active.resetHash === signature)) {
          stage = active.stage || null;
          haltDetail = active.haltDetail || null; // 0228 Revisi 1 K2 — forensik saja
        }
      } catch {
        // Best-effort display field.
      }
      const receipt = await evmSwapService.getEvmTransactionReceipt({ networkKey, hash: signature });
      if (!receipt) {
        return { status: 'pending', err: null, expired: false, receivedRealRaw: null, receivedRealFormatted: null, stage, haltDetail };
      }
      const ok = receipt.status === '0x1';
      try {
        await updateLocalTransactionStatus(networkKey, signature, ok ? 'confirmed' : 'failed');
      } catch {
        // Best-effort — the poll result is still returned.
      }
      let receivedRealRaw = null;
      let receivedRealFormatted = null;
      if (ok) {
        try {
          const entry = (await getLocalTransactions(networkKey)).find((e) => e.signatureOrHash === signature);
          if (entry && entry.type === 'swap') {
            await tryResolveRealReceivedEvm(networkKey, entry);
            if (entry.receivedRealRaw != null) {
              receivedRealRaw = entry.receivedRealRaw;
              receivedRealFormatted = formatUnits(BigInt(entry.receivedRealRaw), entry.outputDecimals);
            }
          }
        } catch {
          // Best-effort — the estimate keeps showing.
        }
      }
      return { status: ok ? 'confirmed' : 'failed', err: ok ? null : { reverted: true }, expired: false, receivedRealRaw, receivedRealFormatted, stage, haltDetail };
    }
    const network = NETWORKS['solana'];
    const result = await transactionService.getTransactionStatus({ network: 'solana', signature });
    const finalStatus = finalLocalStatusFor(network, result);
    if (finalStatus) {
      try {
        await updateLocalTransactionStatus('solana', signature, finalStatus);
      } catch {
        // Best-effort — the poll result is still returned regardless.
      }
      // Prompt 0205: a confirmed swap's response also carries the REAL
      // received amount once obtainable — fetched/parsed here (attempt-
      // capped, never affecting the verdict above), formatted at the
      // entry's own output decimals so the popup renders it verbatim.
      let receivedRealRaw = null;
      let receivedRealFormatted = null;
      if (finalStatus === 'confirmed') {
        try {
          const entry = (await getLocalTransactions('solana')).find((e) => e.signatureOrHash === signature);
          if (entry && entry.type === 'swap') {
            await tryResolveRealReceived('solana', entry, { attemptLimit: MAX_REAL_AMOUNT_POLL_ATTEMPTS });
            if (entry.receivedRealRaw != null) {
              receivedRealRaw = entry.receivedRealRaw;
              receivedRealFormatted = formatUnits(BigInt(entry.receivedRealRaw), entry.outputDecimals);
            }
          }
        } catch {
          // Best-effort — the estimate keeps showing.
        }
      }
      return { ...result, expired: false, receivedRealRaw, receivedRealFormatted };
    }
    if (result.status === 'not_found' && lastValidBlockHeight != null) {
      // Trusted-height (or time-backup) verdict only — see
      // isSwapDefinitivelyExpired (prompt 0203 Revisi 2). sentAtMs comes
      // from the local Activity entry's own send-time timestamp.
      let sentAtMs = null;
      try {
        const localEntry = (await getLocalTransactions('solana')).find((e) => e.signatureOrHash === signature);
        sentAtMs = localEntry?.timestamp ?? null;
      } catch {
        // Best-effort — without it the time backup simply can't fire.
      }
      const expired = await isSwapDefinitivelyExpired({ lastValidBlockHeight, sentAtMs });
      if (expired) {
        try {
          await updateLocalTransactionStatus('solana', signature, 'failed', { failureCode: 'SWAP_BLOCKHASH_EXPIRED' });
        } catch {
          // Best-effort, as above.
        }
        return { ...result, expired: true, code: 'SWAP_BLOCKHASH_EXPIRED' };
      }
    }
    return { ...result, expired: false };
  },
  /**
   * Active re-broadcast state for the popup (prompt 0203 Revisi 1): the
   * Swapping screen polls this for its "Sending… retry n" line, and the
   * call itself doubles as the popup-open resume path — a popup opening
   * after the service worker restarted wakes the worker with this
   * message, and the handler restarts the loop if a swap is still
   * active. Returns display fields only, never the signed bytes. No
   * unlock gate: nothing here is more sensitive than the alarm settings
   * (a signature + amounts already shown on screen), and the resume must
   * work even before the user re-unlocks.
   */
  FLUXIO_INTERNAL_GET_ACTIVE_SWAP: async () => {
    const state = await readActiveSwap();
    if (!state) {
      return { active: false };
    }
    // A halted tahap C record is terminal UI info — it expires after its
    // own window so a popup reopened much later never resurrects it.
    if (state.stage === 'halted' && state.haltedAt && Date.now() - state.haltedAt > evmSwapService.EVM_SWAP_PENDING_TIMEOUT_MS) {
      await clearActiveSwap();
      return { active: false };
    }
    ensureSwapRebroadcastLoop();
    return {
      active: true,
      kind: state.kind || 'solana',
      networkKey: state.networkKey || 'solana',
      signature: state.signature,
      attempts: state.attempts || 0,
      startedAt: state.startedAt,
      lastValidBlockHeight: state.lastValidBlockHeight,
      summary: state.summary || null,
      // Tahap C (prompt 0223): the two-step popup screen drives itself off
      // these — display fields only, never the signed bytes.
      stage: state.stage || null,
      haltReason: state.haltReason || null,
      // 0228 Revisi 1 K2: forensik saja — popup tidak menampilkannya.
      haltDetail: state.haltDetail || null,
      approveHash: state.approveHash || null,
      // 0227 (0225 K8): the reset leg's own hash — display only; the
      // popup derives its three-step labels from this being present.
      resetHash: state.resetHash || null,
      swapHash: state.swapHash || null,
      explorerUrl: state.explorerUrl || null
    };
  },
  /** Read-only — the Settings screen's current-value display. No unlock gate: knowing the CONFIGURED duration isn't sensitive (unlike, say, a balance), and the wallet doesn't need to be unlocked to view/change this preference. */
  FLUXIO_INTERNAL_GET_AUTO_LOCK: async () => {
    return { minutes: await getAutoLockMinutes() };
  },
  /**
   * Persists a new auto-lock duration and reprograms the alarm immediately
   * (see reprogramAutoLockAlarm's own comment for why this call, not just
   * the next natural service-worker restart, is what makes "changes apply
   * instantly" true). Same no-unlock-gate reasoning as GET_AUTO_LOCK above.
   */
  FLUXIO_INTERNAL_SET_AUTO_LOCK: async ({ minutes }) => {
    if (!AUTO_LOCK_OPTIONS_MINUTES.includes(minutes)) {
      throw new Error(`Invalid auto-lock duration: ${minutes}`);
    }
    await setAutoLockMinutes(minutes);
    await reprogramAutoLockAlarm();
    return { minutes };
  },
  /** Read-only — the Settings screen's current-value display. No unlock gate, same reasoning as GET_AUTO_LOCK: the CONFIGURED currency isn't sensitive. */
  FLUXIO_INTERNAL_GET_CURRENCY: async () => {
    return { currency: await getPortfolioCurrency() };
  },
  /**
   * Persists a new currency preference AND invalidates the cached total
   * (its own real side effect, the reason this goes through a message
   * rather than a direct chrome.storage.local write from popup.js/
   * settings.js the way the Developer-networks toggle does — same
   * "auto-lock has a real side effect only background.js can perform"
   * reasoning as SET_AUTO_LOCK above). The cached PRICE snapshot is
   * deliberately NOT cleared — it already holds every supported
   * currency's price (see resolvePortfolioPrices/ALL_SUPPORTED_CURRENCY_CODES),
   * so a currency switch never needs a new CoinGecko call, only
   * recomputing the total from already-cached prices in the new
   * currency, which the caller (popup.js) does by immediately following
   * this with a FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE call.
   */
  FLUXIO_INTERNAL_SET_CURRENCY: async ({ currency }) => {
    if (!isSupportedCurrency(currency)) {
      throw new Error(`Unsupported currency: ${currency}`);
    }
    const normalized = currency.toLowerCase();
    await setPortfolioCurrency(normalized);
    return { currency: normalized };
  },
  /**
   * The popup account card's big fiat total (prompt 0118). Requires an
   * unlocked session (needs this wallet's own addresses to fetch
   * balances) — unlike GET_AUTO_LOCK/GET_CURRENCY above, this one
   * genuinely can't answer anything meaningful while locked. Always
   * resolves fresh balances (see fetchMainnetBalancesForPortfolio's own
   * comment on why balances are never reused from elsewhere) but only
   * ever makes AT MOST one CoinGecko call, gated by
   * resolvePortfolioPrices()'s own cache/rate-limit logic — this is the
   * one and only round trip popup.js needs for the whole feature ("satu
   * round-trip untuk popup", the spec's own words): balances, prices, and
   * the final sum are all resolved and computed here, not spread across
   * several messages.
   */
  FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE: async () => {
    if (!walletService.isUnlocked()) {
      throw new Error('Wallet is locked.');
    }
    const wallet = walletService.getPublicWallet();
    const currency = await getPortfolioCurrency();

    const [perNetwork, prices] = await Promise.all([fetchMainnetBalancesForPortfolio(wallet), resolvePortfolioPrices()]);

    const result = computePortfolioTotal({ perNetwork, pricesByCoinId: prices.pricesByCoinId, currency });
    const response = {
      totalFormatted: result.totalFormatted,
      hasExcludedAssets: result.hasExcludedAssets,
      currency: result.currency,
      stale: prices.stale
    };

    // Cache the ready-to-render result for the NEXT popup open's instant
    // display (see PORTFOLIO_TOTAL_CACHE_STORAGE_KEY's own comment in
    // shared/messaging.js) — best-effort: a cache-write failure must
    // never fail the response the popup is actively waiting on.
    try {
      await setCachedTotal({
        totalFormatted: response.totalFormatted,
        hasExcludedAssets: response.hasExcludedAssets,
        computedAt: Date.now()
      });
    } catch {
      // Non-fatal — see comment above.
    }

    return response;
  },
  FLUXIO_INTERNAL_APPROVE: async ({ id }) => {
    if (!walletService.isUnlocked()) {
      throw new Error('Cannot approve: wallet is locked.');
    }
    approveRequest(id, { approved: true });
    return { ok: true };
  },
  FLUXIO_INTERNAL_REJECT: async ({ id }) => {
    rejectRequest(id, 'User rejected the request.');
    return { ok: true };
  },
  /**
   * No unlock gate — announcements are public content, same as the Auto
   * Lock/Currency settings above; nothing here is specific to any one
   * account or session. Always triggers a throttle-gated fetch attempt
   * first (a no-op most of the time — see fetchAndMergeNotifications()'s
   * own throttle) so the caller gets the freshest state this exact call
   * is allowed to produce, in one round trip, never a stale response
   * followed by a separate "did anything change" check.
   */
  FLUXIO_INTERNAL_GET_NOTIFICATIONS: async () => {
    return fetchAndMergeNotifications({ fromAlarm: false });
  },
  /**
   * Marks every CURRENTLY CACHED announcement as read, in one call —
   * chosen over a per-item mark-on-click as the simpler of the two
   * options this feature's own spec explicitly allowed either of (see
   * prompt/0170-extension-notifications-inbox.md's own DESAIN section):
   * opening the Notifications screen already implies the whole list was
   * just seen, and per-item tracking would need its own click handler on
   * every row for no real behavioral benefit here (an inbox this small
   * has no long-scroll case where "seen the top, not the bottom" would
   * meaningfully differ from "opened the screen"). Recomputes and applies
   * the badge immediately, so the dot/count disappears in the same tick
   * the popup already re-renders after this call resolves.
   */
  FLUXIO_INTERNAL_MARK_NOTIFICATIONS_READ: async () => {
    const current = await getNotificationsState();
    const allIds = current.announcements.map((a) => a.id);
    const next = { ...current, readIds: allIds };
    await setNotificationsState(next);
    await updateNotificationsBadge(next);
    return next;
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, requestId } = message || {};
  if (typeof type !== 'string') return false;

  if (DAPP_MESSAGE_TYPES.has(type)) {
    if (typeof requestId !== 'string' || !requestId) return false;
    const origin = sender?.tab ? safeOrigin(sender.origin || sender.url) : null;
    if (!origin) {
      sendResponse({ requestId, error: 'Rejected: request has no verifiable page origin.' });
      return false;
    }
    // Hydrate first — this message may be the first thing this worker
    // instance has seen since a restart, and dappRequestHandlers (via
    // currentAccountSummary(), used while building the CONNECT/SIGN_*
    // approval-window summary) reads walletService.isUnlocked()/
    // getPublicWallet() directly. Chained (not fired in parallel) so
    // hydration always completes before the handler runs — see
    // walletService.js's own hydrateSessionIfNeeded() comment.
    walletService.hydrateSessionIfNeeded()
      .then(() => dappRequestHandlers[type]({ payload: message.payload, origin }))
      .then((response) => sendResponse({ requestId, response }))
      .catch((error) => sendResponse({ requestId, error: error?.message || 'Unknown error' }));
    return true;
  }

  if (INTERNAL_MESSAGE_TYPES.has(type)) {
    if (!isTrustedInternalSender(sender)) {
      sendResponse({ requestId, error: 'Rejected: untrusted sender for internal message.' });
      return false;
    }
    // Hydrate-on-wake, then record activity (prompt 0117, revised) — every
    // trusted internal message, no exceptions carved out per message
    // type, matching this feature's own literal definition of "activity".
    // Both steps are chained (never fired as two independent promises)
    // specifically so two internal messages arriving back-to-back can
    // never both observe an empty cache and race to hydrate/persist
    // independently — see walletService.js's hydrateSessionIfNeeded()
    // single-flight comment for the other half of that guarantee.
    // recordActivity() itself is a plain storage write with no in-memory
    // cache to race on (see that function's own comment), so ordering it
    // after hydration (rather than in parallel) is about keeping this
    // chain simple and predictable, not about a race on recordActivity
    // itself.
    walletService.hydrateSessionIfNeeded()
      .then(() => walletService.recordActivity())
      .then(() => internalMessageHandlers[type](message))
      .then((response) => sendResponse({ requestId, response }))
      .catch((error) => sendResponse({ requestId, error: error?.message || 'Unknown error' }));
    return true;
  }

  return false;
});

/** Only the extension's own pages (e.g. the approval window) may send internal messages. */
function isTrustedInternalSender(sender) {
  return (
    !!sender &&
    sender.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(extensionOrigin)
  );
}

function requireSignMessagePayload(payload) {
  if (!payload || typeof payload.network !== 'string' || typeof payload.message !== 'string') {
    throw new Error('SIGN_MESSAGE requires { network, message }.');
  }
  return payload;
}

function requireSignTransactionPayload(payload) {
  if (!payload || typeof payload.network !== 'string' || payload.transaction == null) {
    throw new Error('SIGN_TRANSACTION requires { network, transaction }.');
  }
  return payload;
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function textToBytes(text) {
  return new TextEncoder().encode(text);
}

function serializeSignature(signature) {
  // EVM signer returns a hex string already; Solana signer returns raw bytes.
  if (typeof signature === 'string') return signature;
  return `0x${Array.from(signature, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
