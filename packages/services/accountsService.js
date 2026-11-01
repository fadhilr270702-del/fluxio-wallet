/**
 * Account metadata store — the list of derived-account { index, name }
 * entries and which one is currently active.
 *
 * This is NOT the vault and holds no secret: only an index (a public,
 * non-sensitive number identifying which BIP-44/SLIP-10 account of the
 * SAME seed to derive — see @fluxio/crypto/derivation.js) and a
 * user-chosen display name. Every actual address for these accounts is
 * re-derived on demand from walletService's in-memory seed (see
 * walletService.deriveAccountAddresses) rather than cached here, so
 * there's nothing in this store that could ever drift out of sync with
 * what the seed actually derives.
 *
 * Same backend-auto-select pattern as @fluxio/crypto/storage.js (this
 * monorepo's own precedent for "chrome.storage.local in the extension,
 * localStorage in tests/apps/web") rather than importing that module
 * directly — storage.js's writes are gated by isVault() by design (it
 * structurally refuses to persist anything that isn't a vault record),
 * and this data is deliberately not vault-shaped.
 */
const STORAGE_KEY = 'fluxio.accounts.v1';
const MAX_NAME_LENGTH = 32;

function backend() {
  if (hasChromeStorage()) return chromeStorageBackend();
  if (hasLocalStorage()) return localStorageBackend();
  throw new Error('No supported storage backend (chrome.storage or localStorage) is available.');
}

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;
}

function hasLocalStorage() {
  return typeof localStorage !== 'undefined';
}

function chromeStorageBackend() {
  return {
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
    async get(key) {
      const result = await chrome.storage.local.get(key);
      return result?.[key] ?? null;
    },
    async remove(key) {
      await chrome.storage.local.remove(key);
    }
  };
}

function localStorageBackend() {
  return {
    async set(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
    async get(key) {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    },
    async remove(key) {
      localStorage.removeItem(key);
    }
  };
}

function defaultState() {
  // Index 0 is always "the existing account" — this is exactly what a
  // fresh session already derives by default (see walletService.js's
  // openSession), so a wallet that predates this feature (or a
  // brand-new one) lands here with zero migration needed.
  return { accounts: [{ index: 0, name: 'Account 1' }], activeIndex: 0 };
}

/**
 * Reads the account list + active index, self-initializing (and
 * persisting) the default single-account state on first-ever read.
 * @returns {Promise<{ accounts: Array<{index: number, name: string}>, activeIndex: number }>}
 */
export async function getAccountsState() {
  const stored = await backend().get(STORAGE_KEY);
  if (stored && Array.isArray(stored.accounts) && stored.accounts.length > 0) {
    return stored;
  }
  const initial = defaultState();
  await backend().set(STORAGE_KEY, initial);
  return initial;
}

/**
 * Appends a new account entry with an auto-generated name ("Account N").
 * Indices are always contiguous 0..N-1 in this phase — there is no
 * delete-account feature yet (a deliberate scope cut, see the feature's
 * own prompt), so `accounts.length` is always a safe next index.
 * @returns {Promise<{index: number, name: string}>} the newly added entry
 */
export async function addAccountEntry() {
  const state = await getAccountsState();
  const index = state.accounts.length;
  const entry = { index, name: `Account ${index + 1}` };
  const accounts = [...state.accounts, entry];
  await backend().set(STORAGE_KEY, { accounts, activeIndex: state.activeIndex });
  return entry;
}

/**
 * Renames an existing account entry.
 * @throws if `name` is empty/whitespace-only, longer than MAX_NAME_LENGTH,
 *   or `index` doesn't match any known account.
 * @returns {Promise<{index: number, name: string}>}
 */
export async function renameAccountEntry(index, name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    throw new Error('Account name cannot be empty.');
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`Account name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  const state = await getAccountsState();
  if (!state.accounts.some((a) => a.index === index)) {
    throw new Error(`Unknown account index: ${index}`);
  }
  const accounts = state.accounts.map((a) => (a.index === index ? { ...a, name: trimmed } : a));
  await backend().set(STORAGE_KEY, { accounts, activeIndex: state.activeIndex });
  return { index, name: trimmed };
}

/**
 * Persists which account index is active — the UI-visible half of
 * "switch account"; walletService.setActiveAccount() is the other half
 * (re-deriving the live session), see background.js for where the two
 * meet.
 * @throws if `index` doesn't match any known account.
 */
export async function setActiveAccountEntry(index) {
  const state = await getAccountsState();
  if (!state.accounts.some((a) => a.index === index)) {
    throw new Error(`Unknown account index: ${index}`);
  }
  await backend().set(STORAGE_KEY, { accounts: state.accounts, activeIndex: index });
  return index;
}

/**
 * Full wallet reset support (prompt 0124): erases this store entirely
 * rather than rewriting it back to defaultState() — either would leave
 * `getAccountsState()` behaving identically afterward (it self-initializes
 * on a missing key, see above), but removing the key outright is the more
 * honest representation of "nothing is left over from the old wallet."
 */
export async function resetAccountsState() {
  await backend().remove(STORAGE_KEY);
}
