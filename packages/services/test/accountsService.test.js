import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as accountsService from '../accountsService.js';

/** Same fake-localStorage pattern walletService.test.js already uses for its own storage-backed tests — accountsService.js falls back to localStorage when chrome.storage.local isn't available (see its own backend() selection), so this is the real fallback path, not a special test-only stub. */
function installFakeLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
}

beforeEach(() => {
  installFakeLocalStorage();
});

afterEach(() => {
  delete globalThis.localStorage;
});

describe('getAccountsState', () => {
  it('self-initializes to a single "Account 1" at index 0 on first read', async () => {
    const state = await accountsService.getAccountsState();
    expect(state).toEqual({ accounts: [{ index: 0, name: 'Account 1' }], activeIndex: 0 });
  });

  it('persists the self-initialized default so a second read sees the same state', async () => {
    const first = await accountsService.getAccountsState();
    const second = await accountsService.getAccountsState();
    expect(second).toEqual(first);
  });
});

describe('addAccountEntry', () => {
  it('appends a new contiguous index with an auto-generated "Account N" name', async () => {
    const entry = await accountsService.addAccountEntry();
    expect(entry).toEqual({ index: 1, name: 'Account 2' });

    const state = await accountsService.getAccountsState();
    expect(state.accounts).toEqual([
      { index: 0, name: 'Account 1' },
      { index: 1, name: 'Account 2' }
    ]);
  });

  it('keeps indices contiguous across multiple additions', async () => {
    await accountsService.addAccountEntry();
    const third = await accountsService.addAccountEntry();
    expect(third).toEqual({ index: 2, name: 'Account 3' });
  });

  it('does not change the active index', async () => {
    await accountsService.setActiveAccountEntry(0);
    await accountsService.addAccountEntry();
    const state = await accountsService.getAccountsState();
    expect(state.activeIndex).toBe(0);
  });
});

describe('renameAccountEntry', () => {
  it('renames an existing account', async () => {
    const result = await accountsService.renameAccountEntry(0, 'My main wallet');
    expect(result).toEqual({ index: 0, name: 'My main wallet' });

    const state = await accountsService.getAccountsState();
    expect(state.accounts[0].name).toBe('My main wallet');
  });

  it('trims surrounding whitespace', async () => {
    const result = await accountsService.renameAccountEntry(0, '  Trimmed  ');
    expect(result.name).toBe('Trimmed');
  });

  it('rejects an empty name', async () => {
    await expect(accountsService.renameAccountEntry(0, '')).rejects.toThrow(/empty/);
    await expect(accountsService.renameAccountEntry(0, '   ')).rejects.toThrow(/empty/);
  });

  it('rejects a name longer than 32 characters', async () => {
    await expect(accountsService.renameAccountEntry(0, 'x'.repeat(33))).rejects.toThrow(/32 characters/);
  });

  it('accepts a name at exactly the 32-character limit', async () => {
    const result = await accountsService.renameAccountEntry(0, 'x'.repeat(32));
    expect(result.name).toBe('x'.repeat(32));
  });

  it('rejects an unknown account index', async () => {
    await expect(accountsService.renameAccountEntry(5, 'Ghost account')).rejects.toThrow(/Unknown account index/);
  });

  it('leaves other accounts untouched', async () => {
    await accountsService.addAccountEntry();
    await accountsService.renameAccountEntry(0, 'Renamed');
    const state = await accountsService.getAccountsState();
    expect(state.accounts[1]).toEqual({ index: 1, name: 'Account 2' });
  });
});

describe('setActiveAccountEntry', () => {
  it('persists the active index', async () => {
    await accountsService.addAccountEntry();
    await accountsService.setActiveAccountEntry(1);
    const state = await accountsService.getAccountsState();
    expect(state.activeIndex).toBe(1);
  });

  it('rejects switching to an unknown account index', async () => {
    await expect(accountsService.setActiveAccountEntry(7)).rejects.toThrow(/Unknown account index/);
  });

  it('does not modify the account list itself', async () => {
    await accountsService.addAccountEntry();
    await accountsService.setActiveAccountEntry(1);
    const state = await accountsService.getAccountsState();
    expect(state.accounts).toEqual([
      { index: 0, name: 'Account 1' },
      { index: 1, name: 'Account 2' }
    ]);
  });
});

describe('resetAccountsState — full wallet reset support (prompt 0124)', () => {
  it('erases the stored state entirely — a fresh getAccountsState() read after reset self-initializes exactly like a brand-new install', async () => {
    await accountsService.addAccountEntry();
    await accountsService.renameAccountEntry(0, 'My main wallet');
    await accountsService.setActiveAccountEntry(1);

    await accountsService.resetAccountsState();

    const state = await accountsService.getAccountsState();
    expect(state).toEqual({ accounts: [{ index: 0, name: 'Account 1' }], activeIndex: 0 });
  });
});
