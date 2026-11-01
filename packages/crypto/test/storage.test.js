import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createVault } from '../vault.js';
import { saveVault, loadVault, clearVault } from '../storage.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function installFakeLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  return store;
}

describe('storage.saveVault / loadVault / clearVault (localStorage backend)', () => {
  beforeEach(() => installFakeLocalStorage());
  afterEach(() => {
    delete globalThis.localStorage;
  });

  it('round-trips a real vault record', async () => {
    const vault = await createVault(MNEMONIC, 'a-password');
    await saveVault(vault);
    const loaded = await loadVault();
    expect(loaded).toEqual(vault);
  });

  it('returns null when nothing has been saved', async () => {
    expect(await loadVault()).toBeNull();
  });

  it('clearVault removes the persisted vault', async () => {
    const vault = await createVault(MNEMONIC, 'a-password');
    await saveVault(vault);
    await clearVault();
    expect(await loadVault()).toBeNull();
  });

  it('refuses to persist a bare mnemonic string as if it were a vault', async () => {
    await expect(saveVault(MNEMONIC)).rejects.toThrow();
  });

  it('refuses to persist an object without vault shape (e.g. raw private key material)', async () => {
    await expect(saveVault({ privateKey: '0xdeadbeef' })).rejects.toThrow();
  });

  it('never writes the plaintext mnemonic into localStorage', async () => {
    const store = installFakeLocalStorage();
    const vault = await createVault(MNEMONIC, 'a-password');
    await saveVault(vault);
    const raw = [...store.values()].join('\n');
    expect(raw).not.toContain('abandon');
  });
});

describe('storage.saveVault / loadVault (chrome.storage.local backend)', () => {
  beforeEach(() => {
    const store = new Map();
    globalThis.chrome = {
      storage: {
        local: {
          set: async (obj) => {
            for (const [k, v] of Object.entries(obj)) store.set(k, v);
          },
          get: async (key) => ({ [key]: store.has(key) ? store.get(key) : undefined }),
          remove: async (key) => store.delete(key)
        }
      }
    };
  });
  afterEach(() => {
    delete globalThis.chrome;
  });

  it('prefers chrome.storage.local when available and round-trips a vault', async () => {
    const vault = await createVault(MNEMONIC, 'a-password');
    await saveVault(vault);
    const loaded = await loadVault();
    expect(loaded).toEqual(vault);
  });
});
