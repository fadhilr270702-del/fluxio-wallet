/**
 * Minimal migration runner: reads numbered `.sql` files from ./migrations,
 * applies any not yet recorded in `_migrations`, in filename order, each
 * inside its own transaction. No framework dependency — for two or three
 * tables this is more reviewable than pulling in a migration library, and
 * every file here is plain, readable SQL a future contributor can run by
 * hand if they ever need to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './client.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function runMigrations() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map((row) => row.name));
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const recordApplied = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    // Opt-in escape hatch: a migration that starts with this marker manages
    // its own transaction (or deliberately runs in autocommit mode) instead
    // of being wrapped in the default BEGIN/COMMIT below. This exists for
    // migrations that need `PRAGMA foreign_keys=OFF` to actually take
    // effect — that pragma is a documented no-op while a transaction is
    // open, which the default wrapping below always does. Such a file is
    // responsible for its own BEGIN/COMMIT/ROLLBACK (or runs fully
    // autocommit) inside its own SQL text.
    if (sql.startsWith('-- fluxio:manual-transaction')) {
      db.exec(sql);
      recordApplied.run(file, new Date().toISOString());
      console.log(`[migrate] applied ${file} (manual transaction)`);
      continue;
    }

    // node:sqlite's DatabaseSync has no db.transaction(fn) helper (unlike
    // better-sqlite3) — BEGIN/COMMIT/ROLLBACK by hand instead.
    db.exec('BEGIN');
    try {
      db.exec(sql);
      recordApplied.run(file, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    console.log(`[migrate] applied ${file}`);
  }
}
