/**
 * Best-effort overwrite of sensitive byte buffers before dropping the
 * reference. JS strings are immutable and can't be wiped this way — keep
 * secrets as Uint8Array where possible for anything long-lived, and treat
 * string secrets (mnemonics) as short-lived and eligible for GC instead.
 */
export function secureWipe(bytes) {
  if (bytes instanceof Uint8Array) {
    bytes.fill(0);
  }
  return bytes;
}
