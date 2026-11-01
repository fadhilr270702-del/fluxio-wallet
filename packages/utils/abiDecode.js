/**
 * Minimal, dependency-free decoders for the two Solidity ABI return
 * shapes @fluxio/services/tokenService.js's ERC-20 metadata auto-fetch
 * needs (symbol()/name() return `string`, decimals() returns `uint8`) —
 * built here specifically so this parsing is testable in isolation
 * rather than inline/untested inside background.js (the lesson from the
 * "one malformed value crashes the whole thing" bug this repo already
 * hit once with BigInt('0x') — see tokenService.js's own comments).
 *
 * Not a general-purpose ABI decoder: only the two shapes above are
 * supported. In particular, a handful of older/non-standard ERC-20s
 * (famously MKR) return `bytes32` instead of `string` for symbol()/
 * name() — decodeAbiString does not attempt to detect or handle that
 * variant. An explicit, documented scope cut, not an oversight.
 */

/**
 * Decodes a Solidity `string` return value from an eth_call result (the
 * standard dynamic-type ABI encoding: a 32-byte offset word, then at that
 * offset a 32-byte length word, then that many bytes of UTF-8 data,
 * right-padded to a 32-byte boundary).
 *
 * Deliberately defensive rather than throwing on anything unexpected: a
 * caller here is decoding a response from an arbitrary contract a user
 * pointed at, which may not actually implement the standard shape at
 * all. Any structural problem (too short, offset/length pointing past
 * the available data, ...) resolves to `null` — "could not decode a
 * string from this," not an error — so one bad field never has to crash
 * the metadata fetch it's part of.
 *
 * @param {string} hex - a "0x..." eth_call result.
 * @returns {string|null}
 */
export function decodeAbiString(hex) {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) return null;
  const data = hex.slice(2);
  if (data.length < 64) return null; // not even a full offset word

  const offsetWords = readUint(data, 0);
  if (offsetWords === null) return null;
  const offsetHexChars = Number(offsetWords) * 2;
  if (!Number.isSafeInteger(offsetHexChars) || offsetHexChars < 0 || offsetHexChars > data.length) return null;

  const length = readUint(data, offsetHexChars);
  if (length === null) return null;
  const lengthHexChars = Number(length) * 2;
  if (!Number.isSafeInteger(lengthHexChars) || lengthHexChars < 0) return null;

  const stringStart = offsetHexChars + 64;
  if (stringStart > data.length) return null;
  // Clamp the end to whatever is actually there — a malicious/malformed
  // contract could claim a length far beyond the data it actually
  // returned; reading only what exists (rather than trusting the claimed
  // length) is the defensive choice here, not a strict-spec one.
  const stringEnd = Math.min(stringStart + lengthHexChars, data.length);
  const stringHex = data.slice(stringStart, stringEnd);

  const bytes = hexToBytes(stringHex);
  if (bytes === null) return null;
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decodes a Solidity `uint8`/`uint256`/any right-aligned unsigned integer
 * return value from an eth_call result — a single 32-byte word,
 * big-endian, left-padded with zeros (this is how decimals() and any
 * other single-uint return is ABI-encoded, regardless of the uint's
 * declared bit width).
 *
 * @param {string} hex - a "0x..." eth_call result.
 * @returns {bigint|null}
 */
export function decodeAbiUint(hex) {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) return null;
  const data = hex.slice(2);
  if (data.length < 64) return null;
  return readUint(data, 0);
}

/** Reads one 32-byte (64 hex char) word starting at `startChar` as a BigInt, or null if there isn't a full word there. */
function readUint(data, startChar) {
  const word = data.slice(startChar, startChar + 64);
  if (word.length < 64) return null;
  try {
    return BigInt(`0x${word}`);
  } catch {
    return null;
  }
}

/** Parses a hex string (no "0x" prefix, even length) into bytes, or null if it isn't valid/even-length hex. */
function hexToBytes(hex) {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
