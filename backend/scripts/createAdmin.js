#!/usr/bin/env node
/**
 * Creates the first (or an additional) admin account. This is the ONLY way
 * an admin account gets created in this slice — there's no self-serve
 * signup endpoint, and no credentials are ever hardcoded in source.
 *
 * Usage:
 *   node scripts/createAdmin.js --email=you@example.com --password=... [--role=superadmin|editor]
 *
 * Runs migrations first so this works even against a brand-new,
 * never-started database.
 */
import { runMigrations } from '../src/db/migrate.js';
import { findAdminByEmail, createAdmin, toPublicAdmin } from '../src/db/repositories/adminsRepo.js';
import { hashPassword } from '../src/utils/password.js';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email?.trim();
  const password = args.password;
  const role = args.role === 'editor' ? 'editor' : 'superadmin';

  if (!email || !password) {
    console.error('Usage: node scripts/createAdmin.js --email=you@example.com --password=... [--role=superadmin|editor]');
    process.exitCode = 1;
    return;
  }
  if (password.length < 8) {
    console.error('Refusing to create an admin with a password shorter than 8 characters.');
    process.exitCode = 1;
    return;
  }

  runMigrations();

  if (findAdminByEmail(email)) {
    console.error(`An admin with email "${email}" already exists.`);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);
  const admin = createAdmin({ email, passwordHash, role });
  console.log('Created admin:', toPublicAdmin(admin));
}

main();
