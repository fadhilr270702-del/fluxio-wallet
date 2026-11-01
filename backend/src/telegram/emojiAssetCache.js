/**
 * Prompt 0152 — a zero-cost local disk cache for the emoji-asset proxy,
 * keyed by Telegram's own `file_unique_id` (per the base prompt's own
 * instruction) rather than a synthetic key: it's already the stable,
 * content-addressed identifier Telegram itself guarantees stays the same
 * "over time" for a given file, so it's exactly the right cache key with
 * no extra bookkeeping.
 *
 * Reuses `backend/uploads/` (see welcome.js's UPLOADS_DIR) — already
 * gitignored via the root `.gitignore`'s `backend/uploads/*` rule, which
 * (being a bare `*`, not `**`) already covers this new `emoji-cache/`
 * subdirectory too; confirmed with `git check-ignore -v` rather than
 * assumed, per this repo's standing rule on touching .gitignore. A new
 * subdirectory rather than dropping files straight into `uploads/` keeps
 * this cache trivially distinguishable (and separately clearable) from
 * broadcast/welcome media, which are genuine user uploads, not a
 * regenerable cache.
 *
 * Two files per cached asset — `<key>.data` (the exact bytes the proxy
 * controller will send) and `<key>.meta` (a one-line Content-Type) —
 * rather than a DB row, since this is pure disk cache with no need to ever
 * be queried, joined, or migrated the way a real table's contents would.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UPLOADS_DIR } from './welcome.js';

export const EMOJI_ASSET_CACHE_DIR = path.join(UPLOADS_DIR, 'emoji-cache');

// file_unique_id is Telegram-authored (base64url-ish) and already safe as
// a filename in practice, but this is defense in depth against ever
// building a path from an unexpected character — never trust it blindly
// just because it happens to come from Telegram.
function safeCacheKey(fileUniqueId) {
  return String(fileUniqueId).replace(/[^A-Za-z0-9_-]/g, '_');
}

function cachePaths(fileUniqueId) {
  const base = path.join(EMOJI_ASSET_CACHE_DIR, safeCacheKey(fileUniqueId));
  return { dataPath: `${base}.data`, metaPath: `${base}.meta` };
}

/** Returns `{ data: Buffer, contentType: string }`, or `null` on a cache miss. */
export function readCachedEmojiAsset(fileUniqueId) {
  const { dataPath, metaPath } = cachePaths(fileUniqueId);
  if (!existsSync(dataPath) || !existsSync(metaPath)) return null;
  try {
    return { data: readFileSync(dataPath), contentType: readFileSync(metaPath, 'utf8').trim() };
  } catch {
    // A racing write, a half-written file from a crashed prior process,
    // or any other read failure — treat exactly like a miss, never throw:
    // the caller always has the real Telegram fetch as a fallback.
    return null;
  }
}

/** `data` is whatever the proxy will actually send to the client — already gunzipped for a TGS "file" request, raw bytes otherwise (see the controller). */
export function writeCachedEmojiAsset(fileUniqueId, data, contentType) {
  mkdirSync(EMOJI_ASSET_CACHE_DIR, { recursive: true });
  const { dataPath, metaPath } = cachePaths(fileUniqueId);
  writeFileSync(dataPath, data);
  writeFileSync(metaPath, contentType, 'utf8');
}
