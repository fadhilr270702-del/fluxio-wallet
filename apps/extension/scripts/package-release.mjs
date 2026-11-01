/**
 * Builds the Chrome Web Store release zip (prompt 0182).
 *
 * Run via `pnpm package:extension` (root) / `pnpm --filter
 * fluxio-extension package`. Steps, in order:
 *
 *   1. Runs a RELEASE build (`node build.mjs --release` — production
 *      backend base URL default, no sourcemap, hard-fails on a localhost
 *      base URL; see build.mjs / scripts/backendBaseUrl.mjs).
 *   2. Collects exactly the files a real installed extension needs —
 *      manifest.json at the zip ROOT, the built background bundle, and
 *      every unbundled page/script/style/asset directory — while
 *      excluding everything dev-only (see INCLUDE/EXCLUDED_* below).
 *   3. Cross-checks the collected set against manifest.json itself:
 *      every path the manifest references (service worker, popup, icons,
 *      content scripts, web-accessible provider files) MUST be present,
 *      or the script fails before writing anything.
 *   4. Sanity-checks the built bundle's baked-in backend base URL (the
 *      resolved release URL must appear; the dev `localhost:4000` must
 *      not). Note: `127.0.0.1:8899`/`:8545` DO legitimately remain in
 *      the bundle — those are @fluxio/constants' solana-local/
 *      ethereum-local network RPC entries (a shipped feature, hidden
 *      behind the popup's Developer-networks toggle), nothing to do with
 *      the backend base URL this script guards.
 *   5. Writes apps/extension/release/fluxio-wallet-<manifest version>.zip
 *      (release/ is gitignored — a build artifact, never committed).
 *
 * The zip itself is written by a minimal ZIP implementation below (local
 * file headers + central directory + EOCD, deflate via node:zlib,
 * hand-rolled CRC-32) — deliberately pure Node with zero new
 * dependencies, and deliberately NOT PowerShell's Compress-Archive:
 * that would be Windows-only AND Windows PowerShell 5.1's
 * Compress-Archive is known to write backslash path separators into zip
 * entry names, which non-Windows extractors treat as literal filename
 * characters. Entry names here always use forward slashes, per the ZIP
 * spec (APPNOTE 4.4.17.1).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { resolveBackendBaseUrl, DEV_DEFAULT_BACKEND_BASE_URL } from './backendBaseUrl.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Release build
// ---------------------------------------------------------------------------
console.log('[package:extension] running release build (node build.mjs --release)...');
const buildResult = spawnSync(process.execPath, [path.join(EXT_ROOT, 'build.mjs'), '--release'], {
  stdio: 'inherit',
  cwd: EXT_ROOT
});
if (buildResult.status !== 0) {
  console.error('[package:extension] release build failed — no zip written.');
  process.exit(buildResult.status ?? 1);
}

// ---------------------------------------------------------------------------
// 2. Collect files
// ---------------------------------------------------------------------------
/**
 * What goes in, stated positively (everything not listed is excluded by
 * construction — node_modules/, test/, scripts/, release/, build.mjs,
 * package.json, vitest.config.js, .env* never get walked at all):
 * - manifest.json — the one root-level file, at the zip ROOT.
 * - background/background.bundle.js — the built service worker, alone:
 *   never its background.js/polyfills.js sources, never the .map.
 * - Every unbundled runtime directory, whole: the four pages (popup/,
 *   onboarding/, settings/, approval/ — the latter three are opened via
 *   chrome.tabs.create/chrome.windows.create rather than referenced in
 *   manifest.json, so a manifest-only file list would silently break
 *   them), content-script/, provider/, shared/ (page-imported ES modules
 *   + theme.css), icons/, assets/. Whole-directory inclusion is a
 *   deliberate superset: a future shared/ module missed by a hand list
 *   would ship a broken page, while the one background-only rider
 *   (shared/portfolioValue.js, ~12KB, also inlined in the bundle) is
 *   merely dead weight.
 */
const INCLUDE = [
  { file: 'manifest.json' },
  { file: 'background/background.bundle.js' },
  { dir: 'approval' },
  { dir: 'assets' },
  { dir: 'content-script' },
  { dir: 'icons' },
  { dir: 'onboarding' },
  { dir: 'popup' },
  { dir: 'provider' },
  { dir: 'settings' },
  { dir: 'shared' }
];

/** Defensive per-file veto even inside included dirs — nothing matching these may ever reach the zip. */
const EXCLUDED_FILE_RE = /(\.map$|\.test\.js$|^\.env|[\\/]\.env)/i;

