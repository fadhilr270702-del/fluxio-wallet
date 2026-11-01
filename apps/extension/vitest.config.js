import { defineConfig } from 'vitest/config';

// Mirrors packages/crypto/vitest.config.js / packages/services/vitest.config.js
// exactly — 'node' environment (no jsdom/DOM needed: everything tested
// here is deliberately DOM/chrome-API-free pure logic extracted out of
// popup.js/background.js, see shared/swapAssetSources.js's own header
// comment for why). This is the first vitest config apps/extension has
// ever needed (prompt 0116) — nothing in this package had a test
// precedent before now.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js']
  }
});
