/**
 * Pure PNG header reader (prompt 0184) — reads width/height straight from
 * a PNG buffer's IHDR chunk, used by scripts/cws-assets.mjs to HARD-FAIL
 * when a generated Chrome Web Store asset isn't pixel-exact (CWS rejects
 * or letterboxes wrong-sized images, and "looks about right" isn't a
 * verification). Extracted as its own dependency-free module so the
 * parsing is directly unit-testable (test/pngDimensions.test.js) without
 * generating a real screenshot.
 *
 * PNG layout (per the PNG spec, RFC 2083 §3.1/§4.1.1): an 8-byte
 * signature (89 50 4E 47 0D 0A 1A 0A), then chunks; the first chunk MUST
 * be IHDR — 4-byte length (always 13), 4-byte type "IHDR", then width and
 * height as 4-byte big-endian unsigned integers at byte offsets 16 and 20.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * @param {Uint8Array} bytes - the PNG file's bytes (at least the first 24)
 * @returns {{ width: number, height: number }}
 * @throws when the buffer is not a PNG or its IHDR chunk is malformed
 */
export function readPngDimensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24) {
    throw new Error('Not a PNG: buffer is missing or shorter than the signature + IHDR header (24 bytes).');
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error('Not a PNG: signature mismatch.');
    }
  }
  // Bytes 12..15 must spell "IHDR" — the spec requires IHDR to be the
  // first chunk, so anything else means a corrupt/nonstandard file.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    throw new Error('Not a PNG: first chunk is not IHDR.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) {
    throw new Error(`Invalid PNG: IHDR declares a zero dimension (${width}x${height}).`);
  }
  return { width, height };
}
