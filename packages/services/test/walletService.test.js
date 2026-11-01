import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nacl from 'tweetnacl';
import { verifyMessage } from 'ethers';
import * as walletService from '../walletService.js';

function installFakeLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
}

/**
 * A minimal chrome.storage.session mock — no existing precedent in this
 * repo mocks this exact API (accountsService.test.js's own
 * installFakeLocalStorage() above is the closest sibling, mocking
 * chrome.storage.local's fallback instead), so this is modeled on that
 * same shape/style: a plain Map behind a promise-returning get/set/remove
 * surface matching chrome.storage.session's real (promise-based, no
 * callback) API when called with a single string key, exactly how
 * walletService.js's own sessionBackend() calls it.
 */
function installFakeChromeSessionStorage() {
  const store = new Map();
  globalThis.chrome = {
    storage: {
      session: {
        get: (key) => Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
        set: (obj) => {
          Object.entries(obj).forEach(([k, v]) => store.set(k, v));
          return Promise.resolve();
        },
        remove: (key) => {
          store.delete(key);
          return Promise.resolve();
        }
      }
    }
  };
  return store;
}

beforeEach(async () => {
  installFakeLocalStorage();
  await walletService.lock();
});

describe('createWallet', () => {
  it('creates a new wallet, persists a vault, and unlocks the session', async () => {
    expect(await walletService.hasWallet()).toBe(false);

    const { wallet, mnemonic } = await walletService.createWallet('correct horse battery staple');

    expect(mnemonic.trim().split(/\s+/)).toHaveLength(12);
    expect(wallet.accounts.solana.address).toBeTruthy();
    expect(wallet.accounts.evm.address).toBeTruthy();
    expect(walletService.isUnlocked()).toBe(true);
    expect(await walletService.hasWallet()).toBe(true);
  });

  it('supports 24-word wallets', async () => {
    const { mnemonic } = await walletService.createWallet('a-password', { wordCount: 24 });
    expect(mnemonic.trim().split(/\s+/)).toHaveLength(24);
  });
});

describe('lock / unlock', () => {
  it('lock() clears the session and unlock() restores the same accounts', async () => {
    const { wallet } = await walletService.createWallet('a-password');

    await walletService.lock();
    expect(walletService.isUnlocked()).toBe(false);
    expect(walletService.getPublicWallet()).toBeNull();

    const unlocked = await walletService.unlock('a-password');
    expect(walletService.isUnlocked()).toBe(true);
    expect(unlocked.accounts.solana.address).toBe(wallet.accounts.solana.address);
    expect(unlocked.accounts.evm.address).toBe(wallet.accounts.evm.address);
  });

  it('rejects unlock with the wrong password', async () => {
    await walletService.createWallet('right-password');
    await walletService.lock();
    await expect(walletService.unlock('wrong-password')).rejects.toThrow();
    expect(walletService.isUnlocked()).toBe(false);
  });

  it('rejects unlock when no wallet has ever been created', async () => {
    await expect(walletService.unlock('any-password')).rejects.toThrow('WALLET_NOT_INITIALIZED');
  });
});

