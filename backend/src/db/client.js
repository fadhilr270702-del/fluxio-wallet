/**
 * Single shared SQLite connection, via Node's built-in `node:sqlite`
 * (`DatabaseSync`) rather than the `better-sqlite3` package.
 *
 * This is a deliberate deviation from the original plan, made during
 * implementation: `better-sqlite3` ships no prebuilt binary for every
 * Node/platform combination and falls back to compiling from source via
 * node-gyp, which needs Python + a C++ toolchain installed. On a plain dev
 * machine without those, `pnpm install` fails outright. `node:sqlite`
 * ships with Node itself (stable since Node 22.5, used here on Node 24) —
 * zero native build step, zero extra dependency — and its API
 * (`db.prepare(sql).get/all/run(params)`, `?`/`@name` placeholders, the
 * `{changes, lastInsertRowid}` run() result) is close enough to
 * better-sqlite3's that the rest of this codebase (repositories, migration
 * runner) needed only trivial changes. It's still officially
 * "experimental" in the Node docs — logs one warning on startup — but is
 * synchronous, file-backed, real SQLite underneath, same as
 * better-sqlite3 would have been.
 *
 * Prompt 0167 — the connection used to open at module *import* time (a
 * top-level `export const db = new DatabaseSync(...)`), which meant simply
 * importing anything that transitively reached this file — including a
 * handful of backend tests that only wanted an unrelated zod schema from a
 * route file — opened a real connection to the real dev database
 * (`config.databasePath`, `./data/fluxio-admin.db` with no override) and
 * ran `PRAGMA journal_mode = WAL` on it as a pure side effect of importing
 * a module, before any test had a chance to set its own DATABASE_PATH.
 * Under Vitest's default parallel file execution, two or more of those
 * tests opening/WAL-ing the SAME real file at overlapping instants
 * produced real, intermittent "disk I/O error"/"database is locked"
 * failures — confirmed by direct reproduction (see prompt/0167's own
 * archive: 14/60 failures across 15 rounds of 4 concurrent `node:sqlite`
 * connections independently opening the same file). `getDb()` below fixes
 * the *class* of bug, not just the symptom: the connection now opens lazily
 * on first actual use, so a module that only wants a schema or a pure
 * function never touches a database at all, no matter what it imports.
 * Runtime behavior for the real server is unchanged — `getDb()` still
 * returns the exact same singleton connection on every call after the
 * first, and the PRAGMAs still run exactly once, right before that first
 * real use, not once per call.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';

let dbInstance = null;

/**
 * Returns the one shared DatabaseSync connection, opening it (and running
 * its one-time PRAGMA setup) on the first call only. Every subsequent call
 * — from this process's very first real query through to the process
 * exiting — returns the exact same connection object; nothing here ever
 * opens a second one.
 */
export function getDb() {
  if (!dbInstance) {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    dbInstance = new DatabaseSync(config.databasePath);
    // Enforce FK constraints (SQLite has them off by default) so e.g.
    // deleting an admin cascades to their sessions instead of leaving
    // orphaned rows.
    dbInstance.exec('PRAGMA foreign_keys = ON');
    // Write-Ahead Logging: better concurrent read/write behavior for a
    // long-lived server process versus SQLite's default rollback journal.
    dbInstance.exec('PRAGMA journal_mode = WAL');
  }
  return dbInstance;
}

/**
 * Wraps db.prepare(sql) so the actual prepare happens on first *call*
 * instead of at module-load time. This matters because of import ordering:
 * repositories are imported (transitively, via app.js's routes/controllers)
 * before server.js's own top-level runMigrations() call runs — ES module
 * imports always finish executing before the importing module's body does.
 * A `const stmt = getDb().prepare(...)` at a repository's top level would
 * therefore run against a database that doesn't have its tables yet on a
 * fresh install. Preparing lazily, on first actual use, guarantees
 * migrations have already applied by then — and, as of prompt 0167, also
 * guarantees the connection itself was never opened any earlier than that
 * same first real use either.
 */
export function lazyStatement(sql) {
  let stmt = null;
  return () => stmt ?? (stmt = getDb().prepare(sql));
}
