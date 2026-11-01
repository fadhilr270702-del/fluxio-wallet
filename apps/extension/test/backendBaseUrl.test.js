/**
 * Unit tests for scripts/backendBaseUrl.mjs — the pure dev/release
 * backend-base-URL resolution build.mjs uses (prompt 0182). This is the
 * logic that decides what URL a Chrome Web Store zip bakes into
 * background.bundle.js, so the release-mode localhost guard here is a
 * real release-safety property, not a formality: a release bundle
 * pointing at a dev backend fails SILENTLY forever (the notifications
 * poller swallows network errors by design).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveBackendBaseUrl,
  DEV_DEFAULT_BACKEND_BASE_URL,
  RELEASE_DEFAULT_BACKEND_BASE_URL
} from '../scripts/backendBaseUrl.mjs';

describe('resolveBackendBaseUrl', () => {
  it('dev mode with no env value defaults to localhost:4000', () => {
    expect(resolveBackendBaseUrl({ release: false })).toBe('http://localhost:4000');
    expect(DEV_DEFAULT_BACKEND_BASE_URL).toBe('http://localhost:4000');
  });

  it('release mode with no env value defaults to the production API domain', () => {
    expect(resolveBackendBaseUrl({ release: true })).toBe('https://api.fluxiowallet.com');
    expect(RELEASE_DEFAULT_BACKEND_BASE_URL).toBe('https://api.fluxiowallet.com');
  });

  it('an empty or whitespace-only env value counts as unset in both modes', () => {
    expect(resolveBackendBaseUrl({ release: false, envValue: '' })).toBe(DEV_DEFAULT_BACKEND_BASE_URL);
    expect(resolveBackendBaseUrl({ release: false, envValue: '   ' })).toBe(DEV_DEFAULT_BACKEND_BASE_URL);
    expect(resolveBackendBaseUrl({ release: true, envValue: '' })).toBe(RELEASE_DEFAULT_BACKEND_BASE_URL);
  });

  it('an explicit env value wins in dev mode', () => {
    expect(resolveBackendBaseUrl({ release: false, envValue: 'https://staging.fluxiowallet.com' })).toBe(
      'https://staging.fluxiowallet.com'
    );
  });

  it('an explicit non-local env value wins in release mode', () => {
    expect(resolveBackendBaseUrl({ release: true, envValue: 'https://staging.fluxiowallet.com' })).toBe(
      'https://staging.fluxiowallet.com'
    );
  });

  it('release mode throws when the env value points at localhost, in any form', () => {
    expect(() => resolveBackendBaseUrl({ release: true, envValue: 'http://localhost:4000' })).toThrow(
      /release build refused/
    );
    expect(() => resolveBackendBaseUrl({ release: true, envValue: 'http://127.0.0.1:4000' })).toThrow(
      /release build refused/
    );
    expect(() => resolveBackendBaseUrl({ release: true, envValue: 'https://LOCALHOST:9999/x' })).toThrow(
      /release build refused/
    );
  });

  it('dev mode never throws for a localhost value — the guard is release-only', () => {
    expect(resolveBackendBaseUrl({ release: false, envValue: 'http://localhost:4000' })).toBe(
      'http://localhost:4000'
    );
    expect(resolveBackendBaseUrl({ release: false, envValue: 'http://127.0.0.1:4000' })).toBe(
      'http://127.0.0.1:4000'
    );
  });
});
