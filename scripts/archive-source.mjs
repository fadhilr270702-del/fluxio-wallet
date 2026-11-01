/**
 * Source-archive builder (prompt 0207) — the ONLY sanctioned way to make
 * a source zip of this repo. `git archive HEAD` structurally cannot
 * include untracked or ignored files (backend/.env, apps/extension/
 * .env.local, dev databases, node_modules, apps/extension/release), which
 * is exactly what went wrong twice when a zip was made by tar-ing the
 * working folder instead (real incidents, 20 September 2026 the second).
 * The content check below is therefore a second belt, not the lock.
 *
 * Usage: node scripts/archive-source.mjs [--out=<path outside the repo>]
 *   (or `pnpm archive:source`). Default output:
 *   %TEMP%/fluxio-source-<short HEAD hash>.zip
 *
 * Behavior:
 *   - WARNS when `git status` is not clean — git archive HEAD snapshots
 *     the last COMMIT, never uncommitted changes.
 *   - REFUSES an --out that resolves to inside the repo (a source zip
 *     must never be committed or swept up by a later archive).
 *   - Lists the zip by reading its central directory DIRECTLY (pure
 *     Node — no tar/unzip dependency; the tar on a Git Bash PATH is GNU
 *     tar, which misreads "C:\..." as a remote host) and fails loudly if
 *     any entry matches a sensitive pattern.
 */
import { execFileSync } from 'node:child_process';
import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

const shortHash = git('rev-parse', '--short', 'HEAD').trim();
const status = git('status', '--short').trim();
if (status) {
  console.warn('[archive-source] PERINGATAN: git status tidak bersih — git archive HEAD hanya memuat commit terakhir, BUKAN perubahan yang belum di-commit:');
  console.warn(status.split('\n').map((l) => '  ' + l).join('\n'));
}

const outArg = process.argv.find((a) => a.startsWith('--out='));
const outPath = path.resolve(outArg ? outArg.slice('--out='.length) : path.join(os.tmpdir(), `fluxio-source-${shortHash}.zip`));
const rel = path.relative(REPO_ROOT, outPath);
if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
  console.error(`[archive-source] DITOLAK: --out berada di dalam repo (${outPath}). Zip sumber harus ditulis DI LUAR repo.`);
  process.exit(1);
}

git('archive', '--format=zip', '-o', outPath, 'HEAD');

/** Zip central-directory listing, pure Node: locate the End Of Central
 * Directory record (signature 0x06054b50, scanned backwards past any zip
 * comment), then walk the central directory's file headers
 * (signature 0x02014b50) and collect every entry name. */
function listZipEntries(zipPath) {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD zip tidak ditemukan — file bukan zip yang valid?');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`header central directory rusak pada offset ${off}`);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

const listing = listZipEntries(outPath);
const SENSITIVE = /(^|\/)\.env(\.|$)|\.db($|-shm$|-wal$)|(^|\/)node_modules\/|^\.git(\/|$)|(^|\/)backend\/(data|uploads)\//;
const RELEASE_DIR = /(^|\/)apps\/extension\/release(\/|$)/;
// Pengecualian SADAR (semuanya file yang memang dilacak HEAD dan aman):
// .env.example adalah pola rahasia repo ini (nilai kosong + komentar,
// sengaja di-commit — lihat CLAUDE.md "API keys / secrets"), dan
// backend/data|uploads hanya boleh memuat placeholder .gitkeep kosong
// (entri direktorinya sendiri ikut terdaftar oleh git archive).
const ALLOWED = /\.env\.example$|^backend\/(data|uploads)\/(\.gitkeep)?$/;
const violations = listing.filter((entry) => (SENSITIVE.test(entry) || RELEASE_DIR.test(entry)) && !ALLOWED.test(entry));
const allowedHits = listing.filter((entry) => (SENSITIVE.test(entry) || RELEASE_DIR.test(entry)) && ALLOWED.test(entry));

const sizeBytes = statSync(outPath).size;
console.log(`[archive-source] zip     : ${outPath}`);
console.log(`[archive-source] HEAD    : ${shortHash}`);
console.log(`[archive-source] entri   : ${listing.length}`);
console.log(`[archive-source] ukuran  : ${sizeBytes} byte (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`);
if (violations.length) {
  console.error(`[archive-source] GAGAL: ${violations.length} entri sensitif di dalam zip:`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
if (allowedHits.length) {
  console.log(`[archive-source] dikecualikan sadar (${allowedHits.length} entri aman yang memang dilacak HEAD):`);
  for (const a of allowedHits) console.log('  ' + a);
}
console.log('[archive-source] verifikasi: NOL entri .env / .env.local / .db / .db-shm / .db-wal / node_modules / .git / backend-data / backend-uploads / extension-release — LOLOS');
