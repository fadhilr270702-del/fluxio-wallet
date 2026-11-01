/**
 * Low-level password-based authenticated encryption primitives.
 *
 * Algorithm choices (do not change without updating VAULT format version —
 * see vault.js):
 *   - KDF: PBKDF2-HMAC-SHA256, 600,000 iterations (OWASP 2023 minimum
 *     recommendation for PBKDF2-SHA256) via the native Web Crypto API.
 *   - Cipher: AES-256-GCM (authenticated encryption) via the native Web
 *     Crypto API.
 *   - Salt: 16 random bytes, unique per encryption call.
 *   - IV: 12 random bytes (the standard AES-GCM nonce size), unique per
 *     encryption call.
 *
 * This module intentionally implements no cryptographic primitive itself —
 * every operation is delegated to `crypto.subtle` (Web Crypto), which is
 * available natively in browsers, browser extension service workers, and
 * modern Node.js (used here under Vitest). No third-party crypto library
 * is needed for this piece.
 *
 * NOTE ON PASSWORD-BASED KDF CHOICE: PBKDF2 is what the Web Crypto API
 * offers natively. Memory-hard KDFs like Argon2id are stronger against
 * dedicated cracking hardware, but the Web Crypto API does not implement
 * Argon2, and adding it would mean pulling in a WASM Argon2 build (e.g.
 * `argon2-browser` / `hash-wasm`) — a real option for a future vault
 * version, but out of scope for this phase. If/when that trade-off should
 * be made, it needs an explicit decision, not a silent substitution.
 */

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = 'SHA-256';
const AES_KEY_LENGTH = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12;

const subtle = getSubtleCrypto();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encrypt an arbitrary JSON-serializable value with a password.
 * @param {*} value
 * @param {string} password
 * @returns {Promise<{saltB64: string, ivB64: string, ciphertextB64: string, iterations: number, hash: string}>}
 */
export async function encryptWithPassword(value, password) {
  assertPassword(password);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS, PBKDF2_HASH);
  const plaintext = textEncoder.encode(JSON.stringify(value));

  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return {
    saltB64: bytesToBase64(salt),
    ivB64: bytesToBase64(iv),
    ciphertextB64: bytesToBase64(new Uint8Array(ciphertext)),
    iterations: PBKDF2_ITERATIONS,
    hash: PBKDF2_HASH
  };
}

/**
 * Decrypt a record produced by encryptWithPassword. Throws (does not
 * return null) on wrong password or corrupted/tampered ciphertext, because
 * AES-GCM's authentication tag check fails closed in `crypto.subtle`.
 * @returns {Promise<*>}
 */
export async function decryptWithPassword(record, password) {
  assertPassword(password);
  assertEncryptedRecord(record);

  const salt = base64ToBytes(record.saltB64);
  const iv = base64ToBytes(record.ivB64);
  const ciphertext = base64ToBytes(record.ciphertextB64);
  const key = await deriveAesKey(password, salt, record.iterations, record.hash);

  let plaintext;
  try {
    plaintext = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  } catch {
    throw new Error('Decryption failed: incorrect password or corrupted data.');
  }

  return JSON.parse(textDecoder.decode(plaintext));
}

async function deriveAesKey(password, salt, iterations, hash) {
  const baseKey = await subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, [
    'deriveKey'
  ]);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash },
    baseKey,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  getRandomSource().getRandomValues(bytes);
  return bytes;
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('A non-empty password/passphrase is required.');
  }
}

function assertEncryptedRecord(record) {
  const hasFields =
    record &&
    typeof record.saltB64 === 'string' &&
    typeof record.ivB64 === 'string' &&
    typeof record.ciphertextB64 === 'string' &&
    typeof record.iterations === 'number' &&
    typeof record.hash === 'string';
  if (!hasFields) {
    throw new Error('Malformed encrypted record.');
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

function base64ToBytes(base64) {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function getRandomSource() {
  const source = getGlobalCrypto();
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error('No secure random source (crypto.getRandomValues) available in this environment.');
  }
  return source;
}

function getSubtleCrypto() {
  const source = getGlobalCrypto();
  if (!source || !source.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not available in this environment.');
  }
  return source.subtle;
}

function getGlobalCrypto() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto) return globalThis.crypto;
  return undefined;
}
