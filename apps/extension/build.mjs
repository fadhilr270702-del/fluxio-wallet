/**
 * Bundles the background service worker only.
 *
 * Why a bundler exists at all here (the rest of the extension stays
 * unbundled, plain JS, per the project's existing "no build step"
 * architecture — see CLAUDE.md):
 *
 * background.js is the one place in the extension that needs the real
 * wallet crypto stack (@fluxio/crypto -> bip39 / ed25519-hd-key /
 * tweetnacl / bs58 / ethers). Those are npm packages with their own
 * internal module graphs; browsers can't resolve bare `import` specifiers
 * like `import "bip39"` without either an import map or a bundle. MV3
 * service workers don't support import maps, so bundling is the
 * standard approach every extension wallet uses for this.
 *
 * content-script/inject.js and provider/*.js are deliberately left
 * untouched by this build — they never handle key material (see
 * background.js's message-boundary comments), so keeping them as plain,
 * individually-auditable files is itself a security property worth
 * preserving.
 *
 * STANDING LESSON (found the hard way — see prompt/0117-auto-lock-timer.md's
 * Revision 3): background/background.bundle.js, not background.js's own
 * source, is what a real Chrome service worker actually loads. Editing
 * ANY file background.js imports — shared/autoLockDecision.js, or
 * anything under @fluxio/* — silently leaves the PREVIOUSLY BUILT bundle
 * stale until the next run of this script, even when background.js's own
 * source text doesn't change at all. "background.js's source doesn't
 * need editing" is NOT the same question as "does the deployed bundle
 * need rebuilding" — checking only the former (e.g. via grep against
 * background.js) can silently miss a real behavioral regression in what
 * Chrome actually runs. Rebuild (`pnpm build:extension`) after ANY change
 * to a file this bundle transitively includes, not just changes to
 * background.js itself.
 *
 * HELIUS_API_KEY injection (prompt 0130): loaded from .env.local (this
 * directory, gitignored via the repo's existing `.env`/`.env.*` rule —
 * see .env.example for the committed placeholder + setup instructions),
 * never from a source file. esbuild's `define` does a literal TEXT
 * substitution at build time — every occurrence of the identifier
 * __FLUXIO_HELIUS_API_KEY__ ANYWHERE in this bundle's whole dependency
 * graph is replaced with the key as a JSON-stringified string literal
 * (or `""` when no key is configured) before bundling, so the built
 * background.bundle.js never contains a `process.env` lookup or any
 * reference to this build script — just a plain string baked in.
 *
 * The one actual reference to this identifier lives in
 * @fluxio/constants/networks.js (see that file's own header comment for
 * why, Revision 1) — NOT in background.js's own source. It was
 * originally wired directly into background.js, which turned out to be
 * completely inert: @fluxio/services' own functions look up their
 * network config from @fluxio/constants directly, never from whatever
 * background.js computed locally, so that first version never actually
 * changed which RPC endpoint got called. esbuild's `define` isn't scoped
 * to any one file, though — it substitutes the identifier across the
 * ENTIRE bundled source graph, which is exactly what makes injecting at
 * the shared-constants level (the one place every consumer reads from)
 * work correctly through this same build step with no change needed here.
 *
 * This does NOT make the key secret at runtime: a real Chrome extension
 * is entirely client-side, so anyone who unpacks the installed .crx can
 * read that literal string straight out of the bundle, same as any other
 * client-side API key in any browser extension. What this DOES prevent is
 * the key ever reaching the GitHub repo itself — see CLAUDE.md's own
 * permanent rule on this. No key configured is a fully supported, silent
 * default (see the console.log below) — the network config falls back to
 * the existing public/free Solana RPC endpoint exactly as before this
 * prompt, so a contributor without a Helius key can still build normally.
 *
 * FLUXIO_BACKEND_BASE_URL injection (prompt 0170): the exact same
 * define-at-build-time mechanism as above, one more identifier
 * (__FLUXIO_BACKEND_BASE_URL__) substituted the same way, read by
 * background.js's own notifications-inbox poller (see that file's own
 * header comment on this feature). Not a secret — a plain public API
 * origin. See .env.example's own comment on this variable.
 *
 * Release mode (prompt 0182): `node build.mjs --release` (same plain-flag
 * convention as the existing --watch). Three differences from dev, and
 * only three: the FLUXIO_BACKEND_BASE_URL default becomes the live
 * production API (https://api.fluxiowallet.com) instead of
 * localhost:4000 — an explicit env value still wins in both modes;
 * sourcemaps are turned off (a CWS zip has no use for a 4MB .map, and
 * the packager excludes it anyway — belt and braces); and the build
 * FAILS HARD if the final resolved base URL still contains
 * localhost/127.0.0.1, because a release bundle pointing at a dev
 * backend would fail silently forever (network errors in the
 * notifications poller are deliberately invisible). The resolution +
 * guard logic lives in scripts/backendBaseUrl.mjs, a pure module with
 * its own Vitest coverage (test/backendBaseUrl.test.js). Dev mode is
 * byte-for-byte unchanged by all of this. Packaging a CWS zip on top of
 * a release build is scripts/package-release.mjs's job, not this file's.
 */
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { resolveBackendBaseUrl } from './scripts/backendBaseUrl.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const watch = process.argv.includes('--watch');
const release = process.argv.includes('--release');

const envLocalPath = path.join(__dirname, '.env.local');
if (existsSync(envLocalPath)) {
  process.loadEnvFile(envLocalPath);
}
const heliusApiKey = process.env.HELIUS_API_KEY || '';
if (heliusApiKey) {
  console.log('[build:extension] HELIUS_API_KEY found — bundling with Helius as the Solana mainnet RPC default.');
} else {
  console.log(
    '[build:extension] HELIUS_API_KEY not set (apps/extension/.env.local missing or empty) — ' +
      'bundling with the existing public Solana RPC endpoints only. See apps/extension/.env.example.'
  );
}

// Prompt 0170 — the notifications inbox's backend base URL. Same
// define-at-build-time mechanism as HELIUS_API_KEY above, and same
// .env.local file. Prompt 0182: dev/release defaulting + the
// release-mode localhost hard-fail live in scripts/backendBaseUrl.mjs
// (throws before any build starts when a release build would bake in a
// localhost URL).
const backendBaseUrl = resolveBackendBaseUrl({
  release,
  envValue: process.env.FLUXIO_BACKEND_BASE_URL
});
console.log(
  `[build:extension] mode=${release ? 'release' : 'dev'} FLUXIO_BACKEND_BASE_URL=${backendBaseUrl}` +
    `${process.env.FLUXIO_BACKEND_BASE_URL ? '' : ' (default — FLUXIO_BACKEND_BASE_URL unset)'}`
);

const options = {
  entryPoints: [path.join(__dirname, 'background', 'background.js')],
  outfile: path.join(__dirname, 'background', 'background.bundle.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  // Release builds ship no sourcemap (see the header) — dev keeps one.
  sourcemap: !release,
  minify: true,
  logLevel: 'info',
  // Polyfills the Node `Buffer` global that `bip39` expects — MV3 service
  // workers don't have one natively. See background/polyfills.js.
  inject: [path.join(__dirname, 'background', 'polyfills.js')],
  define: {
    __FLUXIO_HELIUS_API_KEY__: JSON.stringify(heliusApiKey),
    __FLUXIO_BACKEND_BASE_URL__: JSON.stringify(backendBaseUrl)
  }
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching background/background.js for changes...');
} else {
  await build(options);
}
