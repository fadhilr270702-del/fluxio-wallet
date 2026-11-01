/**
 * Unit tests for scripts/pngDimensions.mjs (prompt 0184) — the pure PNG
 * IHDR reader scripts/cws-assets.mjs uses to hard-verify that every
 * generated Chrome Web Store asset is pixel-exact. Tested against both a
 * real committed PNG (the extension's own 128x128 store icon — a fixture
 * that can never drift, CWS itself requires exactly 128x128 there) and
 * hand-built synthetic buffers for the error paths.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPngDimensions } from '../scripts/pngDimensions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Builds the first 24 bytes of a PNG: signature + IHDR length/type + width/height (big-endian). */
function pngHeader({ width, height, signatureByte0 = 0x89, chunkType = 'IHDR' }) {
  const bytes = new Uint8Array(24);
  bytes.set([signatureByte0, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(bytes.buffer).setUint32(8, 13, false); // IHDR data length
  for (let i = 0; i < 4; i++) bytes[12 + i] = chunkType.charCodeAt(i);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

describe('readPngDimensions', () => {
  it('reads the real committed 128x128 extension icon correctly', () => {
    const bytes = readFileSync(path.join(__dirname, '..', 'icons', 'icon128.png'));
    expect(readPngDimensions(new Uint8Array(bytes))).toEqual({ width: 128, height: 128 });
  });

  it('reads a synthetic header (1280x800, the CWS screenshot size)', () => {
    expect(readPngDimensions(pngHeader({ width: 1280, height: 800 }))).toEqual({ width: 1280, height: 800 });
  });

  it('reads dimensions above 65535 correctly (true 32-bit big-endian, not 16-bit)', () => {
    expect(readPngDimensions(pngHeader({ width: 70000, height: 3 }))).toEqual({ width: 70000, height: 3 });
  });

  it('throws on a signature mismatch', () => {
    expect(() => readPngDimensions(pngHeader({ width: 10, height: 10, signatureByte0: 0x88 }))).toThrow(
      /signature mismatch/
    );
  });

  it('throws when the first chunk is not IHDR', () => {
    expect(() => readPngDimensions(pngHeader({ width: 10, height: 10, chunkType: 'IDAT' }))).toThrow(
      /not IHDR/
    );
  });

  it('throws on a truncated buffer and on non-buffer input', () => {
    expect(() => readPngDimensions(new Uint8Array(10))).toThrow(/shorter than/);
    expect(() => readPngDimensions(null)).toThrow(/missing or shorter/);
  });

  it('throws when IHDR declares a zero dimension', () => {
    expect(() => readPngDimensions(pngHeader({ width: 0, height: 800 }))).toThrow(/zero dimension/);
  });
});
