/**
 * Pure resolution of the notifications-inbox backend base URL for
 * build.mjs (prompt 0182) — extracted into its own dependency-free module
 * specifically so the release/dev defaulting and the release-mode
 * localhost guard are directly unit-testable from Vitest
 * (test/backendBaseUrl.test.js) without executing an esbuild build.
 *
 * Rules (see build.mjs's own header for the surrounding mechanism):
 * - An explicit FLUXIO_BACKEND_BASE_URL env value always wins, in both
 *   modes (whitespace-only counts as unset).
 * - No env value: dev mode defaults to the local `pnpm dev:backend`
 *   origin; release mode defaults to the live production API domain
 *   (https://api.fluxiowallet.com — real since prompt 0178's deploy).
 * - Release mode fails HARD if the final resolved value still points at
 *   localhost/127.0.0.1 in any form — a release zip that silently ships
 *   a dev backend URL would be a broken-notifications release with no
 *   visible error at all (network failures are deliberately silent, see
 *   background.js's fetchAndMergeNotifications), so this must never
 *   survive to a build artifact.
 */

export const DEV_DEFAULT_BACKEND_BASE_URL = 'http://localhost:4000';
export const RELEASE_DEFAULT_BACKEND_BASE_URL = 'https://api.fluxiowallet.com';

/** Matches localhost/127.0.0.1 (any port, any scheme) anywhere in the URL — the guard is about the final resolved value, not about how it was arrived at. */
const LOCAL_URL_RE = /localhost|127\.0\.0\.1/i;

/**
 * @param {{ release?: boolean, envValue?: string | undefined }} opts
 * @returns {string} the base URL to bake into the bundle
 * @throws in release mode when the resolved URL is a localhost one
 */
export function resolveBackendBaseUrl({ release = false, envValue } = {}) {
  const explicit = typeof envValue === 'string' ? envValue.trim() : '';
  const resolved =
    explicit || (release ? RELEASE_DEFAULT_BACKEND_BASE_URL : DEV_DEFAULT_BACKEND_BASE_URL);

  if (release && LOCAL_URL_RE.test(resolved)) {
    throw new Error(
      `[build:extension] release build refused: FLUXIO_BACKEND_BASE_URL resolved to "${resolved}", ` +
        'which points at localhost/127.0.0.1. A release bundle must never target a dev backend — ' +
        'unset FLUXIO_BACKEND_BASE_URL (the release default is ' +
        `${RELEASE_DEFAULT_BACKEND_BASE_URL}) or set it to a real deployed origin.`
    );
  }

  return resolved;
}