describe('signing requires an unlocked session', () => {
  it('throws WALLET_LOCKED when locked', async () => {
    await expect(walletService.signMessage('solana', new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'WALLET_LOCKED'
    );
  });

  it('produces a real verifiable Solana signature once unlocked', async () => {
    const { wallet } = await walletService.createWallet('a-password');
    const message = new TextEncoder().encode('approve this');
    const signature = await walletService.signMessage('solana', message);

    const { default: bs58 } = await import('bs58');
    const publicKeyBytes = bs58.decode(wallet.accounts.solana.address);
    expect(nacl.sign.detached.verify(message, signature, publicKeyBytes)).toBe(true);
  });

  it('produces a real verifiable EVM signature once unlocked, reused across ethereum/bnb/base', async () => {
    const { wallet } = await walletService.createWallet('a-password');
    const signature = await walletService.signMessage('ethereum', 'approve this');
    expect(verifyMessage('approve this', signature)).toBe(wallet.accounts.evm.address);

    // BNB / Base resolve to the same EVM account.
    const bnbSignature = await walletService.signMessage('bnb', 'approve this');
    expect(verifyMessage('approve this', bnbSignature)).toBe(wallet.accounts.evm.address);
  });
});

describe('importWallet', () => {
  it('rejects an invalid mnemonic', async () => {
    await expect(walletService.importWallet('not a valid mnemonic', 'a-password')).rejects.toThrow();
  });

  it('imports a valid mnemonic deterministically', async () => {
    const REFERENCE_MNEMONIC =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const { wallet } = await walletService.importWallet(REFERENCE_MNEMONIC, 'a-password');
    expect(wallet.accounts.evm.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  });
});

describe('multi-account (same seed, increasing account index — see @fluxio/crypto/derivation.js)', () => {
  it('setActiveAccount() switches session.wallet to a different derived account of the SAME seed', async () => {
    const { wallet: account0 } = await walletService.createWallet('a-password');

    const account1 = await walletService.setActiveAccount(1);
    expect(account1.accountIndex).toBe(1);
    expect(account1.accounts.solana.address).not.toBe(account0.accounts.solana.address);
    expect(account1.accounts.evm.address).not.toBe(account0.accounts.evm.address);

    // getPublicWallet() reflects the switch — every existing call site
    // that reads it (background.js's balance/Send/Receive/CONNECT
    // handlers) automatically follows with no changes of its own.
    expect(walletService.getPublicWallet().accountIndex).toBe(1);
    expect(walletService.getActiveAccountIndex()).toBe(1);
  });

  it('switching back to index 0 restores the exact original addresses (round-trip, not a new derivation path)', async () => {
    const { wallet: account0 } = await walletService.createWallet('a-password');
    await walletService.setActiveAccount(2);
    const backToZero = await walletService.setActiveAccount(0);
    expect(backToZero.accounts.solana.address).toBe(account0.accounts.solana.address);
    expect(backToZero.accounts.evm.address).toBe(account0.accounts.evm.address);
  });

  it('signing after switching accounts uses the NEW active account, not the original one', async () => {
    const { wallet: account0 } = await walletService.createWallet('a-password');
    const account1 = await walletService.setActiveAccount(1);

    const message = new TextEncoder().encode('approve this');
    const signature = await walletService.signMessage('solana', message);

    const { default: bs58 } = await import('bs58');
    const account1PublicKey = bs58.decode(account1.accounts.solana.address);
    const account0PublicKey = bs58.decode(account0.accounts.solana.address);

    expect(nacl.sign.detached.verify(message, signature, account1PublicKey)).toBe(true);
    expect(nacl.sign.detached.verify(message, signature, account0PublicKey)).toBe(false);
  });

  it('deriveAccountAddresses() reads a given index WITHOUT switching the active account', async () => {
    const { wallet: account0 } = await walletService.createWallet('a-password');
    const previewOfAccount3 = walletService.deriveAccountAddresses(3);

    expect(previewOfAccount3.accountIndex).toBe(3);
    expect(previewOfAccount3.accounts.solana.address).not.toBe(account0.accounts.solana.address);
    // Still on account 0 — the preview call must not have mutated the session.
    expect(walletService.getActiveAccountIndex()).toBe(0);
    expect(walletService.getPublicWallet().accounts.solana.address).toBe(account0.accounts.solana.address);
  });

  it('setActiveAccount() and deriveAccountAddresses() both throw WALLET_LOCKED when locked', async () => {
    await walletService.createWallet('a-password');
    await walletService.lock();
    // setActiveAccount() is now async (see this revision's own comment on
    // walletService.js) — a throw inside an async function surfaces as a
    // REJECTED PROMISE, never a synchronous exception, so this assertion
    // moved from `expect(() => ...).toThrow(...)` to the standard vitest
    // async-rejection form. deriveAccountAddresses() stays synchronous
    // (it never mutates/persists session — see its own comment), so its
    // assertion is deliberately UNCHANGED below.
    await expect(walletService.setActiveAccount(1)).rejects.toThrow('WALLET_LOCKED');
    expect(() => walletService.deriveAccountAddresses(1)).toThrow('WALLET_LOCKED');
    expect(walletService.getActiveAccountIndex()).toBeNull();
  });

  it('rejects a negative or non-integer account index', async () => {
    await walletService.createWallet('a-password');
    // Same async-rejection reasoning as the WALLET_LOCKED test above.
    await expect(walletService.setActiveAccount(-1)).rejects.toThrow(
      'accountIndex must be a non-negative integer.'
    );
    await expect(walletService.setActiveAccount(1.5)).rejects.toThrow(
      'accountIndex must be a non-negative integer.'
    );
  });

  it('preserves the wallet id across an account switch (same underlying wallet, different account view)', async () => {
    const { wallet: account0 } = await walletService.createWallet('a-password');
    const account1 = await walletService.setActiveAccount(1);
    expect(account1.id).toBe(account0.id);
  });
});

describe('deleteWallet', () => {
  it('removes the persisted vault', async () => {
    await walletService.createWallet('a-password');
    expect(await walletService.hasWallet()).toBe(true);

    await walletService.deleteWallet();
    expect(await walletService.hasWallet()).toBe(false);
  });
});

/**
 * Session-storage architecture (chrome.storage.session + hydrate-on-wake)
 * — added for the follow-up bug-fix revision to prompt 0117, see
 * prompt/0117-auto-lock-timer.md's own Revision note for the full "why".
 *
 * Every test in this block that needs to simulate an MV3 service-worker
 * restart uses `vi.resetModules()` + a fresh dynamic `import('../walletService.js')`
 * rather than calling walletService.lock()/anything on the statically-
 * imported `walletService` at the top of this file — a restart wipes
 * every module-level JS variable (including the module-level `session`
 * cache) but leaves chrome.storage.session untouched, and re-importing
 * the module after `vi.resetModules()` is the closest faithful
 * reproduction of exactly that: a brand-new module instance (fresh
 * module-level state) sharing the same external mock storage (the
 * `store` Map behind the installed chrome.storage.session mock, which
 * lives OUTSIDE the module and survives the reset). The statically-
 * imported `walletService` at the top of this file is never used inside
 * this block for that reason — mixing the two would blur exactly the
 * distinction these tests exist to prove.
 */
describe('session persistence — chrome.storage.session backend + hydrate-on-wake', () => {
  afterEach(() => {
    delete globalThis.chrome;
  });

  it('persists the unlocked session to chrome.storage.session and survives a simulated service-worker restart', async () => {
    installFakeChromeSessionStorage();
    vi.resetModules();
    const beforeRestart = await import('../walletService.js');
    const { wallet } = await beforeRestart.createWallet('a-password');
    expect(beforeRestart.isUnlocked()).toBe(true);

    // Simulate the worker dying and restarting: a fresh module instance,
    // whose in-memory cache starts empty, backed by the SAME mocked
    // chrome.storage.session store.
    vi.resetModules();
    const afterRestart = await import('../walletService.js');
    expect(afterRestart.isUnlocked()).toBe(false); // cache empty until hydrated — correct, not yet a bug

    await afterRestart.hydrateSessionIfNeeded();
    expect(afterRestart.isUnlocked()).toBe(true);
    expect(afterRestart.getPublicWallet().accounts.solana.address).toBe(wallet.accounts.solana.address);
    expect(afterRestart.getPublicWallet().accounts.evm.address).toBe(wallet.accounts.evm.address);
  });

  it('hydrateSessionIfNeeded() is a no-op (no storage read) when the in-memory cache is already populated', async () => {
    installFakeChromeSessionStorage();
    vi.resetModules();
    const ws = await import('../walletService.js');
    await ws.createWallet('a-password'); // session cache already populated — no restart happened

    let getCallCount = 0;
    const originalGet = globalThis.chrome.storage.session.get;
    globalThis.chrome.storage.session.get = (key) => {
      getCallCount += 1;
      return originalGet(key);
    };

    await ws.hydrateSessionIfNeeded();
    expect(getCallCount).toBe(0);
    expect(ws.isUnlocked()).toBe(true);
  });

  it('two concurrent hydrateSessionIfNeeded() calls single-flight into exactly one chrome.storage.session read (no double-hydration race)', async () => {
    installFakeChromeSessionStorage();
    vi.resetModules();
    const beforeRestart = await import('../walletService.js');
    await beforeRestart.createWallet('a-password');

    vi.resetModules();
    const afterRestart = await import('../walletService.js');

    let getCallCount = 0;
    const originalGet = globalThis.chrome.storage.session.get;
    globalThis.chrome.storage.session.get = (key) => {
      getCallCount += 1;
      return originalGet(key);
    };

    // Two "messages" arriving back-to-back before the first hydration
    // resolves — exactly the scenario background.js's dispatcher must
    // never race on.
    await Promise.all([afterRestart.hydrateSessionIfNeeded(), afterRestart.hydrateSessionIfNeeded()]);

    expect(getCallCount).toBe(1);
    expect(afterRestart.isUnlocked()).toBe(true);
  });

  it('lock() removes the persisted session from chrome.storage.session, not just the in-memory cache', async () => {
    installFakeChromeSessionStorage();
    vi.resetModules();
    const beforeRestart = await import('../walletService.js');
    await beforeRestart.createWallet('a-password');
    await beforeRestart.lock();

    // A restart AFTER lock() must find nothing to hydrate — proves the
    // persisted copy was actually removed, not just the in-memory one
    // (an in-memory-only clear would be invisible to this fresh module
    // instance either way, so this specifically exercises the
    // storage-level removal).
    vi.resetModules();
    const afterRestart = await import('../walletService.js');
    await afterRestart.hydrateSessionIfNeeded();
    expect(afterRestart.isUnlocked()).toBe(false);
  });

  it('recordActivity()/getLastActivityAt() persist independently of the session blob and survive a simulated restart', async () => {
    installFakeChromeSessionStorage();
    vi.resetModules();
    const beforeRestart = await import('../walletService.js');
    expect(await beforeRestart.getLastActivityAt()).toBeNull();

    await beforeRestart.recordActivity();
    const recorded = await beforeRestart.getLastActivityAt();
    expect(typeof recorded).toBe('number');

    vi.resetModules();
    const afterRestart = await import('../walletService.js');
    expect(await afterRestart.getLastActivityAt()).toBe(recorded);
  });

  it('falls back to an in-memory Map (never localStorage/disk) when chrome.storage.session is unavailable — the plain-Node/vitest path every other test in this file already exercises', async () => {
    // Deliberately no installFakeChromeSessionStorage() call — this is
    // the no-chrome environment every OTHER test in this file already
    // runs under; asserted explicitly here as its own scenario.
    delete globalThis.chrome;
    vi.resetModules();
    const ws = await import('../walletService.js');
    await ws.createWallet('a-password');
    expect(ws.isUnlocked()).toBe(true);
    await ws.lock();
    expect(ws.isUnlocked()).toBe(false);
  });

  it('the in-memory Map fallback does not survive a simulated restart (unlike the real chrome.storage.session backend above) — expected, not a bug: a plain Node process never experiences an MV3 worker restart', async () => {
    delete globalThis.chrome;
    vi.resetModules();
    const beforeRestart = await import('../walletService.js');
    await beforeRestart.createWallet('a-password');

    vi.resetModules();
    const afterRestart = await import('../walletService.js');
    await afterRestart.hydrateSessionIfNeeded();
    expect(afterRestart.isUnlocked()).toBe(false);
  });
});

/**
 * "Forgot password?" full reset (prompt 0124) — this wallet's only
 * recovery path, since there is no password reset for a non-custodial
 * vault. Reuses the same installFakeChromeSessionStorage()/
 * vi.resetModules() pattern as the "session persistence" block above,
 * since proving the PERSISTED session copy (not just the in-memory
 * cache) was actually removed requires simulating a worker restart the
 * same way lock()'s own test does.
 */
describe('resetWallet — "Forgot password?" full reset (prompt 0124)', () => {
  afterEach(() => {
    delete globalThis.chrome;
  });

  it('erases the vault and the session — both the in-memory cache and the chrome.storage.session-persisted copy', async () => {
    installFakeChromeSessionStorage();
    vi.resetModules();
    const ws = await import('../walletService.js');
    await ws.createWallet('a-password');
    expect(await ws.hasWallet()).toBe(true);
    expect(ws.isUnlocked()).toBe(true);

    await ws.resetWallet();

    expect(await ws.hasWallet()).toBe(false);
    expect(ws.isUnlocked()).toBe(false);
    expect(ws.getPublicWallet()).toBeNull();

    // A "restart" afterward must find nothing to hydrate — proves the
    // persisted copy was genuinely removed, not just the in-memory cache
    // (an in-memory-only clear would be invisible to this fresh module
    // instance either way — same reasoning as lock()'s own test above).
    vi.resetModules();
    const afterRestart = await import('../walletService.js');
    await afterRestart.hydrateSessionIfNeeded();
    expect(afterRestart.isUnlocked()).toBe(false);
  });

  it('clears the persisted last-activity timestamp too, not just the session blob (lock() alone does not touch this)', async () => {
    installFakeChromeSessionStorage();
    vi.resetModules();
    const ws = await import('../walletService.js');
    await ws.createWallet('a-password');
    await ws.recordActivity();
    expect(await ws.getLastActivityAt()).not.toBeNull();

    await ws.resetWallet();
    expect(await ws.getLastActivityAt()).toBeNull();
  });

  it('is safe to call while already locked — this is the entire point of the feature (a forgotten password means the wallet is locked by definition)', async () => {
    installFakeChromeSessionStorage();
    vi.resetModules();
    const ws = await import('../walletService.js');
    await ws.createWallet('a-password');
    await ws.lock();
    expect(ws.isUnlocked()).toBe(false);

    await expect(ws.resetWallet()).resolves.toBeUndefined();
    expect(await ws.hasWallet()).toBe(false);
  });

  it('a subsequent importWallet() succeeds after reset — hasWallet() legitimately returns false, proving the fix works through the real guard rather than around it', async () => {
    installFakeChromeSessionStorage();
    vi.resetModules();
    const ws = await import('../walletService.js');
    await ws.createWallet('a-password');
    await ws.resetWallet();

    const REFERENCE_MNEMONIC =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const { wallet } = await ws.importWallet(REFERENCE_MNEMONIC, 'new-password');
    expect(wallet.accounts.evm.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  });

  it('falls back cleanly with no chrome.storage.session available (plain-Node/vitest path)', async () => {
    delete globalThis.chrome;
    vi.resetModules();
    const ws = await import('../walletService.js');
    await ws.createWallet('a-password');
    await expect(ws.resetWallet()).resolves.toBeUndefined();
    expect(await ws.hasWallet()).toBe(false);
  });
});
