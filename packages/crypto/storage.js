/**
 * Vault storage adapter.
 *
 * Persists ONLY encrypted vault records — never raw secrets. This module
 * structurally refuses to store anything that isn't shaped like a vault
 * (see isVault() in vault.js), so it's not possible to accidentally
 * persist a plaintext mnemonic/private key through this path.
 *
 * Auto-selects a backend so the same API works in both apps:
 *   - apps/extension (MV3 service worker, no `window`/`localStorage`):
 *     `chrome.storage.local` (async, extension-scoped, not readable by
 *     web pages).
 *   - apps/web (browser main thread): `localStorage`, wrapped to expose
 *     the same async API.
 *
 * A storage key is namespaced so multiple vaults (e.g. multi-wallet in a
 * future phase) don't collide.
 */
import { isVault } from './vault.js';

const DEFAULT_KEY = 'fluxio.vault.v1';

export async function saveVault(vault, key = DEFAULT_KEY) {
  if (!isVault(vault)) {
    throw new Error('storage.saveVault refused: value is not a valid encrypted vault record.');
  }
  return backend().set(key, vault);
}

export function loadVault(key = DEFAULT_KEY) {
  return backend().get(key);
}

export function clearVault(key = DEFAULT_KEY) {
  return backend().remove(key);
}

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
