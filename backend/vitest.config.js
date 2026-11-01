import { defineConfig } from 'vitest/config';

// Prompt 0167 — this backend had no vitest config at all before now (every
// other setting stays at Vitest's own real defaults: pool 'threads',
// isolate true — deliberately not touched here, see prompt/0167's own
// investigation for why those specific defaults are what actually let the
// dev-DB-touching flake happen, and why fixing the underlying import chain
// was the right fix rather than tuning pool/isolate settings around it).
// setupFiles is the one thing this config exists for: unconditionally
// isolating every test file's own DATABASE_PATH before that file's imports
// run — see test/setupDatabasePath.js's own header for the full reasoning.
export default defineConfig({
  test: {
    setupFiles: ['./test/setupDatabasePath.js']
  }
});
