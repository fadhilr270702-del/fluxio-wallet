/**
 * Wallet session service — the "Background / Wallet Service" +
 * "Secure Vault" boxes in the signing architecture:
 *   Web Page -> Extension Provider -> Background/Wallet Service ->
 *   User Approval -> Secure Vault -> Signer -> Signed Transaction
 *
 * Holds the single source of truth for wallet secrets *in memory only*
 * (for as long as the vault is unlocked) — or, as of this revision, in
 * `chrome.storage.session`, Chrome's own OS-process-memory-only storage
 * area, never a JS heap variable alone. Nothing here ever persists a
 * mnemonic or private key in *plaintext-on-disk*; persistence-to-disk
 * only ever touches the encrypted vault record (see @fluxio/crypto/vault
 * + storage) — see the SESSION STORAGE section below for exactly what
 * changed, why, and the security reasoning behind it.
 *
 * This module is intentionally transport-agnostic: apps/extension's
 * background.js and (later) apps/web's onboarding UI both call the same
 * functions rather than duplicating session/derivation logic.
 *
 * ============================================================
 * SESSION STORAGE (prompt 0117 revision) — WHY THIS CHANGED
 * ============================================================
 * The ORIGINAL design (see this file's own git history) kept `session`
 * as a plain in-memory module variable, reasoning that an MV3 service
 * worker restart wipes it anyway, so "the wallet is already effectively
 * locked the moment the worker dies" and nothing more was needed. That
 * reasoning was LOGICALLY sound but empirically WRONG about when a
 * worker actually dies: real manual verification (two live experiments
 * in Chrome, see prompt/0117-auto-lock-timer.md's own Revision note)
 * proved the worker's lifetime is NOT deterministic from this
 * extension's own code — it depends on incidental factors like whether
 * a periodic chrome.alarms firing happens to keep the worker "busy"
 * often enough to avoid Chrome's own idle-teardown window, or whether
 * DevTools happens to be attached (which artificially keeps a worker
 * alive indefinitely). Concretely: the "Never" auto-lock setting
 * (deliberately no periodic alarm — see background.js's own
 * reprogramAutoLockAlarm) meant NOTHING was keeping the worker alive, so
 * it died from ordinary MV3 idle-teardown well before any real "Never"
 * semantics should have applied, wiping the in-memory session and
 * LOOKING like a lock the auto-lock feature never actually decided to
 * apply. Meanwhile the 5/15/30/60-minute settings' own per-minute alarm
 * was — completely by accident — keeping the worker alive continuously,
 * so THEIR lock decisions (correctly reasoned in shared/autoLockDecision.js,
 * unaffected by this revision) were the only ones actually being tested.
 * Net effect: "in-memory session dies with the worker" was never a safe
 * foundation to reason auto-lock's correctness on top of, because this
 * extension does not control (and cannot reliably predict) worker
 * lifetime — so auto-lock's real guarantees need to be independent of it.
 *
 * THE FIX: `session` (and the auto-lock-relevant `lastActivityAt`
 * timestamp, moved here from background.js — see recordActivity()/
 * getLastActivityAt() below) now live in `chrome.storage.session`
 * instead of a bare module variable. This is Chrome's own purpose-built
 * answer to exactly this MV3 problem: memory-only (the API's own
 * documented guarantee — it is NEVER written to disk, at no point, by
 * design), automatically cleared when the browser process fully closes,
 * but — unlike a bare module variable — SURVIVES an individual service-
 * worker restart, which is the actual gap that mattered here. An
 * in-memory `let session` variable is kept ALONGSIDE this as a fast-path
 * CACHE (see `session` below, and hydrateSessionIfNeeded()) so the many
 * synchronous call sites throughout this file (isUnlocked(),
 * getPublicWallet(), every signing path) don't all need to become async
 * — the cache is refilled from chrome.storage.session once per worker
 * lifetime, the first time anything asks and finds it empty.
 *
 * SECURITY REASONING — what exactly is stored, and why it's still safe:
 *   - `chrome.storage.session`'s default `accessLevel` is
 *     `'TRUSTED_CONTEXTS'` — content scripts injected into untrusted web
 *     pages CANNOT read this storage area at all (the API surface isn't
 *     even exposed to them) unless an extension explicitly calls
 *     `chrome.storage.session.setAccessLevel(...)` to loosen it. This
 *     module NEVER calls that function — confirmed by inspecting every
 *     use of `chrome.storage.session` in this codebase (search it; the
 *     only calls are `.get`/`.set`/`.remove` below). The default,
 *     stricter access level is relied on, not merely assumed.
 *   - What's stored is still the derivation SEED (mnemonicToSeed's own
 *     64-byte output), not something narrower — a genuinely narrower
 *     alternative was considered and rejected: storing only the CURRENT
 *     account's already-derived per-chain private keys (instead of the
 *     master seed) would avoid exposing the ability to derive every OTHER
 *     account, but this module's multi-account features (setActiveAccount,
 *     deriveAccountAddresses — switching accounts, or even just previewing
 *     another account's address for the drawer UI, see accountsService.js)
 *     genuinely need the seed itself to re-derive a DIFFERENT account on
 *     demand; caching only one account's already-derived keys would break
 *     account switching without a fresh password prompt, which is a real
 *     regression in what "unlocked" already means today (unlocked =
 *     doesn't need the password again to use ANY of this seed's
 *     accounts). The seed is the smallest unit of state that keeps the
 *     EXISTING "unlocked" contract intact.
 *   - Mitigation for storing the seed itself: (1) still never touches
 *     disk, same guarantee the in-memory-only design always had — this
 *     revision changes WHERE in memory it lives (Chrome's own storage
 *     subsystem vs. this file's own JS heap), not whether it's ever
 *     persisted; (2) still architecturally reachable only through this
 *     one module — popup.js/onboarding.js/settings.js continue to talk
 *     to the wallet exclusively via FLUXIO_INTERNAL_* messages to
 *     background.js, exactly as before this revision; nothing about
 *     THEIR code changed, and none of them read this storage key
 *     directly, so the practical exposure among this extension's own
 *     pages is unchanged even though chrome.storage.session's own API
 *     would technically allow any trusted context to read it; (3)
 *     cleared automatically when the browser closes (same "closing the
 *     browser logs you out" property the bare-variable design always
 *     had, now an explicit contract of the storage API rather than an
 *     implicit side effect of process death); (4) lock() (see below) now
 *     explicitly clears the PERSISTED copy too, not just the in-memory
 *     cache — see that function's own comment for why that specifically
 *     matters now.
 */
