import { describe, it, expect } from 'vitest';
import { isValidServerMediaFilename, mediaTypeForServerFilename, needsMediaResolution } from '../broadcastMedia.js';

// Prompt 0141 (Stage C) — pure logic only; the actual resolution/upload
// path (ensureBroadcastMediaFileId) is inherently I/O (a DB cache read,
// and sometimes a real Telegram upload) and is verified live instead, the
// same "I/O-heavy, no unit coverage, verified live" precedent prompt 0140
// established for the send paths it touched.

describe('isValidServerMediaFilename', () => {
  it('accepts a real UUID-based filename this module itself could have produced', () => {
    expect(isValidServerMediaFilename('broadcast-media-a1b2c3d4-1234-5678-9abc-def012345678.jpg')).toBe(true);
    expect(isValidServerMediaFilename('broadcast-media-a1b2c3d4-1234-5678-9abc-def012345678.png')).toBe(true);
    expect(isValidServerMediaFilename('broadcast-media-a1b2c3d4-1234-5678-9abc-def012345678.webp')).toBe(true);
    expect(isValidServerMediaFilename('broadcast-media-a1b2c3d4-1234-5678-9abc-def012345678.mp4')).toBe(true);
  });

  it('rejects a welcome-style filename — bot-scoped shapes are a different pattern entirely', () => {
    expect(isValidServerMediaFilename('welcome-media-test-a1b2c3d4-1234-5678-9abc-def012345678.jpg')).toBe(false);
  });

  it('rejects a path-traversal attempt outright — never resolved into a filesystem path unchecked', () => {
    expect(isValidServerMediaFilename('../../etc/passwd')).toBe(false);
    expect(isValidServerMediaFilename('broadcast-media-../../a1b2c3d4-1234-5678-9abc-def012345678.jpg')).toBe(false);
  });

  it('rejects a non-string/empty/malformed value', () => {
    expect(isValidServerMediaFilename('')).toBe(false);
    expect(isValidServerMediaFilename(null)).toBe(false);
    expect(isValidServerMediaFilename(undefined)).toBe(false);
    expect(isValidServerMediaFilename('broadcast-media-not-a-uuid.jpg')).toBe(false);
  });

  it('rejects an unsupported extension', () => {
    expect(isValidServerMediaFilename('broadcast-media-a1b2c3d4-1234-5678-9abc-def012345678.gif')).toBe(false);
    expect(isValidServerMediaFilename('broadcast-media-a1b2c3d4-1234-5678-9abc-def012345678.exe')).toBe(false);
  });
});

describe('mediaTypeForServerFilename', () => {
  it('derives image for jpg/jpeg/png/webp', () => {
    expect(mediaTypeForServerFilename('broadcast-media-x.jpg')).toBe('image');
    expect(mediaTypeForServerFilename('broadcast-media-x.jpeg')).toBe('image');
    expect(mediaTypeForServerFilename('broadcast-media-x.png')).toBe('image');
    expect(mediaTypeForServerFilename('broadcast-media-x.webp')).toBe('image');
  });

  it('derives video for mp4', () => {
    expect(mediaTypeForServerFilename('broadcast-media-x.mp4')).toBe('video');
  });

  it('returns null for an unrecognized or missing extension', () => {
    expect(mediaTypeForServerFilename('broadcast-media-x.gif')).toBeNull();
    expect(mediaTypeForServerFilename('')).toBeNull();
    expect(mediaTypeForServerFilename(null)).toBeNull();
  });
});

describe('needsMediaResolution', () => {
  it('is false once this bot already has its own media_file_id — the common case, nothing to do', () => {
    expect(needsMediaResolution({ media_file_id: 'file-abc', media_server_filename: 'broadcast-media-x.jpg' })).toBe(false);
  });

  it('is false when there is no server file at all — nothing this mechanism can resolve', () => {
    expect(needsMediaResolution({ media_file_id: null, media_server_filename: null })).toBe(false);
  });

  it('is true only for the real gap: a server file exists but this bot has never resolved a file_id for it', () => {
    expect(needsMediaResolution({ media_file_id: null, media_server_filename: 'broadcast-media-x.jpg' })).toBe(true);
  });

  it('is false for a legacy row with a real file_id but no server file — resolution needs a server file to work from', () => {
    expect(needsMediaResolution({ media_file_id: 'file-abc', media_server_filename: null })).toBe(false);
  });
});