/** @returns {string[]} repo-relative forward-slash paths of every file under dirRel, recursively */
function walkDir(dirRel) {
  const out = [];
  for (const entry of readdirSync(path.join(EXT_ROOT, dirRel), { withFileTypes: true })) {
    const rel = `${dirRel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkDir(rel));
    else out.push(rel);
  }
  return out;
}

const files = [];
for (const item of INCLUDE) {
  if (item.file) {
    if (!existsSync(path.join(EXT_ROOT, item.file))) {
      console.error(`[package:extension] missing required file: ${item.file}`);
      process.exit(1);
    }
    files.push(item.file);
  } else {
    files.push(...walkDir(item.dir));
  }
}
const filtered = files.filter((f) => !EXCLUDED_FILE_RE.test(f));
const fileSet = new Set(filtered);

// ---------------------------------------------------------------------------
// 3. Manifest cross-check — every path manifest.json references must be
//    in the zip. Parsed from the real manifest, not a hand-kept list.
// ---------------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(path.join(EXT_ROOT, 'manifest.json'), 'utf8'));
const manifestRefs = new Set();
if (manifest.background?.service_worker) manifestRefs.add(manifest.background.service_worker);
if (manifest.action?.default_popup) manifestRefs.add(manifest.action.default_popup);
for (const iconPath of Object.values(manifest.action?.default_icon ?? {})) manifestRefs.add(iconPath);
for (const iconPath of Object.values(manifest.icons ?? {})) manifestRefs.add(iconPath);
for (const cs of manifest.content_scripts ?? []) for (const js of cs.js ?? []) manifestRefs.add(js);
for (const war of manifest.web_accessible_resources ?? []) for (const res of war.resources ?? []) manifestRefs.add(res);

const missingRefs = [...manifestRefs].filter((ref) => !fileSet.has(ref));
if (missingRefs.length > 0) {
  console.error(`[package:extension] manifest references files missing from the zip: ${missingRefs.join(', ')}`);
  process.exit(1);
}
console.log(`[package:extension] manifest cross-check: ${manifestRefs.size}/${manifestRefs.size} refs found`);

// ---------------------------------------------------------------------------
// 4. Bundle base-URL sanity check
// ---------------------------------------------------------------------------
// Mirror build.mjs's own env loading so the expected URL matches what the
// build just baked in (an explicit FLUXIO_BACKEND_BASE_URL wins there too).
const envLocalPath = path.join(EXT_ROOT, '.env.local');
if (existsSync(envLocalPath)) {
  process.loadEnvFile(envLocalPath);
}
const expectedBaseUrl = resolveBackendBaseUrl({
  release: true,
  envValue: process.env.FLUXIO_BACKEND_BASE_URL
});
const bundleText = readFileSync(path.join(EXT_ROOT, 'background', 'background.bundle.js'), 'utf8');
if (!bundleText.includes(expectedBaseUrl)) {
  console.error(`[package:extension] built bundle does not contain the expected backend base URL "${expectedBaseUrl}" — stale bundle?`);
  process.exit(1);
}
if (bundleText.includes(DEV_DEFAULT_BACKEND_BASE_URL.replace(/^https?:\/\//, ''))) {
  console.error(`[package:extension] built bundle still contains the dev backend URL (${DEV_DEFAULT_BACKEND_BASE_URL}) — refusing to package.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 5. Write the zip
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/** @param {{ name: string, data: Buffer }[]} entries — names MUST use forward slashes */
function buildZip(entries) {
  const now = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Store uncompressed when deflate doesn't actually help (already-compressed PNGs).
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra/comment/disk/internal/external attrs all zero (30..41)
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuf, payload);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

const sortedFiles = [...fileSet].sort();
const zipBuf = buildZip(
  sortedFiles.map((rel) => ({
    name: rel,
    data: readFileSync(path.join(EXT_ROOT, rel))
  }))
);

const releaseDir = path.join(EXT_ROOT, 'release');
mkdirSync(releaseDir, { recursive: true });
const zipPath = path.join(releaseDir, `fluxio-wallet-${manifest.version}.zip`);
writeFileSync(zipPath, zipBuf);

console.log(`[package:extension] wrote ${zipPath}`);
console.log(`[package:extension] ${sortedFiles.length} files, ${(zipBuf.length / 1024).toFixed(1)} KB`);
console.log(`[package:extension] backend base URL baked in: ${expectedBaseUrl}`);
console.log('[package:extension] entries:');
for (const rel of sortedFiles) console.log(`  ${rel}`);