import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed
} from '@fluxio/crypto/mnemonic';
import { deriveWallet, getAccountForNetwork } from '@fluxio/crypto/wallet';
import { deriveSolanaAccount, deriveEvmAccount } from '@fluxio/crypto/derivation';
import { createVault, unlockVault } from '@fluxio/crypto/vault';
import { saveVault, loadVault, clearVault } from '@fluxio/crypto/storage';
import { createSigner } from '@fluxio/crypto/signer';
import { NETWORKS, ACCOUNT_TYPES } from '@fluxio/constants';

const SESSION_STORAGE_KEY = 'fluxio.wallet-session.v1';
const LAST_ACTIVITY_STORAGE_KEY = 'fluxio.wallet-session.last-activity.v1';

function hasChromeSessionStorage() {
  return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.session;
}

// A plain in-memory Map — NOT localStorage — for the no-chrome fallback
// (a plain Node process: vitest, scripts/*.mjs). Deliberately different
// from accountsService.js's own fallback, which DOES use localStorage:
// that's fine there because account metadata ({index, name}) holds no
// secret. This module's session blob holds actual key material, so
// falling back to something that persists to a real disk in ANY
// environment (localStorage, IndexedDB, a file, ...) would be a genuine
// security regression, not just an inconsistency — even in a throwaway
// test process. A Map that only ever lives in this process's own memory,
// gone the instant the process exits, is the closest available
// equivalent to chrome.storage.session's own memory-only guarantee.
const inMemorySessionStore = new Map();

function sessionBackend() {
  if (hasChromeSessionStorage()) {
    return {
      async get(key) {
        const result = await chrome.storage.session.get(key);
        return result?.[key] ?? null;
      },
      async set(key, value) {
        await chrome.storage.session.set({ [key]: value });
      },
      async remove(key) {
        await chrome.storage.session.remove(key);
      }
    };
  }
  return {
    async get(key) {
      return inMemorySessionStore.has(key) ? inMemorySessionStore.get(key) : null;
    },
    async set(key, value) {
      inMemorySessionStore.set(key, value);
    },
    async remove(key) {
      inMemorySessionStore.delete(key);
    }
  };
}

/**
 * Uint8Array <-> base64. chrome.storage's own value serialization isn't
 * guaranteed to round-trip a typed array faithfully (it structured-clones
 * through an internal representation not documented to preserve
 * Uint8Array-ness), so the seed is explicitly encoded/decoded around
 * every read/write rather than trusting that. btoa/atob (not Node's
 * Buffer) specifically because they're available, identically, in BOTH a
 * real MV3 service worker (a standard Web API there) and a plain Node
 * test/script process (global since Node 16) — no extra dependency, no
 * environment-specific branch needed for this one conversion.
 */
