/**
 * Password hashing — bcryptjs (pure JS, no native build step). Login is
 * infrequent, so bcryptjs's JS-only performance cost doesn't matter in
 * practice, and pairing it with node:sqlite (see db/client.js) means this
 * backend has zero native/compiled dependencies end to end.
 */
import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, config.bcryptCost);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
