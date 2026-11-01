/**
 * Session tokens: a random secret handed to the browser (in the cookie),
 * of which only the SHA-256 hash is ever persisted server-side. A database
 * read/leak alone can't be replayed as a valid session — you'd need the
 * original random bytes, which only ever existed in the cookie.
 */
import { randomBytes, createHash } from 'node:crypto';

export function generateSessionToken() {
  return randomBytes(32).toString('hex');
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