function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Writes the CURRENT in-memory `session` to the session storage backend.
 * Called every time `session` actually changes shape — a fresh unlock
 * (openSession) or an account switch (setActiveAccount) — never on every
 * message; `lastActivityAt` is a separate, much-more-frequently-written
 * piece of state with its own functions below, kept out of this blob
 * specifically so recording routine activity never means rewriting (and
 * re-touching) the seed on every single message.
 *
 * A no-op-but-clearing call when `session` is null: removes the
 * persisted entry outright (see lock()'s own comment for why this
 * matters, not just mirroring the in-memory clear for tidiness).
 */
async function persistSession() {
  if (!session) {
    await sessionBackend().remove(SESSION_STORAGE_KEY);
    return;
  }
  await sessionBackend().set(SESSION_STORAGE_KEY, {
    seedBase64: bytesToBase64(session.seed),
    wallet: session.wallet,
    unlockedAt: session.unlockedAt
  });
}

/**
 * Single-flight hydration: if the in-memory `session` cache is already
 * populated, this is a fast, synchronous-feeling no-op (the common case
 * — a service worker usually handles several messages before ever going
 * idle). Otherwise, tries to load a persisted session from the storage
 * backend and repopulate the cache — this is what makes the wallet's
 * unlocked state survive an MV3 service-worker restart in practice; see
 * this file's own header comment for why that turned out to matter for
 * real, not hypothetically.
 *
 * MUST be called (by background.js's message dispatcher — see that
 * file's own comment for exactly where) before anything reads
 * isUnlocked()/getPublicWallet()/signs anything, on every message that
 * could plausibly be the first one this worker instance has seen since
 * a restart. This module cannot enforce that from in here — it's a
 * contract with the caller, the same way `requireApproval()` already had
 * to be called before signing in the pre-existing dApp-approval flow.
 *
 * Concurrency: if two messages arrive back-to-back before the first
 * hydration attempt resolves, the SECOND caller reuses the exact SAME
 * in-flight promise rather than starting a second, independent storage
 * read — a standard single-flight pattern, not incidental. Without it,
 * two near-simultaneous messages could each reconstruct `session`
 * independently, and if one of them were something that also MUTATES it
 * (e.g. a concurrent setActiveAccount), the two reconstructions could
 * race and clobber each other's result.
 */
let hydratePromise = null;
export async function hydrateSessionIfNeeded() {
  if (session !== null) return;
  if (!hydratePromise) {
    hydratePromise = (async () => {
      try {
        const stored = await sessionBackend().get(SESSION_STORAGE_KEY);
        if (stored) {
          session = {
            seed: base64ToBytes(stored.seedBase64),
            wallet: stored.wallet,
            unlockedAt: stored.unlockedAt
          };
        }
      } finally {
        hydratePromise = null;
      }
    })();
  }
  await hydratePromise;
}

/**
 * Records "activity happened right now" — intended to be called by
 * background.js's dispatcher on every trusted FLUXIO_INTERNAL_* message
 * (the auto-lock feature's own definition of "activity", unchanged by
 * this revision — see shared/autoLockDecision.js). Written straight to
 * the storage backend with NO in-memory caching layer, unlike `session`
 * above: this has exactly ONE reader anywhere in this codebase (the
 * auto-lock alarm handler in background.js, itself already async), so
 * there's no synchronous-access problem to solve with a cache here —
 * always reading/writing storage directly is simpler and exactly as
 * correct as caching would be, with no extra single-flight logic needed.
 */
export async function recordActivity() {
  await sessionBackend().set(LAST_ACTIVITY_STORAGE_KEY, Date.now());
}

/**
 * Reads the last-recorded activity timestamp, or `null` if none was ever
 * recorded (a fresh install, or a session that predates this storage
 * key). shared/autoLockDecision.js's shouldAutoLock() already fails
 * CLOSED (locks) on a missing/non-finite timestamp — see that module's
 * own comment — so `null` here needs no special-casing by callers.
 * @returns {Promise<number|null>}
 */
export async function getLastActivityAt() {
  return sessionBackend().get(LAST_ACTIVITY_STORAGE_KEY);
}

/**
 * In-memory unlocked-session CACHE — see the SESSION STORAGE section of
 * this file's header comment for the full architecture. Never exported
 * directly; every mutation goes through the functions below so lock()
 * has one place to scrub it (and persistSession() has one place to keep
 * the storage-backed copy in sync).
 * @type {{ seed: Uint8Array, wallet: object, unlockedAt: number } | null}
 */
