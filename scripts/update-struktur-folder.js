#!/usr/bin/env node
/**
 * Regenerates struktur folder/tree.txt and tree-utf8.txt from the actual
 * current repo layout. Same logic that used to live only as a copy-pasted
 * `node -e "..."` one-liner in struktur folder/README.md's "How to
 * regenerate" section — pulled out into a real script (`pnpm struktur:update`
 * from the repo root) so keeping the folder-tree docs current is one
 * command instead of a paste job.
 *
 * This only handles the mechanical tree dump. The prose sections of
 * struktur folder/README.md ("Real code lives in", the annotated
 * "Top-level shape" block) describe *what* a folder is for — that still
 * needs a human/Claude to update by hand when a folder's real-vs-scaffold
 * status actually changes, which a directory walk can't infer on its own.
 * This script will tell you when the tree itself has drifted either way.
 *
 * Prompt 0160 — rewritten to use git, not a hand-maintained exclusion
 * list, as the source of truth for what belongs in the tree. The original
 * version walked the raw filesystem and filtered against a hardcoded
 * `EXCLUDE_DIRS`/`EXCLUDE_FILE_PATTERNS` set that was never actually kept
 * in sync with `.gitignore` — commit 513b816 is the concrete proof: it
 * carried 1,392 lines of `backend/uploads/emoji-cache/`'s own local,
 * gitignored disk-cache filenames into the committed tree, because that
 * directory was never in the old hardcoded list. Every one of the OLD
 * script's own file-pattern exclusions (`.env*`, `*.db*`, `*.log`,
 * `background.bundle.js`, `*.tmp`/`*.temp`, OS junk files) turned out to
 * already be redundant with an equivalent `.gitignore` rule once checked
 * directly (see this prompt's own archive for the full audit) — so they
 * were dropped entirely rather than kept as a second, driftable copy of
 * the same rules. Same for every directory in the old `EXCLUDE_DIRS`
 * except `.git` itself, which `.gitignore` deliberately never needs to
 * (and structurally can't meaningfully) list — git already always treats
 * its own control directory specially, so this is the one exclusion that
 * genuinely isn't part of `.gitignore` and has to stay hardcoded.
 *
 * Two-source design (see this prompt's own archive for the full reasoning
 * on why NOT to build the tree from `git ls-files` alone, even though that
 * was the base prompt's own first suggestion): `git ls-files --cached
 * --others --exclude-standard` is authoritative for every FILE that should
 * appear — but git fundamentally has no concept of an empty directory, so
 * a genuinely empty, non-ignored scaffold folder (this repo has dozens —
 * see CLAUDE.md's own extensive "planned but empty" architecture) would
 * silently vanish from the tree if that were the only source, which is a
 * real, valuable, currently-working feature this rewrite was never asked
 * to remove. So a second, narrower pass finds candidate empty directories
 * via a real (but now genuinely ignore-aware) filesystem walk, and
 * `git check-ignore --stdin` — the same authority as the files pass, not a
 * second hand-written rule set — decides whether each candidate actually
 * belongs.
 */
const { readdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { join, relative, sep } = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildTreeLines } = require('./lib/buildTreeLines.js');

const REPO_ROOT = process.cwd();

/** `git ls-files`'s own output is always forward-slash, on every OS. */
function gitLsFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return out.split('\n').filter(Boolean);
}

/**
 * Every directory anywhere under the repo root, found via a real
 * filesystem walk — this is the ONLY thing in this script that still
 * touches the raw filesystem, and only for discovering directory
 * SHAPE (candidates for the "genuinely empty" pass below), never for
 * deciding what belongs in the tree; that decision is always git's.
 * `.git` is skipped outright (the one exclusion that isn't a `.gitignore`
 * rule at all — see this file's own header). `node_modules` is ALSO
 * skipped outright, but purely as a walk-performance shortcut, not a
 * correctness requirement: it's already a real `.gitignore` rule
 * (`node_modules/`), so `git check-ignore` would exclude it regardless —
 * skipping the walk just avoids recursing into what can be tens of
 * thousands of installed-package directories for no benefit, since
 * nothing under it could ever surface in the final tree either way.
 */
function findCandidateDirectories() {
  const dirs = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      const rel = relative(REPO_ROOT, full).split(sep).join('/');
      dirs.push(rel);
      walk(full);
    }
  }
  walk(REPO_ROOT);
  return dirs;
}

/**
 * Batched `git check-ignore` — one process for every candidate directory
 * instead of one per directory, both for speed and so this stays a single
 * clear "ask git" step rather than N of them. Returns the subset of
 * `paths` git considers ignored. `git check-ignore --stdin` exits 1 (not a
 * real error) whenever NONE of the fed paths match anything — only a
 * genuinely different failure should propagate.
 */
function gitCheckIgnoreBatch(paths) {
  if (paths.length === 0) return new Set();
  const input = `${paths.join('\n')}\n`;
  let out;
  try {
    out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: REPO_ROOT,
      input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    });
  } catch (err) {
    if (err.status === 1) {
      out = err.stdout || '';
    } else {
      throw err;
    }
  }
  return new Set(out.split('\n').filter(Boolean));
}

const filePaths = gitLsFiles();
const candidateDirs = findCandidateDirectories();
const ignoredDirs = gitCheckIgnoreBatch(candidateDirs);
const emptyDirPaths = candidateDirs.filter((d) => !ignoredDirs.has(d));

const lines = buildTreeLines(filePaths, emptyDirPaths, 'fluxio/');
const output = `${lines.join('\n')}\n`;

const utf8Path = 'struktur folder/tree-utf8.txt';
const plainPath = 'struktur folder/tree.txt';
const previous = existsSync(utf8Path) ? readFileSync(utf8Path, 'utf8') : null;
const changed = previous !== output;

writeFileSync(utf8Path, output);
writeFileSync(plainPath, output);

if (changed) {
  console.log('struktur folder/tree.txt + tree-utf8.txt updated — folder/file layout had drifted.');
  console.log(
    'If any TOP-LEVEL or mid-level folder was added/removed/moved (not just files inside an ' +
      'already-documented folder), also update the "Real code lives in" and "Top-level shape" ' +
      'sections of struktur folder/README.md by hand — this script only regenerates the raw tree.'
  );
} else {
  console.log('struktur folder/tree.txt + tree-utf8.txt already current — no change.');
}