let session = null;

/** True if a vault has ever been created and persisted. */
export async function hasWallet() {
  const vault = await loadVault();
  return vault != null;
}

/**
 * Synchronous by design — every existing call site throughout
 * background.js calls this synchronously (`if (!walletService.isUnlocked())`),
 * and making it async would ripple into dozens of call sites for no
 * behavioral benefit. Correctness instead depends on the CALLER having
 * already called hydrateSessionIfNeeded() first (see that function's own
 * comment) — this function itself just reads whatever the in-memory
 * cache currently holds.
 */
export function isUnlocked() {
  return session !== null;
}

/**
 * Create a brand-new wallet: generate a mnemonic, derive its accounts,
 * seal the mnemonic into a password-encrypted vault, persist the vault,
 * and unlock the session with it.
 *
 * The mnemonic is returned exactly once so the caller can show it to the
 * user for backup — it is the caller's responsibility not to log it, send
 * it anywhere, or hold onto it longer than necessary.
 *
 * @param {string} password
 * @param {{ wordCount?: 12|24 }} [opts]
 * @returns {Promise<{ wallet: object, mnemonic: string }>}
 */
export async function createWallet(password, opts = {}) {
  const mnemonic = generateMnemonic(opts.wordCount ?? 12);
  const vault = await createVault(mnemonic, password);
  await saveVault(vault);
  const publicWallet = await openSession(mnemonic);
  return { wallet: publicWallet, mnemonic };
}

/**
 * Import an existing wallet from a user-supplied mnemonic, sealing it into
 * a new vault the same way createWallet() does.
 */
export async function importWallet(mnemonic, password) {
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic: failed BIP-39 checksum/word-count validation.');
  }
  const vault = await createVault(mnemonic, password);
  await saveVault(vault);
  return { wallet: await openSession(mnemonic) };
}

/** Unlock the persisted vault into an in-memory (and storage-backed) session. */
export async function unlock(password) {
  const vault = await loadVault();
  if (!vault) {
    throw new Error('WALLET_NOT_INITIALIZED');
  }
  const mnemonic = await unlockVault(vault, password);
  return openSession(mnemonic);
}

/**
 * Lock the wallet: best-effort scrubs the in-memory seed AND removes the
 * persisted session from chrome.storage.session. Now async (previously
 * synchronous) — callers must await it, and this isn't just symmetry
 * with the rest of this file: if the persisted copy weren't cleared too,
 * a LATER service-worker restart could hydrate a seemingly-fresh session
 * right back from storage, silently undoing the lock the moment the
 * worker happened to restart next — exactly the class of bug this whole
 * revision exists to close, just inverted. Every caller in background.js
 * (the manual Lock button, the auto-lock alarm handler) awaits this.
 */
export async function lock() {
  if (session) {
    session.seed.fill(0);
    session.wallet = null;
  }
  session = null;
  await persistSession();
}

/** Erase the persisted vault entirely (does not affect the current session). */
export async function deleteWallet() {
  await clearVault();
}

/**
 * Full "forgot password" reset (prompt 0124) — this wallet is
 * non-custodial, so there is no password *reset*, only start-over: erase
 * the encrypted vault and the unlocked session (both the in-memory cache
 * and its chrome.storage.session-persisted copy, plus the last-activity
 * timestamp lock() itself doesn't touch — see below) so a subsequent
 * FLUXIO_INTERNAL_IMPORT_WALLET legitimately passes its own
 * hasWallet()-guard rather than needing a bypass added to it.
 *
 * Deliberately callable while LOCKED (session already null) — that's the
 * entire point of this feature, since a user who forgot their password is
 * locked by definition. Nothing here calls requireUnlocked() or otherwise
 * depends on an existing session.
 *
 * Scope: this function only owns what THIS module owns (the vault and the
 * session). Multi-account metadata, custom tokens, transaction history,
 * and user preferences live in accountsService.js/background.js's own
 * storage and are the caller's responsibility to clear too — see
 * background.js's FLUXIO_INTERNAL_RESET_WALLET handler and
 * prompt/0124-forgot-password-reset-wallet.md's own storage-key
 * inventory table for the complete picture.
 */
export async function resetWallet() {
  await lock(); // scrubs the in-memory seed + removes the persisted session
  await deleteWallet();
  // lock() clears the session blob but not this — a leftover timestamp is
  // harmless (the next unlock's own recordActivity() overwrites it before
  // anything reads it), but a full reset should leave nothing behind that
  // even LOOKS like it belongs to the old seed.
  await sessionBackend().remove(LAST_ACTIVITY_STORAGE_KEY);
}

/** Public wallet model (addresses only) for the current session, or null if locked. Same synchronous-by-design reasoning as isUnlocked() above. */
export function getPublicWallet() {
  return session ? session.wallet : null;
}

/**
 * Sign a message for the given network. Requires an unlocked session — the
 * caller (background.js) is responsible for having already run the
 * approval-request step (and hydrateSessionIfNeeded(), see this file's
 * own header) before calling this.
 * @param {string} networkKey - a @fluxio/constants network key.
 * @param {string|Uint8Array} message
 */
export async function signMessage(networkKey, message) {
  const { signer, dispose } = signerForNetwork(networkKey);
  try {
    return await signer.signMessage(message);
  } finally {
    dispose();
  }
}

/**
 * Sign a transaction for the given network. See signer/* for what "already
 * populated" means per chain — this phase signs, it does not build or
 * broadcast transactions.
 */
export async function signTransaction(networkKey, transactionPayload) {
  const { signer, dispose } = signerForNetwork(networkKey);
  try {
    return await signer.signTransaction(transactionPayload);
  } finally {
    dispose();
  }
}

/**
 * Multi-account: switches the active session to a different account
 * index of the SAME seed (see @fluxio/crypto/wallet.js's deriveWallet —
 * one seed, many BIP-44/SLIP-10 accounts, never a new seed). Re-derives
 * only the public wallet model; the seed itself never moves. Updates
 * session.wallet, so every existing call site that already reads it
 * (getPublicWallet(), signerForNetwork() below, ...) picks up the new
 * account with no further changes.
 *
 * Now async (previously synchronous) — the updated session.wallet must
 * be persisted too, or a service-worker restart right after a switch
 * would silently revert to whichever account was active at the LAST
 * persisted snapshot. Callers in background.js now await this.
 * @param {number} accountIndex
 * @returns {Promise<object>} the newly active public wallet model
 */
export async function setActiveAccount(accountIndex) {
  requireUnlocked();
  requireValidAccountIndex(accountIndex);
  const { wallet } = deriveWallet(session.seed, { accountIndex, id: session.wallet.id });
  session.wallet = wallet;
  await persistSession();
  return wallet;
}

/**
 * Read-only: derives the public wallet model for a given account index of
 * the current session's seed WITHOUT switching the active account or
 * touching secrets beyond the already-in-memory seed. Used to compute a
 * new account's address before it becomes active, and to resolve every
 * known account's addresses for the account list/switcher UI (see
 * @fluxio/services/accountsService for the index/name metadata this is
 * paired with — that store intentionally holds no address of its own).
 *
 * Deliberately STAYS synchronous, unlike setActiveAccount above: this
 * never mutates `session`, so there's nothing new to persist and no
 * reason to make callers await it.
 * @param {number} accountIndex
 * @returns {object} the public wallet model at that index
 */
export function deriveAccountAddresses(accountIndex) {
  requireUnlocked();
  requireValidAccountIndex(accountIndex);
  const { wallet } = deriveWallet(session.seed, { accountIndex, id: session.wallet.id });
  return wallet;
}

/** The current session's active account index, or null if locked. */
export function getActiveAccountIndex() {
  return session ? session.wallet.accountIndex : null;
}

function requireValidAccountIndex(accountIndex) {
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error('accountIndex must be a non-negative integer.');
  }
}

function signerForNetwork(networkKey) {
  requireUnlocked();
  const network = NETWORKS[networkKey];
  if (!network) throw new Error(`Unknown network: ${networkKey}`);

  if (network.accountType === ACCOUNT_TYPES.SOLANA) {
    const { secretKey } = deriveSolanaAccount(session.seed, session.wallet.accountIndex);
    const signer = createSigner(ACCOUNT_TYPES.SOLANA, secretKey);
    return { signer, dispose: () => { signer.dispose(); secretKey.fill(0); } };
  }

  if (network.accountType === ACCOUNT_TYPES.EVM) {
    const { privateKey } = deriveEvmAccount(session.seed, session.wallet.accountIndex);
    const signer = createSigner(ACCOUNT_TYPES.EVM, privateKey);
    return { signer, dispose: () => signer.dispose() };
  }

  throw new Error(`No signer available for network: ${networkKey}`);
}

async function openSession(mnemonic) {
  const seed = mnemonicToSeed(mnemonic);
  const { wallet } = deriveWallet(seed);
  session = { seed, wallet, unlockedAt: Date.now() };
  await persistSession();
  return session.wallet;
}

function requireUnlocked() {
  if (!session) {
    throw new Error('WALLET_LOCKED');
  }
}

export { getAccountForNetwork };
